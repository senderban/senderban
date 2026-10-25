import { parseAddress } from "../address.js";
import { unlimited } from "../gate.js";
import type { Gate } from "../gate.js";

// Scale budget (per account, one device): 1 persistent IMAP connection; while idle only the library's
// keepalive (about 12 DONE/NOOP/IDLE cycles per hour, derived from imapflow's 300 s socketTimeout, wire count
// not measured); 1 FETCH of new envelopes per `exists` event. Linear in accounts only (MAX_ACCOUNTS = 50 in the
// engine => 50 sockets worst case). Reconnects are bounded by backoff: at the cap, 12-24 attempts/hour/account
// (equal jitter over 150-300 s). Logins go through `options.gate`, so start, resume and unpause open at most
// MAX_CONCURRENT_LOGINS connections at once instead of one per account.

export const SUBJECT_MAX = 200;
/** Toasts per drain. A burst (offline weekend, spam run) must not become a toast flood. */
export const DEFAULT_MAX_PER_DRAIN = 5;
/**
 * A login that has not finished by now frees its slot (a login takes about 2 s). The attempt itself is not
 * cancelled: it ends by the library's own timeouts and its late session is closed, so a hung login can keep
 * a socket open after the gate has let the next one in.
 */
export const CONNECT_SLOT_MS = 60_000;
export const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 300_000, stableMs: 30_000 } as const;

export interface IncomingMessage {
  readonly uid: number;
  /** Validated, lowercased `local@domain` (the matching key). Never the display name. */
  readonly from: string;
  /** Control and bidi characters removed, at most SUBJECT_MAX UTF-16 units. Display only. */
  readonly subject: string;
}

export interface MailboxSession {
  readonly uidValidity: string;
  readonly uidNext: number;
  /** Messages with uid > `uid`, ascending. IMAP `n:*` returns the last message even when n is past it; callers must not trust the range. */
  fetchSince(uid: number): Promise<IncomingMessage[]>;
  onExists(listener: () => void): void;
  /** Called once when the connection is gone, with the cause when there is one. */
  onClose(listener: (cause: Error | null) => void): void;
  close(): Promise<void>;
}

export interface Cursor {
  readonly uidValidity: string;
  readonly lastUid: number;
}

export interface CursorStore {
  get(accountId: string): Cursor | undefined;
  set(accountId: string, cursor: Cursor): void;
}

/** Retrying cannot help (wrong password, account locked): hammering it risks a lockout. */
export class FatalWatchError extends Error {
  override readonly name = "FatalWatchError";
}

export type WatcherState = "stopped" | "connecting" | "watching" | "backoff" | "halted";

export interface WatcherOptions {
  readonly accountId: string;
  /** `signal` aborts when the login passes its slot deadline: the connector must then drop its socket. */
  readonly connect: (signal?: AbortSignal) => Promise<MailboxSession>;
  /** Shared by every watcher of the device; bounds simultaneous logins. Unlimited when absent. */
  readonly gate?: Gate;
  readonly cursors: CursorStore;
  readonly onMessage: (accountId: string, message: IncomingMessage) => void;
  /** More new messages than `maxPerDrain`: the older `skipped` ones were not announced. */
  readonly onOverflow?: (accountId: string, skipped: number) => void;
  readonly onState?: (accountId: string, state: WatcherState, detail?: string) => void;
  readonly maxPerDrain?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number; readonly stableMs: number };
  /** Injectable for tests; returns [0, 1). */
  readonly random?: () => number;
}

// \p{Cc} = C0 controls, DEL and C1 controls; the rest are the invisible bidi marks and overrides.
const CONTROL_AND_BIDI = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Header text is hostile: it is shown in a system toast, so strip what can spoof or break it. */
export function sanitizeSubject(raw: string): string {
  return raw.replace(CONTROL_AND_BIDI, " ").replace(/\s+/gu, " ").trim().slice(0, SUBJECT_MAX);
}

/** Envelope fields -> IncomingMessage, or null when the sender is not an address we can match. */
export function toIncoming(
  uid: number,
  fromAddress: string | undefined,
  subject: string | undefined,
): IncomingMessage | null {
  if (fromAddress === undefined) return null;
  const parsed = parseAddress(fromAddress);
  if (!parsed.ok) return null;
  return { uid, from: parsed.value.address, subject: sanitizeSubject(subject ?? "") };
}

async function closeQuietly(session: MailboxSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // The socket is already unusable; nothing to repair.
  }
}

/**
 * One account's INBOX watcher: connect, announce mail newer than the persisted cursor, wait for
 * `exists`, reconnect with capped exponential backoff. The IMAP library is behind `MailboxSession`
 * so this logic is tested without a network.
 */
export class AccountWatcher {
  private readonly backoff;
  private readonly maxPerDrain: number;
  private readonly random: () => number;
  private state: WatcherState = "stopped";
  /** Bumped on every connect, stop and failure; a callback from an older epoch is ignored. */
  private epoch = 0;
  private session: MailboxSession | null = null;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch whose drain is running; -1 when none. A stale drain never blocks a newer connection. */
  private drainEpoch = -1;
  private drainAgain = false;

  constructor(private readonly options: WatcherOptions) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.maxPerDrain = options.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN;
    this.random = options.random ?? Math.random;
  }

  get current(): WatcherState {
    return this.state;
  }

  start(): void {
    if (this.state !== "stopped" && this.state !== "halted") return;
    this.failures = 0;
    void this.connectOnce();
  }

  async stop(): Promise<void> {
    this.epoch += 1;
    this.clearTimers();
    const session = this.session;
    this.session = null;
    this.setState("stopped");
    if (session !== null) await closeQuietly(session);
  }

  /** After system resume (a sleeping socket is dead but not yet reported) or when settings change. */
  reconnectNow(): void {
    if (this.state === "stopped") return;
    this.epoch += 1;
    this.clearTimers();
    const session = this.session;
    this.session = null;
    if (session !== null) void closeQuietly(session);
    this.failures = 0;
    void this.connectOnce();
  }

  private setState(state: WatcherState, detail?: string): void {
    this.state = state;
    this.options.onState?.(this.options.accountId, state, detail);
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.retryTimer = null;
    this.stableTimer = null;
    this.drainAgain = false;
  }

  private async connectOnce(): Promise<void> {
    this.epoch += 1;
    const epoch = this.epoch;
    this.setState("connecting");

    let session: MailboxSession | null;
    try {
      session = await this.connectThroughGate(epoch);
    } catch (error) {
      this.fail(epoch, error);
      return;
    }
    // Stopped or replaced while it waited for a slot: nothing was opened.
    if (session === null) return;
    if (epoch !== this.epoch) {
      await closeQuietly(session);
      return;
    }

    this.session = session;
    session.onClose((cause) => {
      this.fail(epoch, cause ?? new Error("connection closed"));
    });
    session.onExists(() => {
      void this.drain(epoch, session);
    });

    await this.drain(epoch, session);
    if (epoch !== this.epoch) return;

    this.setState("watching");
    // A connection that dies right after opening must keep growing the delay, not reset it.
    this.stableTimer = setTimeout(() => {
      this.failures = 0;
    }, this.backoff.stableMs);
  }

  /** Waits for a login slot, then connects with a deadline so one stuck login cannot hold a slot for good. */
  private connectThroughGate(epoch: number): Promise<MailboxSession | null> {
    const gate = this.options.gate ?? unlimited;
    return gate(async () => {
      if (epoch !== this.epoch) return null;
      const controller = new AbortController();
      const attempt = this.options.connect(controller.signal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`login did not finish within ${String(CONNECT_SLOT_MS)} ms`);
          // The slot is freed now, so the socket must be too (or 50 stalled logins hold 50 sockets).
          controller.abort(error);
          reject(error);
        }, CONNECT_SLOT_MS);
      });
      try {
        return await Promise.race([attempt, deadline]);
      } catch (error) {
        // A login that finishes after its deadline would leak a socket: close it when it does.
        void attempt.then(closeQuietly, () => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private async drain(epoch: number, session: MailboxSession): Promise<void> {
    if (epoch !== this.epoch) return;
    if (this.drainEpoch === epoch) {
      this.drainAgain = true;
      return;
    }
    this.drainEpoch = epoch;
    try {
      do {
        this.drainAgain = false;
        await this.drainOnce(epoch, session);
      } while (this.drainRequested() && epoch === this.epoch);
    } catch (error) {
      if (this.drainEpoch === epoch) this.drainEpoch = -1;
      this.fail(epoch, error);
      return;
    }
    if (this.drainEpoch === epoch) this.drainEpoch = -1;
  }

  /** A method, so the compiler does not assume the flag is still false after an await. */
  private drainRequested(): boolean {
    return this.drainAgain;
  }

  private async drainOnce(epoch: number, session: MailboxSession): Promise<void> {
    const { accountId, cursors } = this.options;
    const cursor = cursors.get(accountId);
    if (cursor === undefined || cursor.uidValidity !== session.uidValidity) {
      // First run, or the server renumbered the mailbox: mail already there is not "new".
      cursors.set(accountId, { uidValidity: session.uidValidity, lastUid: session.uidNext - 1 });
      return;
    }

    const fresh = (await session.fetchSince(cursor.lastUid))
      .filter((m) => m.uid > cursor.lastUid)
      .sort((a, b) => a.uid - b.uid);
    // The watcher was stopped or replaced while the fetch ran: its result belongs to nobody.
    if (epoch !== this.epoch || fresh.length === 0) return;

    const skipped = Math.max(0, fresh.length - this.maxPerDrain);
    for (const [index, message] of fresh.entries()) {
      if (index >= skipped) {
        try {
          this.options.onMessage(accountId, message);
        } catch {
          // A consumer bug must not wedge the cursor on one message.
        }
      }
      cursors.set(accountId, { uidValidity: session.uidValidity, lastUid: message.uid });
    }
    if (skipped > 0) this.options.onOverflow?.(accountId, skipped);
  }

  private fail(epoch: number, error: unknown): void {
    if (epoch !== this.epoch) return;
    this.epoch += 1;
    this.clearTimers();
    const session = this.session;
    this.session = null;
    if (session !== null) void closeQuietly(session);

    const message = (error instanceof Error ? error.message : "unknown error").slice(0, 300);
    if (error instanceof FatalWatchError) {
      this.setState("halted", message);
      return;
    }

    this.failures += 1;
    const ceiling = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (this.failures - 1));
    // Equal jitter: half fixed, half random, so 50 accounts do not reconnect in lockstep after a network blip.
    const delay = Math.round(ceiling / 2 + (ceiling / 2) * this.random());
    this.setState("backoff", message);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectOnce();
    }, delay);
  }
}
