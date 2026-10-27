import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode } from "../adapter.js";
import { unlimited } from "../gate.js";
import type { Gate } from "../gate.js";
import { DEFAULT_MAX_PER_DRAIN, sanitizeSubject } from "../watcher/watcher.js";
import {
  HISTORY_ID,
  HistoryExpiredError,
  HistoryTooLargeError,
  MalformedAnswerError,
  senderOf,
} from "./mail-client.js";
import type { GmailMailClient, MessageMetadata } from "./mail-client.js";

// Scale budget (per Gmail account, one device; ADR 0009 "Scale", .task/gmail-watcher.md A0): no connection, one `history.list`
// every 60 s +-10 s (2 units, 1,440 a day), and for new mail one `messages.get` each (20 units), at most DEFAULT_MAX_PER_DRAIN
// per poll. One poll in flight per account (the next timer is set when the last poll ends, never a repeating timer), at most
// MAX_CONCURRENT_GMAIL_POLLS polls at once through the gate the caller gives (a gate of its own, so an outage cannot hold the IMAP logins' slots), a start or resume spread over GMAIL_START_SPREAD_MS so 50 accounts
// do not tick together, failures back off with equal jitter (30-60 s after the first, 150-300 s at the cap). Linear in accounts only (MAX_ACCOUNTS = 50 =>
// 50 requests a minute). The watcher keeps no per-mail state beyond ANNOUNCED_MAX ids and the failures of the current batch.

/** The gap between two polls. Unit: milliseconds. The jitter is drawn uniformly, so the mean stays `baseMs` (1,440 polls a day). */
export const GMAIL_POLL = { baseMs: 60_000, jitterMs: 10_000 } as const;
/** A start or a resume schedules the first poll somewhere in this window. Unit: milliseconds. */
export const GMAIL_START_SPREAD_MS = 30_000;
/**
 * After a failure: the delay's ceiling doubles from `baseMs` to `maxMs`, and equal jitter then draws half of it fixed and half random,
 * so the real wait is 30-60 s after the first failure and 150-300 s at the cap. Unit: milliseconds.
 */
export const GMAIL_BACKOFF = { baseMs: 60_000, maxMs: 300_000 } as const;
/**
 * One poll, from its first request to its last, at most. Unit: milliseconds. A poll is at most 6 requests in a row (5 pages, or a
 * profile, then the message reads together) at 15 s each, plus the token; a poll that is still running after this is dead, not slow:
 * it is aborted, its gate slot is freed and it counts as a failure.
 */
export const GMAIL_POLL_DEADLINE_MS = 120_000;
/** Polls in a row that Google refused (a 4xx that is not about the sign-in or our quota) before the watcher stops asking. Unit: polls. */
export const GMAIL_REJECTED_HALT = 5;
/** Messages announced in one poll, upper bound for the option (each is one `messages.get` of 20 units, all at once). Unit: messages. */
export const GMAIL_MAX_PER_DRAIN_LIMIT = 25;
/** `history.list` pages read in one poll, at most. Unit: pages of HISTORY_PAGE_SIZE records. Beyond it the rest of the gap is reported, not read. */
export const GMAIL_MAX_PAGES = 5;
/** Tries for one message that keeps failing to read (a malformed answer) before it is given up as not announced. Unit: tries. */
export const GMAIL_MESSAGE_ATTEMPTS = 3;
/**
 * How long one message may keep failing for reasons that are not its own (a 5xx, a timeout) before it is given up. Unit: milliseconds.
 * Without it a message that Google never serves would hold the cursor for ever and, once enough newer mail had pushed ANNOUNCED_MAX
 * ids out, old mail would be announced a second time. Half an hour is longer than the outages the backoff rides out (150-300 s per try).
 */
export const GMAIL_MESSAGE_PATIENCE_MS = 30 * 60_000;
/** Message ids remembered as announced or given up, so a retried poll or a repeated page never announces one twice. Unit: ids; oldest dropped first. */
export const ANNOUNCED_MAX = 500;

export interface GmailIncoming {
  /** The message id (Gmail's, hex). Never shown. */
  readonly id: string;
  /** Validated, lowercased `local@domain`, or null when the sender could not be read safely: announced without a Block button. */
  readonly from: string | null;
  /** Control and bidi characters removed, at most SUBJECT_MAX UTF-16 units. Display only. */
  readonly subject: string;
}

export interface GmailCursorStore {
  get(accountId: string): string | undefined;
  set(accountId: string, historyId: string): void;
}

/**
 * `starting`: started, no poll has worked yet. `watching`: the last poll worked (`lastOkAt` says when). `backoff`: it failed and the next try is later (`detail` says why).
 * `halted-auth`: Google refused the sign-in. `halted-rejected`: Google refused GMAIL_REJECTED_HALT polls in a row. Nothing is polled in
 * either until `start()` again. Silence is never read as "all quiet":
 * a watcher that is not `watching` is not looking.
 */
export type GmailWatcherState =
  "stopped" | "starting" | "watching" | "backoff" | "halted-auth" | "halted-rejected";
export type GmailBackoffDetail = "quota" | "transient" | "rejected";

/** Mail the person was not told about (the same notice as an IMAP overflow). */
export type GmailGap =
  /** The cursor was too old for Google (404): everything in between is unknown. */
  | "expired"
  /** History records or messages that did not fit the expected shape. */
  | "unreadable"
  /** A message kept failing to read and was given up. */
  | "skipped"
  /** More history than one poll reads. */
  | "overflow"
  /** A history page was too big to read: everything since the cursor, the newest mail included, was not announced. */
  | "too-large";

export interface GmailPollEvent {
  readonly outcome: "ok" | "first" | "gap" | "error";
  /** Set when `outcome` is `error`. */
  readonly code?: AdapterErrorCode;
  readonly pages: number;
  /** New message ids found (after the ones already announced). */
  readonly found: number;
  readonly announced: number;
  /** Announcements whose consumer threw (counted as announced, so a broken toast path does not look like quiet). */
  readonly consumerErrors: number;
  readonly ms: number;
}

export interface GmailWatcherOptions {
  readonly accountId: string;
  /** The budgeted client (`GmailBudgets.wrapMail`): every call is paid before it leaves. */
  readonly client: GmailMailClient;
  readonly cursors: GmailCursorStore;
  readonly onMessage: (accountId: string, message: GmailIncoming) => void;
  /** More new messages than `maxPerDrain`: the older `skipped` ones were not announced. */
  readonly onOverflow?: (accountId: string, skipped: number) => void;
  readonly onGap?: (accountId: string, gap: GmailGap) => void;
  readonly onState?: (
    accountId: string,
    state: GmailWatcherState,
    detail?: GmailBackoffDetail,
  ) => void;
  readonly onPoll?: (accountId: string, event: GmailPollEvent) => void;
  /** Shared by every watcher of the device; bounds simultaneous polls. Unlimited when absent. */
  readonly gate?: Gate;
  readonly maxPerDrain?: number;
  /** Injectable for tests; returns [0, 1). */
  readonly random?: () => number;
  readonly now?: () => number;
}

interface PollSummary {
  readonly outcome: "ok" | "first" | "gap";
  readonly pages: number;
  readonly found: number;
  readonly announced: number;
  readonly consumerErrors: number;
}

/** A poll in the air: its epoch, and the abort that `stop()` and the deadline use. */
interface Flight {
  readonly epoch: number;
  readonly controller: AbortController;
}

/** The larger of two history ids, compared as BigInt (they outgrow a double). */
function furthest(a: string, b: string): string {
  return BigInt(b) > BigInt(a) ? b : a;
}

function classify(error: unknown): {
  halt: boolean;
  detail: GmailBackoffDetail;
  code: AdapterErrorCode;
} {
  if (error instanceof AdapterError) {
    if (error.code === "AUTH_REQUIRED") return { halt: true, detail: "rejected", code: error.code };
    if (error.code === "QUOTA_EXCEEDED") return { halt: false, detail: "quota", code: error.code };
    if (error.code === "REJECTED") return { halt: false, detail: "rejected", code: error.code };
    return { halt: false, detail: "transient", code: error.code };
  }
  return { halt: false, detail: "transient", code: "TRANSIENT" };
}

/**
 * One Gmail account's new-mail watcher (ADR 0009 point 5): read the history since the stored cursor, announce the newest messages
 * of it (From and Subject only), keep the cursor, wait, repeat. The Gmail API is behind `GmailMailClient`, so this logic is
 * tested without a network. The cursor moves only when a poll finished: a poll that failed half way is read again, and the
 * messages it already announced are not announced twice.
 */
export class GmailWatcher {
  readonly #options: GmailWatcherOptions;
  readonly #gate: Gate;
  readonly #maxPerDrain: number;
  readonly #random: () => number;
  readonly #now: () => number;
  #state: GmailWatcherState = "stopped";
  #detail: GmailBackoffDetail | undefined;
  /** Bumped on every start and stop; the result of an older epoch belongs to nobody. */
  #epoch = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** The poll in the air, if any. A stale one (older epoch) may still be winding down while a newer epoch polls. */
  #flight: Flight | null = null;
  /** A resume came while a poll ran: the next poll comes soon, not after a full interval. */
  #soon = false;
  #failures = 0;
  #rejected = 0;
  #lastOkAt: number | null = null;
  #consumerErrors = 0;
  readonly #announced = new Set<string>();
  readonly #attempts = new Map<string, { tries: number; since: number }>();

  constructor(options: GmailWatcherOptions) {
    this.#options = options;
    this.#gate = options.gate ?? unlimited;
    this.#maxPerDrain = Math.min(
      GMAIL_MAX_PER_DRAIN_LIMIT,
      Math.max(1, Math.floor(options.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN)),
    );
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  get current(): GmailWatcherState {
    return this.#state;
  }

  /**
   * When the last poll worked (epoch milliseconds), or null before the first one: what tells "no new mail" from "not looking". It is
   * kept across `stop()` and `start()`, so read it together with `current`: only a `watching` watcher has polled lately.
   */
  get lastOkAt(): number | null {
    return this.#lastOkAt;
  }

  start(): void {
    if (this.#isRunning()) return;
    this.#epoch += 1;
    this.#failures = 0;
    this.#rejected = 0;
    this.#setState("starting");
    this.#schedule(Math.round(this.#random() * GMAIL_START_SPREAD_MS));
  }

  stop(): void {
    this.#epoch += 1;
    this.#clearTimer();
    // A poll in the air is called off, not waited for: its request is aborted and its gate slot comes back.
    this.#flight?.controller.abort();
    this.#soon = false;
    this.#attempts.clear();
    this.#setState("stopped");
  }

  /** After system resume (a sleeping poll may have died unreported): look soon, spread like a start so 50 accounts do not tick together. */
  resumeNow(): void {
    if (!this.#isRunning()) return;
    if (this.#flight?.epoch === this.#epoch) {
      this.#soon = true;
      return;
    }
    this.#schedule(Math.round(this.#random() * GMAIL_START_SPREAD_MS));
  }

  /** Started and not stopped or halted: a timer or a poll is, or is about to be, in the air. */
  #isRunning(): boolean {
    return this.#state === "starting" || this.#state === "watching" || this.#state === "backoff";
  }

  #setState(state: GmailWatcherState, detail?: GmailBackoffDetail): void {
    if (this.#state === state && this.#detail === detail) return;
    this.#state = state;
    this.#detail = detail;
    try {
      this.#options.onState?.(this.#options.accountId, state, detail);
    } catch {
      // a listener must not break the watcher
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    this.#clearTimer();
    const epoch = this.#epoch;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#poll(epoch);
    }, delayMs);
  }

  /** 60 s +- 10 s, uniform: the mean stays 60 s, so the daily call count is the one the budget was derived from. */
  #interval(): number {
    const { baseMs, jitterMs } = GMAIL_POLL;
    return Math.round(baseMs - jitterMs + 2 * jitterMs * this.#random());
  }

  /** Equal jitter: half fixed, half random, so 50 accounts do not retry in lockstep after a network blip. */
  #backoffDelay(): number {
    const ceiling = Math.min(GMAIL_BACKOFF.maxMs, GMAIL_BACKOFF.baseMs * 2 ** (this.#failures - 1));
    return Math.round(ceiling / 2 + (ceiling / 2) * this.#random());
  }

  #emitPoll(event: GmailPollEvent): void {
    try {
      this.#options.onPoll?.(this.#options.accountId, event);
    } catch {
      // a log must not break the watcher
    }
  }

  /** Still the current epoch, and not called off or past its deadline: nothing may be written or announced otherwise. */
  #alive(epoch: number, signal: AbortSignal): boolean {
    return epoch === this.#epoch && !signal.aborted;
  }

  async #poll(epoch: number): Promise<void> {
    if (epoch !== this.#epoch) return;
    // One poll per epoch. An older epoch's poll may still be winding down (it was aborted by `stop()`); it is not waited for.
    // A poll that was called off while it WAITED for a gate slot is not settled by `stop()`: it ends only when its turn comes, so it can
    // outlive its epoch. This check and the `finally` below keep it from blocking, or clearing the bookkeeping of, a newer epoch's poll.
    if (this.#flight?.epoch === epoch) return;
    const controller = new AbortController();
    const flight: Flight = { epoch, controller };
    this.#flight = flight;
    const signal = controller.signal;
    const started = this.#now();
    let next: number | null;
    try {
      const summary = await this.#gate(() => this.#gated(epoch, signal, controller));
      if (!this.#alive(epoch, signal)) return;
      this.#failures = 0;
      this.#rejected = 0;
      this.#lastOkAt = this.#now();
      this.#setState("watching");
      this.#emitPoll({ ...summary, ms: Math.max(0, this.#now() - started) });
      next = this.#soon ? Math.round(this.#random() * GMAIL_START_SPREAD_MS) : this.#interval();
    } catch (error) {
      // A poll of an older epoch, or one that was called off, ends here without a word: `stop()` already said "stopped".
      if (epoch !== this.#epoch) return;
      const { halt, detail, code } = classify(error);
      this.#emitPoll({
        outcome: "error",
        code,
        pages: 0,
        found: 0,
        announced: 0,
        consumerErrors: 0,
        ms: Math.max(0, this.#now() - started),
      });
      if (halt) {
        this.#setState("halted-auth");
        next = null;
      } else {
        this.#failures += 1;
        this.#rejected = detail === "rejected" ? this.#rejected + 1 : 0;
        if (this.#rejected >= GMAIL_REJECTED_HALT) {
          // Asking again is not going to change what Google answers: stop, and say so (state), until a start begins again.
          this.#setState("halted-rejected");
          next = null;
        } else {
          this.#setState("backoff", detail);
          next = this.#backoffDelay();
        }
      }
    } finally {
      // Only this poll's own bookkeeping: a newer epoch's flight and its `#soon` are not this one's to clear.
      if (this.#flight === flight) {
        this.#flight = null;
        this.#soon = false;
      }
    }
    if (next !== null && epoch === this.#epoch) this.#schedule(next);
  }

  /**
   * What runs once the gate has given this poll its slot. A poll that was called off while it queued sends nothing and ends at once.
   * The deadline starts here (the queue is not the poll's time), with our own timer rather than `AbortSignal.timeout`, so `stop()` and
   * the deadline end a poll the same way. The race against `dead` covers what the signal cannot reach (a token refresh that never ends)
   * and frees the slot; `dead` is made here, after the check, so an abort can never reach a promise nobody is listening to.
   */
  async #gated(
    epoch: number,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<PollSummary> {
    if (!this.#alive(epoch, signal)) throw new AdapterError("TRANSIENT", "the poll was called off");
    const deadline = setTimeout(() => {
      controller.abort(new AdapterError("TRANSIENT", "the poll did not finish in time"));
    }, GMAIL_POLL_DEADLINE_MS);
    try {
      const dead = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new AdapterError("TRANSIENT", "the poll was called off"),
            );
          },
          { once: true },
        );
      });
      return await Promise.race([this.#pollOnce(epoch, signal), dead]);
    } finally {
      clearTimeout(deadline);
    }
  }

  /** A first run, or a cursor that Google no longer holds: mail already there is not "new"; start from now. */
  async #startFromNow(
    epoch: number,
    signal: AbortSignal,
    outcome: "first" | "gap",
    why: GmailGap = "expired",
  ): Promise<PollSummary> {
    const empty: PollSummary = { outcome, pages: 0, found: 0, announced: 0, consumerErrors: 0 };
    const { historyId } = await this.#options.client.profile(signal);
    if (!this.#alive(epoch, signal)) return empty;
    this.#options.cursors.set(this.#options.accountId, historyId);
    this.#attempts.clear();
    if (outcome === "gap") this.#gap(why);
    return empty;
  }

  #gap(gap: GmailGap): void {
    try {
      this.#options.onGap?.(this.#options.accountId, gap);
    } catch {
      // a listener must not break the watcher
    }
  }

  #remember(id: string): void {
    this.#announced.add(id);
    if (this.#announced.size > ANNOUNCED_MAX) {
      const oldest = this.#announced.values().next();
      if (!oldest.done) this.#announced.delete(oldest.value);
    }
  }

  async #pollOnce(epoch: number, signal: AbortSignal): Promise<PollSummary> {
    const { accountId, client, cursors } = this.#options;
    const stored = cursors.get(accountId);
    const cursor = stored !== undefined && HISTORY_ID.test(stored) ? stored : undefined;
    if (cursor === undefined) return this.#startFromNow(epoch, signal, "first");
    this.#consumerErrors = 0;

    // Pages depend on each other (each token comes from the one before), so they are read in turn; at most GMAIL_MAX_PAGES.
    const ids: string[] = [];
    const seen = new Set<string>();
    let newCursor = cursor;
    let unreadable = 0;
    let pages = 0;
    let pageToken: string | undefined;
    try {
      do {
        const page = await client.history(cursor, pageToken, signal);
        pages += 1;
        // Called off between two pages: no further page is asked for.
        if (!this.#alive(epoch, signal)) {
          return { outcome: "ok", pages, found: 0, announced: 0, consumerErrors: 0 };
        }
        newCursor = furthest(newCursor, page.historyId);
        unreadable += page.unreadable;
        for (const message of page.messages) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          ids.push(message.id);
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined && pages < GMAIL_MAX_PAGES);
    } catch (error) {
      if (error instanceof HistoryExpiredError) return this.#startFromNow(epoch, signal, "gap");
      // A page too big to read never gets smaller: start from now and say that mail was not announced (not "retry for a week").
      if (error instanceof HistoryTooLargeError) {
        return this.#startFromNow(epoch, signal, "gap", "too-large");
      }
      throw error;
    }

    // Google lists oldest first: the newest `maxPerDrain` are announced, the older ones are counted. (After a failed poll the older
    // ones of the first try are read again, so a retried poll can announce more than `maxPerDrain` in all; never one twice.)
    const fresh = ids.filter((id) => !this.#announced.has(id));
    const skipped = Math.max(0, fresh.length - this.#maxPerDrain);
    const batch = fresh.slice(skipped);
    // What a retry counted against a message that is not in this batch any more (pushed out by newer mail) is forgotten.
    const inBatch = new Set(batch);
    for (const id of this.#attempts.keys()) if (!inBatch.has(id)) this.#attempts.delete(id);
    // At most `maxPerDrain` reads at once, which is the cost bound of a poll; one that fails does not hide the others.
    const results = await Promise.allSettled(batch.map((id) => client.message(id, signal)));
    if (!this.#alive(epoch, signal)) {
      return { outcome: "ok", pages, found: fresh.length, announced: 0, consumerErrors: 0 };
    }

    let announced = 0;
    let given = 0;
    let blocking: Error | null = null;
    for (const [index, result] of results.entries()) {
      const id = batch[index];
      if (id === undefined) continue;
      if (result.status === "fulfilled") {
        if (result.value !== "gone" && this.#announce(result.value)) announced += 1;
        this.#remember(id);
        this.#attempts.delete(id);
        continue;
      }
      const reason: unknown = result.reason;
      const error =
        reason instanceof Error
          ? reason
          : new AdapterError("TRANSIENT", "a message could not be read");
      const kind = classify(error);
      // A refusal of the sign-in or of our quota stops the whole poll; the cursor stays, nothing is lost.
      if (kind.halt || kind.detail === "quota") {
        if (blocking === null || kind.halt) blocking = error;
        continue;
      }
      // Only a failure that belongs to THIS message counts as a try (an answer that is not what it should be, or a refusal of this one).
      // A timeout or a 5xx is the network's or Google's passing state: the poll backs off and tries the same mail again, and only gives
      // it up after GMAIL_MESSAGE_PATIENCE_MS of it.
      const ownFailure =
        error instanceof MalformedAnswerError ||
        (error instanceof AdapterError && error.code === "REJECTED");
      const now = this.#now();
      const entry = this.#attempts.get(id) ?? { tries: 0, since: now };
      const tries = entry.tries + (ownFailure ? 1 : 0);
      if (tries >= GMAIL_MESSAGE_ATTEMPTS || now - entry.since >= GMAIL_MESSAGE_PATIENCE_MS) {
        // A message that cannot be read must not hold the cursor for ever: it is given up and reported.
        this.#attempts.delete(id);
        this.#remember(id);
        // Reported now, not at the end: a poll that then fails on another message must not lose this notice.
        this.#gap("skipped");
        given += 1;
      } else {
        this.#attempts.set(id, { tries, since: entry.since });
        blocking ??= error;
      }
    }
    if (blocking !== null) throw blocking;

    cursors.set(accountId, newCursor);
    if (skipped > 0) this.#overflow(skipped);
    if (unreadable > 0) this.#gap("unreadable");
    // At the page cap the newest of the oldest records were announced, not the newest of all: the rest is the gap reported here.
    if (pageToken !== undefined) this.#gap("overflow");
    const gapped = unreadable > 0 || given > 0 || pageToken !== undefined || skipped > 0;
    return {
      outcome: gapped ? "gap" : "ok",
      pages,
      found: fresh.length,
      announced,
      consumerErrors: this.#consumerErrors,
    };
  }

  #overflow(skipped: number): void {
    try {
      this.#options.onOverflow?.(this.#options.accountId, skipped);
    } catch {
      // a listener must not break the watcher
    }
  }

  /** One message to the consumer; false when it is not mail for the INBOX (the history said so, the message says what it is now). */
  #announce(message: MessageMetadata): boolean {
    if (!message.labelIds.includes("INBOX")) return false;
    const sender = senderOf(message);
    const subject = message.headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
    try {
      this.#options.onMessage(this.#options.accountId, {
        id: message.id,
        from: sender.ok ? sender.address : null,
        subject: sanitizeSubject(subject),
      });
    } catch {
      // A consumer bug must not wedge the cursor on one message; it is counted so the log shows it.
      this.#consumerErrors += 1;
    }
    return true;
  }
}
