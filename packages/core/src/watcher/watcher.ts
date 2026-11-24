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
/**
 * Characters of a raw subject that are looked at, at most. Cleaning runs on the main process, and a sender picks the length; 8x
 * the kept length leaves room for the padding a cleaned subject loses.
 */
export const SUBJECT_SCAN_MAX = SUBJECT_MAX * 8;
/**
 * Unit: SpamAssassin points. MXroute adds `X-Spam-Score: 1.6 (+)` (seen on a real message, 2026-10-25);
 * typical scores run -15..+50, so a value outside this range is not trusted and shown as "no score".
 */
export const SPAM_SCORE = { min: -100, max: 100 } as const;
/** Bytes of the header block parsed for the score: one header line, so anything longer is not ours. */
export const SPAM_HEADER_MAX_BYTES = 512;
/** Toasts per drain. A burst (offline weekend, spam run) must not become a toast flood. */
export const DEFAULT_MAX_PER_DRAIN = 5;
/**
 * A login that has not finished by now frees its slot (a login takes about 2 s). The attempt itself is not
 * cancelled: it ends by the library's own timeouts and its late session is closed, so a hung login can keep
 * a socket open after the gate has let the next one in.
 */
export const CONNECT_SLOT_MS = 60_000;
export const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 300_000, stableMs: 30_000 } as const;
/** Messages fetched per `exists`. More than this in one gap means a burst; the watcher announces few anyway. */
export const FETCH_LIMIT = 200;

export type GapReason = "burst" | "unreadable" | "renumbered";

export interface IncomingMessage {
  readonly uid: number;
  /** Validated, lowercased `local@domain` (the matching key). Never the display name. */
  readonly from: string;
  /** Control and bidi characters removed, at most SUBJECT_MAX UTF-16 units. Display only. */
  readonly subject: string;
  /** The server's own spam score, or null when it sent none or one outside SPAM_SCORE. Display only. */
  readonly spamScore: number | null;
  /**
   * When the server took the mail (IMAP INTERNALDATE), or null when it sent none we can use. Unit: epoch milliseconds. A move between
   * folders keeps it, so it tells a new mail from an old one that came back to the Inbox.
   */
  readonly deliveredAt: number | null;
}

/** A mail whose From is not an address we can match: announced, with nothing to click. */
export interface UnreadableSender {
  readonly uid: number;
  readonly from: null;
  readonly subject: string;
}

export type IncomingRow = IncomingMessage | UnreadableSender;

/**
 * Mails of one account the Recent mail view shows, at most (Ali, 2026-11-23: ten per account, all accounts in one list). Unit:
 * messages.
 */
export const RECENT_MAX = 10;

/**
 * After a Recent read ran into a mail too large to read (the connection closed on it), the read is not tried again until the cursor
 * moved this many UIDs, or RECENT_TOO_LARGE_MS has passed. Unit: UIDs. Ten new mails that stay push the large one out of the newest
 * ten; mail the cleaning lane moved also uses UIDs, so the gate can open early: then one more try, one reconnect, and it closes
 * again. Each try costs a reconnect, a new login.
 */
export const RECENT_TOO_LARGE_MAILS = RECENT_MAX;
/** The other way out of the wait above. Unit: milliseconds. Two tries an hour at most for a mail that never ages out. */
export const RECENT_TOO_LARGE_MS = 30 * 60_000;

/** A mail among the newest is too large to read: the Recent mail view says so instead of "could not be read". */
export class RecentTooLargeError extends Error {
  override readonly name = "RecentTooLargeError";
}

/** One of the newest mails of the Inbox, for the Recent mail view. Read when the view opens, kept in memory only. */
export interface RecentRow {
  readonly uid: number;
  /** As `IncomingMessage.from`, or null when the sender cannot be matched: shown with nothing to click. */
  readonly from: string | null;
  readonly subject: string;
  /** IMAP INTERNALDATE, as `IncomingMessage.deliveredAt`. Unit: epoch milliseconds. */
  readonly deliveredAt: number | null;
}

export interface MailboxSession {
  readonly uidValidity: string;
  readonly uidNext: number;
  /**
   * The newest `count` mails of the Inbox, newest first, on this connection (no second login). Absent on a session that cannot.
   * `signal` aborting closes the connection: a FETCH that hangs would otherwise hold every later command of it. Throws
   * RecentTooLargeError when a size limit ended the connection.
   */
  recent?(count: number, signal?: AbortSignal): Promise<RecentRow[]>;
  /** Messages with uid > `uid`, ascending. IMAP `n:*` returns the last message even when n is past it; callers must not trust the range. */
  /** The newest rows after `uid`, oldest first. A row with no usable From counts towards FETCH_LIMIT too. */
  fetchSince(uid: number): Promise<IncomingRow[]>;
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

/**
 * A mail the client cannot read: its answer ran past a size limit, which ends the connection. A reconnect would fetch the same
 * mail and fail the same way for good, so the watcher steps past it instead (see `skipUnreadable`).
 */
export class UnreadableMailError extends Error {
  override readonly name = "UnreadableMailError";
}

/** Retrying cannot help (wrong password, account locked): hammering it risks a lockout. */
export class FatalWatchError extends Error {
  override readonly name = "FatalWatchError";
}

/**
 * True for an error that carries an answer of the server: a tagged NO or BAD, an untagged BYE, a response code, or a refused sign-in
 * (ImapFlow 2.9.1 sets these fields; `lib/commands/login.js`, `lib/imap-flow.js`). A dropped or unreachable connection has none.
 */
export function refusedByServer(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("authenticationFailed" in error && error.authenticationFailed === true) return true;
  return ["responseStatus", "serverResponseCode"].some((key) => {
    const value: unknown = Reflect.get(error, key);
    return typeof value === "string" && value !== "";
  });
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
  /** New mail whose sender cannot be matched. Absent: such mail is passed over in silence. */
  readonly onUnreadableSender?: (accountId: string, message: UnreadableSender) => void;
  /**
   * Sees every new mail of a drain before anything is announced, and returns the mail left to announce. Throwing keeps the cursor,
   * so the batch is looked at again on the next connection.
   */
  readonly screen?: (fresh: readonly IncomingMessage[]) => Promise<readonly IncomingMessage[]>;
  /** New mail went past the cursor unseen: more at once than FETCH_LIMIT, stepped over with an unreadable mail, or a renumbered mailbox. */
  readonly onGap?: (accountId: string, reason: GapReason) => void;
  /** More new messages than `maxPerDrain`: the older `skipped` ones were not announced. */
  readonly onOverflow?: (accountId: string, skipped: number) => void;
  /** A mail too large to read was stepped past, with whatever came in beside it; `skipped` counts UIDs, an upper bound. */
  readonly onUnreadable?: (accountId: string, skipped: number) => void;
  /** `refused`: on `backoff`, the server answered and said no (a login limit, a busy mailbox), so another account's success changes nothing. */
  readonly onState?: (
    accountId: string,
    state: WatcherState,
    detail?: string,
    refused?: boolean,
  ) => void;
  readonly maxPerDrain?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number; readonly stableMs: number };
  /** Injectable for tests; returns [0, 1). */
  readonly random?: () => number;
  /** Injectable for tests. Unit: epoch milliseconds. */
  readonly now?: () => number;
}

// \p{Cc} = C0 controls, DEL and C1 controls; the rest are the invisible bidi marks and overrides.
const CONTROL_AND_BIDI = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Header text is hostile: it is shown in a system toast, so strip what can spoof or break it. */
export function sanitizeSubject(raw: string): string {
  // A copy, not `slice` alone: a slice can keep the whole raw subject alive for as long as the message is held.
  return Buffer.from(raw.slice(0, SUBJECT_SCAN_MAX), "utf8")
    .toString("utf8")
    .replace(CONTROL_AND_BIDI, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SUBJECT_MAX);
}

const SPAM_SCORE_LINE = /^x-spam-score:[ \t]*(-?\d{1,3}(?:\.\d{1,2})?)(?=[ \t]*(?:\(|\r|\n|$))/imu;
const ANY_SPAM_SCORE_LINE = /^x-spam-score:/gimu;

/** `X-Spam-Score` out of a fetched header block, or null. The block is server text: bounded, strict number only. */
export function parseSpamScore(headers: Uint8Array | undefined): number | null {
  // The fetch asks for this one header only, so a real answer is tens of bytes. A longer block is padding: a sender can
  // put its own score line first and push the server's out of the window, so no score is trusted.
  if (headers === undefined || headers.length > SPAM_HEADER_MAX_BYTES) return null;
  const text = Buffer.from(headers).toString("latin1");
  // A sender can put its own `X-Spam-Score` line ahead of the server's: more than one line means no trusted score. Every line
  // counts, also one whose value we cannot read: otherwise a server line in another format leaves the forged one alone.
  if (text.match(ANY_SPAM_SCORE_LINE)?.length !== 1) return null;
  const match = SPAM_SCORE_LINE.exec(text);
  if (match?.[1] === undefined) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) && score >= SPAM_SCORE.min && score <= SPAM_SCORE.max
    ? score
    : null;
}

/**
 * Earliest and latest INTERNALDATE taken at its word. Unit: epoch milliseconds. 1982 is the year of RFC 822; the far end is
 * 9999-12-31, the last year RFC 9051 `date-year` (four digits) can write.
 */
export const DELIVERED_AT = { min: Date.UTC(1982, 0, 1), max: Date.UTC(9999, 11, 31) } as const;

/** INTERNALDATE as the library hands it over (a Date, or text it could not read as one), or null. */
export function parseDeliveredAt(raw: Date | string | undefined): number | null {
  if (!(raw instanceof Date)) return null;
  const ms = raw.getTime();
  return Number.isFinite(ms) && ms >= DELIVERED_AT.min && ms <= DELIVERED_AT.max ? ms : null;
}

/** Envelope fields -> a row: with `from` null when the sender is not an address we can match. */
export function toIncoming(
  uid: number,
  fromAddress: string | undefined,
  subject: string | undefined,
  headers?: Uint8Array,
  internalDate?: Date | string,
): IncomingRow {
  const parsed = fromAddress === undefined ? null : parseAddress(fromAddress);
  if (parsed?.ok !== true) return { uid, from: null, subject: sanitizeSubject(subject ?? "") };
  return {
    uid,
    from: parsed.value.address,
    subject: sanitizeSubject(subject ?? ""),
    spamScore: parseSpamScore(headers),
    deliveredAt: parseDeliveredAt(internalDate),
  };
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
  /** The connection died on a mail too large to read: the next one steps past it. */
  private skipUnreadable = false;
  /** The connection whose first look at the mailbox is still to come. */
  private opening: MailboxSession | null = null;
  /** The Recent read running: a second asker joins it, so at most one FETCH of it is queued on the connection. */
  private recentRead: Promise<RecentRow[]> | null = null;
  /** A Recent read hit a mail too large to read: the cursor and the time then (RECENT_TOO_LARGE_MAILS, RECENT_TOO_LARGE_MS). */
  private recentTooLarge: { readonly lastUid: number; readonly at: number } | null = null;

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
    this.skipUnreadable = false;
    void this.connectOnce();
  }

  async stop(): Promise<void> {
    this.epoch += 1;
    this.clearTimers();
    const session = this.session;
    this.session = null;
    // A halt outlives a stop: only `start()`, asked for by the person, may send the refused password again (ADR 0003).
    if (this.state !== "halted") this.setState("stopped");
    if (session !== null) await closeQuietly(session);
  }

  /** The end of a pause: picks up what the pause stopped, and leaves a halted account alone. */
  resume(): void {
    if (this.state === "stopped") this.start();
  }

  /** After system resume (a sleeping socket is dead but not yet reported) or when settings change. */
  reconnectNow(): void {
    // A halted account (wrong password) waits for the person: a retry on every resume risks a server lockout (ADR 0003).
    if (this.state === "stopped" || this.state === "halted") return;
    this.epoch += 1;
    this.clearTimers();
    const session = this.session;
    this.session = null;
    if (session !== null) void closeQuietly(session);
    this.failures = 0;
    void this.connectOnce();
  }

  /**
   * The network is back (another account just connected): try now instead of waiting out the delay. The failure count stays, so a
   * server that refuses again goes on with the longer delay. Returns whether a try started.
   */
  nudge(): boolean {
    if (this.state !== "backoff" || this.retryTimer === null) return false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connectOnce();
    return true;
  }

  /**
   * The newest `count` mails of the Inbox, read on the open connection, or null when there is none to read on (not watching).
   * Never connects: the Recent mail view must not log in once more per account, and a halted account must stay alone (ADR 0003).
   * A failure is the caller's: the connection's own close, if the read ended it, reaches `fail` as for any command.
   */
  async recent(count: number, signal?: AbortSignal): Promise<RecentRow[] | null> {
    const session = this.session;
    if (this.state !== "watching" || session?.recent === undefined) return null;
    const now = this.options.now ?? Date.now;
    const lastUid = (): number => this.options.cursors.get(this.options.accountId)?.lastUid ?? 0;
    const tooLarge = this.recentTooLarge;
    if (tooLarge !== null) {
      const moved = lastUid() - tooLarge.lastUid >= RECENT_TOO_LARGE_MAILS;
      if (!moved && now() - tooLarge.at < RECENT_TOO_LARGE_MS) {
        throw new RecentTooLargeError("a mail among the newest is too large to read");
      }
      this.recentTooLarge = null;
    }
    this.recentRead ??= session
      .recent(count, signal)
      .catch((error: unknown) => {
        if (error instanceof RecentTooLargeError)
          this.recentTooLarge = { lastUid: lastUid(), at: now() };
        throw error;
      })
      .finally(() => {
        this.recentRead = null;
      });
    return this.recentRead;
  }

  private setState(state: WatcherState, detail?: string, refused = false): void {
    this.state = state;
    this.options.onState?.(this.options.accountId, state, detail, refused);
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
    this.opening = session;
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
    // Spent by the first drain, whichever way it ends: `uidNext` is frozen at open, so the test below holds only then.
    const opening = this.opening === session;
    this.opening = null;
    const cursor = cursors.get(accountId);
    if (cursor === undefined || cursor.uidValidity !== session.uidValidity) {
      // First run, or the server renumbered the mailbox: mail already there is not "new".
      cursors.set(accountId, { uidValidity: session.uidValidity, lastUid: session.uidNext - 1 });
      this.skipUnreadable = false;
      if (cursor !== undefined) this.gap("renumbered");
      return;
    }
    if (this.skipUnreadable) {
      // One mail must not end notifications for this mailbox: everything up to now is passed over and the person is told.
      this.skipUnreadable = false;
      const lastUid = session.uidNext - 1;
      if (lastUid > cursor.lastUid) {
        cursors.set(accountId, { uidValidity: session.uidValidity, lastUid });
        this.options.onUnreadable?.(accountId, lastUid - cursor.lastUid);
        this.gap("unreadable");
        return;
      }
    }
    // Nothing past the cursor, and `n:*` would still hand back the newest mail. That one may be the mail that cannot be read, so
    // asking again at every connect would end this connection the same way.
    if (opening && session.uidNext - 1 <= cursor.lastUid) return;
    const wide = opening && session.uidNext - 1 - cursor.lastUid > FETCH_LIMIT;

    const rows = await session.fetchSince(cursor.lastUid);
    const arrived = rows.filter((m) => m.uid > cursor.lastUid).sort((a, b) => a.uid - b.uid);
    const fresh = arrived.filter((m): m is IncomingMessage => m.from !== null);
    // A burst past the limit on a live session shows only here: `uidNext` is frozen at open. Rows count before the unusable ones
    // go, or one bad From among the newest hides mail the limit left out.
    if (wide || rows.length >= FETCH_LIMIT) this.gap("burst");
    // The watcher was stopped or replaced while the fetch ran: its result belongs to nobody.
    if (epoch !== this.epoch || arrived.length === 0) return;

    const kept =
      this.options.screen === undefined || fresh.length === 0
        ? fresh
        : await this.options.screen(fresh);
    if (epoch !== this.epoch) return;

    // One limit for both kinds: a burst with unreadable senders is the same toast flood.
    const left: IncomingRow[] = [...kept, ...arrived.filter((m) => m.from === null)].sort(
      (a, b) => a.uid - b.uid,
    );
    const skipped = Math.max(0, left.length - this.maxPerDrain);
    for (const [index, message] of left.entries()) {
      if (index < skipped) continue;
      try {
        if (message.from === null) this.options.onUnreadableSender?.(accountId, message);
        else this.options.onMessage(accountId, message);
      } catch {
        // A consumer bug must not wedge the cursor on one message.
      }
    }
    // One write per drain, not one per message (200 upserts were 287 ms on the main thread). A crash inside the loop announces
    // this batch again on the next start: at least once, never lost.
    // The cursor also passes mail with an unreadable sender, or that one mail is read and told again at every connect.
    const last = arrived[arrived.length - 1];
    if (last !== undefined)
      cursors.set(accountId, { uidValidity: session.uidValidity, lastUid: last.uid });
    if (skipped > 0) this.options.onOverflow?.(accountId, skipped);
  }

  private gap(reason: GapReason): void {
    try {
      this.options.onGap?.(this.options.accountId, reason);
    } catch {
      // A listener must not end the drain: on a burst that stops the screen and the cursor, at every connect.
    }
  }

  private fail(epoch: number, error: unknown): void {
    if (epoch !== this.epoch) return;
    this.epoch += 1;
    this.clearTimers();
    const session = this.session;
    this.session = null;
    if (session !== null) void closeQuietly(session);

    if (error instanceof UnreadableMailError) this.skipUnreadable = true;
    const message = (error instanceof Error ? error.message : "unknown error").slice(0, 300);
    if (error instanceof FatalWatchError) {
      this.setState("halted", message);
      return;
    }

    this.failures += 1;
    const ceiling = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (this.failures - 1));
    // Equal jitter: half fixed, half random, so 50 accounts do not reconnect in lockstep after a network blip.
    const delay = Math.round(ceiling / 2 + (ceiling / 2) * this.random());
    this.setState("backoff", message, refusedByServer(error));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectOnce();
    }, delay);
  }
}
