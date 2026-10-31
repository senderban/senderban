import type { AdapterErrorCode } from "../adapter.js";
import type { Gate } from "../gate.js";
import { PollLoop } from "../watcher/poll-loop.js";
import type { PollBackoffDetail, PollContext, PollState } from "../watcher/poll-loop.js";
import { DEFAULT_MAX_PER_DRAIN } from "../watcher/watcher.js";
import { DeltaExpiredError, DeltaTooLargeError, isDeltaLink } from "./client.js";
import type { GraphDeltaFrom, GraphMail, GraphMailClient } from "./client.js";

// Scale budget (per Microsoft account, one device; ADR 0013 "New mail", .task/microsoft-hesap.md A0): no connection, one delta request every 60 s +-10 s
// (1,440 a day) which already carries From and Subject, so a new mail costs no further request, at most OUTLOOK_MAX_PAGES a poll. One poll in flight per account, at
// most MAX_CONCURRENT_OUTLOOK_POLLS at once through the gate the caller gives, a start or resume spread over OUTLOOK_START_SPREAD_MS, failures back off with equal
// jitter. Linear in accounts only (MAX_ACCOUNTS = 50 => 50 requests a minute, against Outlook's 10,000 per mailbox in 10 minutes). No per-mail state beyond
// OUTLOOK_ANNOUNCED_MAX ids. One cursor row, written when it changes.

/** The gap between two polls. Unit: milliseconds. A desktop app has no address for a webhook, so this is the pull model Microsoft describes (delta-query-overview). */
export const OUTLOOK_POLL = { baseMs: 60_000, jitterMs: 10_000 } as const;
/** A start or a resume schedules the first poll somewhere in this window. Unit: milliseconds. */
export const OUTLOOK_START_SPREAD_MS = 30_000;
/** After a failure: 30-60 s, up to 150-300 s at the cap (equal jitter). Unit: milliseconds. */
export const OUTLOOK_BACKOFF = { baseMs: 60_000, maxMs: 300_000 } as const;
/** One poll at most: OUTLOOK_MAX_PAGES requests of 15 s each, plus the token. Unit: milliseconds. */
export const OUTLOOK_POLL_DEADLINE_MS = 120_000;
/** Polls in a row Microsoft refused before the watcher stops asking. Unit: polls. */
export const OUTLOOK_REJECTED_HALT = 5;
/** Pages read in one poll, at most. Unit: pages of GRAPH_DELTA_PAGE_SIZE. The link of the last one is kept, so the next poll goes on from there and nothing is lost. */
export const OUTLOOK_MAX_PAGES = 5;
/** Mail announced in one poll, upper bound for the option. Unit: messages. */
export const OUTLOOK_MAX_PER_DRAIN_LIMIT = 25;
/** Message ids remembered as announced, because Microsoft says the same change can come twice. Unit: ids; oldest dropped first. */
export const OUTLOOK_ANNOUNCED_MAX = 500;
/**
 * Mail older than the newest one seen, by more than this, is not new. Unit: milliseconds. Microsoft says read-state changes come through a delta asked for new mail only,
 * in full form, so an old mail that was read must not read as a new one; a mail that took a while to show up must still be announced. One hour. PROVISIONAL.
 */
export const OUTLOOK_LATE_MS = 3_600_000;
/**
 * A round lasts this long, then a new one starts from the newest mail seen. Unit: milliseconds. Microsoft caps a filtered delta at 5,000 messages and does not say whether per
 * read or per link, and a token's life on Outlook is not fixed. Seven days keeps a link far from both, for one extra request a week, instead of a watcher that goes quiet.
 */
export const OUTLOOK_ROUND_MS = 7 * 24 * 3_600_000;

export type OutlookWatcherState = PollState;
export type OutlookBackoffDetail = PollBackoffDetail;

/** Mail the person was not told about. */
export type OutlookGap =
  /** Entries of a page that did not fit the expected shape. */
  | "unreadable"
  /** A page too big to read: what came in since the last check was not announced. */
  | "too-large";

export interface OutlookIncoming {
  /** Graph's message id. Never shown. */
  readonly id: string;
  /** Validated, lowercased `local@domain`, or null when the sender could not be read safely: announced without a Block button. */
  readonly from: string | null;
  /** Control and bidi characters removed. Display only. */
  readonly subject: string;
}

export interface OutlookCursor {
  /** Where Graph left off: its own link, opaque. */
  readonly link: string;
  /** When the newest mail seen came in. Epoch milliseconds. */
  readonly newestMs: number;
  /** When this link's round began. Epoch milliseconds. */
  readonly roundMs: number;
}

export interface OutlookCursorStore {
  get(accountId: string): OutlookCursor | undefined;
  set(accountId: string, cursor: OutlookCursor): void;
}

export interface OutlookPollEvent {
  readonly outcome: "ok" | "first" | "gap" | "error";
  /** Set when `outcome` is `error`. */
  readonly code?: AdapterErrorCode;
  readonly pages: number;
  /** New mail found (after what was already announced). */
  readonly found: number;
  readonly announced: number;
  /** Announcements whose consumer threw (counted as announced, so a broken toast path does not look like quiet). */
  readonly consumerErrors: number;
  readonly ms: number;
}

export interface OutlookWatcherOptions {
  readonly accountId: string;
  /** The budgeted client (`GraphBudgets.wrapMail`): every call is paid before it leaves. */
  readonly client: GraphMailClient;
  readonly cursors: OutlookCursorStore;
  readonly onMessage: (accountId: string, message: OutlookIncoming) => void;
  /** More new mail than `maxPerDrain`: the older `skipped` ones were not announced. */
  readonly onOverflow?: (accountId: string, skipped: number) => void;
  readonly onGap?: (accountId: string, gap: OutlookGap) => void;
  readonly onState?: (
    accountId: string,
    state: OutlookWatcherState,
    detail?: OutlookBackoffDetail,
  ) => void;
  readonly onPoll?: (accountId: string, event: OutlookPollEvent) => void;
  /** Shared by every Outlook watcher of the device; bounds simultaneous polls. Unlimited when absent. */
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

/**
 * One Microsoft account's new-mail watcher: read the Inbox's delta since the stored link, announce the newest mail of it (From and Subject only), keep the link, wait,
 * repeat. Graph is behind `GraphMailClient`, so this is tested without a network. The link moves only when a poll finished: a poll that failed half way is read again, and
 * what it already announced is not announced twice.
 */
export class OutlookWatcher {
  readonly #options: OutlookWatcherOptions;
  readonly #maxPerDrain: number;
  readonly #now: () => number;
  readonly #loop: PollLoop<PollSummary>;
  #consumerErrors = 0;
  readonly #announced = new Set<string>();

  constructor(options: OutlookWatcherOptions) {
    this.#options = options;
    this.#maxPerDrain = Math.min(
      OUTLOOK_MAX_PER_DRAIN_LIMIT,
      Math.max(1, Math.floor(options.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN)),
    );
    this.#now = options.now ?? Date.now;
    this.#loop = new PollLoop<PollSummary>({
      timing: {
        poll: OUTLOOK_POLL,
        startSpreadMs: OUTLOOK_START_SPREAD_MS,
        backoff: OUTLOOK_BACKOFF,
        deadlineMs: OUTLOOK_POLL_DEADLINE_MS,
        rejectedHalt: OUTLOOK_REJECTED_HALT,
      },
      poll: (context) => this.#pollOnce(context),
      onState: (state, detail) => {
        options.onState?.(options.accountId, state, detail);
      },
      onDone: (summary, ms) => {
        options.onPoll?.(options.accountId, { ...summary, ms });
      },
      onFailed: (code, ms) => {
        options.onPoll?.(options.accountId, {
          outcome: "error",
          code,
          pages: 0,
          found: 0,
          announced: 0,
          consumerErrors: 0,
          ms,
        });
      },
      ...(options.gate === undefined ? {} : { gate: options.gate }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  get current(): OutlookWatcherState {
    return this.#loop.current;
  }

  /** See `PollLoop.lastOkAt`. */
  get lastOkAt(): number | null {
    return this.#loop.lastOkAt;
  }

  start(): void {
    this.#loop.start();
  }

  stop(): void {
    this.#loop.stop();
  }

  resume(): void {
    this.#loop.resume();
  }

  resumeNow(): void {
    this.#loop.resumeNow();
  }

  #gap(gap: OutlookGap): void {
    try {
      this.#options.onGap?.(this.#options.accountId, gap);
    } catch {
      // a listener must not break the watcher
    }
  }

  #overflow(skipped: number): void {
    try {
      this.#options.onOverflow?.(this.#options.accountId, skipped);
    } catch {
      // a listener must not break the watcher
    }
  }

  #remember(id: string): void {
    this.#announced.add(id);
    if (this.#announced.size > OUTLOOK_ANNOUNCED_MAX) {
      const oldest = this.#announced.values().next();
      if (!oldest.done) this.#announced.delete(oldest.value);
    }
  }

  #announce(mail: GraphMail): void {
    try {
      this.#options.onMessage(this.#options.accountId, {
        id: mail.id,
        from: mail.from,
        subject: mail.subject,
      });
    } catch {
      // A consumer bug must not wedge the link on one message; it is counted so the log shows it.
      this.#consumerErrors += 1;
    }
  }

  /** Pages of one poll, in turn: each link comes from the page before. A link no longer known starts again from the newest mail seen, so nothing is lost with it. */
  async #read(
    context: PollContext,
    start: GraphDeltaFrom,
    newestMs: number,
  ): Promise<{ mail: GraphMail[]; unreadable: number; pages: number; link: string } | null> {
    const mail: GraphMail[] = [];
    let unreadable = 0;
    let pages = 0;
    let from = start;
    for (;;) {
      let page;
      try {
        page = await this.#options.client.delta(from, context.signal);
      } catch (error) {
        if (!(error instanceof DeltaExpiredError) || !("link" in from)) throw error;
        from = { sinceMs: newestMs };
        mail.length = 0;
        unreadable = 0;
        continue;
      }
      pages += 1;
      // Called off between two pages: no further page is asked for.
      if (!context.alive()) return null;
      mail.push(...page.mail);
      unreadable += page.unreadable;
      if (!page.more || pages >= OUTLOOK_MAX_PAGES) {
        return { mail, unreadable, pages, link: page.link };
      }
      from = { link: page.link };
    }
  }

  async #pollOnce(context: PollContext): Promise<PollSummary> {
    const { accountId, cursors } = this.#options;
    const nowMs = this.#now();
    const stored = cursors.get(accountId);
    const known = stored !== undefined && isDeltaLink(stored.link) ? stored : undefined;
    const newestMs = known?.newestMs ?? nowMs;
    const rounded = known === undefined || nowMs - known.roundMs >= OUTLOOK_ROUND_MS;
    const start: GraphDeltaFrom = rounded ? { sinceMs: newestMs } : { link: known.link };
    this.#consumerErrors = 0;

    let read;
    try {
      read = await this.#read(context, start, newestMs);
    } catch (error) {
      if (!(error instanceof DeltaTooLargeError)) throw error;
      // A page too big to read never gets smaller: start from now and say that mail was not announced.
      const fresh = await this.#options.client.delta({ sinceMs: nowMs }, context.signal);
      if (context.alive()) {
        cursors.set(accountId, { link: fresh.link, newestMs: nowMs, roundMs: nowMs });
        this.#gap("too-large");
      }
      return { outcome: "gap", pages: 1, found: 0, announced: 0, consumerErrors: 0 };
    }
    if (read === null)
      return { outcome: "ok", pages: 0, found: 0, announced: 0, consumerErrors: 0 };

    const floor = newestMs - OUTLOOK_LATE_MS;
    // Ids repeat within a poll too: Microsoft says one change can come more than once.
    const byId = new Map<string, GraphMail>();
    for (const mail of read.mail) {
      if (mail.receivedMs >= floor && !this.#announced.has(mail.id)) byId.set(mail.id, mail);
    }
    // The order of a delta is not guaranteed: the newest `maxPerDrain` are announced, the older ones are counted.
    const fresh = [...byId.values()].sort((a, b) => a.receivedMs - b.receivedMs);
    const skipped = Math.max(0, fresh.length - this.#maxPerDrain);
    for (const mail of fresh.slice(skipped)) this.#announce(mail);
    for (const mail of fresh) this.#remember(mail.id);

    // A time from the future must not raise the floor over real mail: nothing newer than this device's clock is believed.
    const newest = read.mail.reduce((best, mail) => Math.max(best, mail.receivedMs), newestMs);
    cursors.set(accountId, {
      link: read.link,
      newestMs: Math.min(newest, Math.max(newestMs, nowMs)),
      roundMs: rounded ? nowMs : known.roundMs,
    });
    if (skipped > 0) this.#overflow(skipped);
    if (read.unreadable > 0) this.#gap("unreadable");
    const gapped = skipped > 0 || read.unreadable > 0;
    return {
      outcome: gapped ? "gap" : known === undefined ? "first" : "ok",
      pages: read.pages,
      found: fresh.length,
      announced: fresh.length - skipped,
      consumerErrors: this.#consumerErrors,
    };
  }
}
