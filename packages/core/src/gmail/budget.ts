import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode } from "../adapter.js";
import { FilterExistsError } from "./client.js";
import type { GmailFilterClient } from "./client.js";
import type { GmailMailClient } from "./mail-client.js";
import { MAX_ACCOUNTS } from "../sync/engine.js";

/**
 * Quota units Google charges per call (Gmail API usage limits, read 2026-10-26; the counting fake charges the same and a test
 * holds the two together). Unit: quota units.
 */
export const GMAIL_UNITS = { list: 1, create: 5, delete: 5 } as const;
/** The same for reading new mail (`getProfile`, `history.list`, `messages.get`; read 2026-10-26, the counting fake charges the same). Unit: quota units. */
export const GMAIL_MAIL_UNITS = { profile: 1, history: 2, message: 20 } as const;

/**
 * Units one account may spend on filter calls in a minute. Unit: quota units. A usual round is one `list` and 10 rewrites
 * of a `create` and a `delete` = 101 units (about nine rounds), and one `uninstall` of the most filters this lane holds
 * (GMAIL_MAX_FILTERS = 200: a `list` and 200 deletes = 1,001) fits in one go. Google gives a user 6,000 a minute, so a loop that
 * hits this has used 18% of what Google would have allowed and is stopped here first (ADR 0009 "Budget lines").
 */
export const GMAIL_UNITS_PER_MINUTE = 1_100;
/**
 * Units one account may spend on filter calls in 24 hours. Unit: quota units. A first import of 5,000 addresses is 100 filters =
 * 10 rounds = about 1,010 units and 50 block changes a day are about 600, so this is about three times what honest use needs.
 * The mail poll has its own line (2,880 a day, watcher step): this one is for the filter lane only.
 */
export const GMAIL_UNITS_PER_ACCOUNT_DAY = 5_000;
/**
 * Units all Gmail accounts of this app together may spend on filter calls in 24 hours. Unit: quota units. At 50 accounts
 * (MAX_ACCOUNTS) of 1,000 each, the busy case, that is 50,000, so this is twice that: one runaway account is stopped by its
 * own line first, a bug that runs on every account by this one. The project's own quota is 1.2 M units a minute.
 */
export const GMAIL_UNITS_PER_DAY_ALL = 100_000;

/**
 * Units one account may spend on POLLING for new mail in 24 hours (`profile`, `history.list`). Unit: quota units. One
 * `history.list` a minute is 1,440 calls = 2,880 units, and a window of 24 hourly buckets plus the running one can hold up to 25
 * hours of it (3,000); 3,600 leaves 20% for extra pages and first-run profiles. The poll has a line of its own so that a flood of
 * mail cannot silence it (review W3, 2026-10-27: on one shared 4,500 line only 75 to 81 mails a day fit, and past that the poll itself
 * stopped). PROVISIONAL.
 */
export const GMAIL_POLL_UNITS_PER_ACCOUNT_DAY = 3_600;
/**
 * Units all Gmail accounts together may spend on polling in 24 hours. Unit: quota units. 50 accounts (MAX_ACCOUNTS) at 3,600 are
 * 180,000; the ceiling is 200,000, so one runaway account stops at its own line and a bug that runs on every account stops here.
 */
export const GMAIL_POLL_UNITS_PER_DAY_ALL = 200_000;
/**
 * Units one account may spend on READING new mail (`messages.get`, 20 each) in 24 hours. Unit: quota units. 6,000 is 300 mails a
 * day: six times the assumed 50, an ordinary busy inbox, and 0.07% of what Google allows a user in a day (6,000 a minute). When it
 * fills, mail is read later (the cursor holds and the watcher backs off) while the poll goes on. PROVISIONAL: real volume not measured.
 */
export const GMAIL_READ_UNITS_PER_ACCOUNT_DAY = 6_000;
/**
 * Units all Gmail accounts together may spend on reading mail in 24 hours. Unit: quota units. 150,000 is 7,500 mails: 150 a day on
 * each of 50 accounts. It is the brake for a bug that runs on every account; the per-account lines are the usual one. PROVISIONAL.
 */
export const GMAIL_READ_UNITS_PER_DAY_ALL = 150_000;

export type GmailLimit =
  | "minute"
  | "account-day"
  | "all-accounts-day"
  | "poll-account-day"
  | "poll-all-accounts-day"
  | "read-account-day"
  | "read-all-accounts-day";
/**
 * Which lane a call is paid on: the minute line is shared, the 24-hour lines are not. `poll` is `profile` and `history.list`,
 * `read` is `messages.get`.
 */
export type GmailLane = "filters" | "poll" | "read";
export type GmailOp = keyof typeof GMAIL_UNITS | keyof typeof GMAIL_MAIL_UNITS;

/** Our own limit was reached, before any request left. A `QUOTA_EXCEEDED`, so the adapter and the engine treat it as a rate limit. */
export class GmailBudgetError extends AdapterError {
  readonly limit: GmailLimit;
  /** Units spent in that window and its cap, for the log. */
  readonly used: number;
  readonly cap: number;
  constructor(limit: GmailLimit, used: number, cap: number) {
    super("QUOTA_EXCEEDED", `Senderban's own Gmail limit is reached (${limit}), later`);
    this.name = "GmailBudgetError";
    this.limit = limit;
    this.used = used;
    this.cap = cap;
  }
}

export interface GmailLimits {
  readonly perMinute: number;
  readonly perAccountDay: number;
  readonly allAccountsDay: number;
  readonly pollPerAccountDay: number;
  readonly pollAllAccountsDay: number;
  readonly readPerAccountDay: number;
  readonly readAllAccountsDay: number;
}
export const GMAIL_LIMITS: GmailLimits = {
  perMinute: GMAIL_UNITS_PER_MINUTE,
  perAccountDay: GMAIL_UNITS_PER_ACCOUNT_DAY,
  allAccountsDay: GMAIL_UNITS_PER_DAY_ALL,
  pollPerAccountDay: GMAIL_POLL_UNITS_PER_ACCOUNT_DAY,
  pollAllAccountsDay: GMAIL_POLL_UNITS_PER_DAY_ALL,
  readPerAccountDay: GMAIL_READ_UNITS_PER_ACCOUNT_DAY,
  readAllAccountsDay: GMAIL_READ_UNITS_PER_DAY_ALL,
};

/** What the log may learn about a call: fixed words and numbers, never an address, a filter id, a token or a Google message. */
export type GmailOutcome = "ok" | "gone" | "exists" | AdapterErrorCode;
export type GmailLogEvent =
  | {
      readonly event: "gmail-call";
      readonly account: string;
      readonly op: GmailOp;
      readonly outcome: GmailOutcome;
      readonly units: number;
      readonly ms: number;
    }
  | {
      readonly event: "gmail-budget";
      readonly account: string;
      readonly op: GmailOp;
      readonly limit: GmailLimit;
      readonly used: number;
      readonly cap: number;
    };

const HOUR_MS = 3_600_000;
/** What the log may call an account: `accountTag` makes `acct-` and eight hex digits. Unit: characters, 1 to 64. */
const ACCOUNT_TAG = /^[a-z0-9-]{1,64}$/u;

/**
 * Units spent in the last `buckets` buckets, in memory bounded by the bucket count whatever the traffic (60 for a minute, 24
 * for a day). The window is `buckets` buckets plus the one running, so it always covers at least the whole period and over-counts
 * by up to one bucket: the safe side for a cap.
 */
class Rolling {
  readonly #spent = new Map<number, number>();
  readonly #bucketMs: number;
  readonly #buckets: number;
  readonly #now: () => number;
  #elapsed = 0;
  #seen: number | null = null;

  constructor(bucketMs: number, buckets: number, now: () => number) {
    this.#bucketMs = bucketMs;
    this.#buckets = buckets;
    this.#now = now;
  }

  /** The window's own clock: it moves by the forward steps of the wall clock only, so a clock set back neither un-spends nor locks. */
  #current(): number {
    const t = this.#now();
    if (this.#seen !== null) this.#elapsed += Math.max(0, t - this.#seen);
    this.#seen = t;
    return Math.floor(this.#elapsed / this.#bucketMs);
  }

  used(): number {
    const current = this.#current();
    let total = 0;
    for (const [index, units] of this.#spent) {
      if (index < current - this.#buckets) this.#spent.delete(index);
      else total += units;
    }
    return total;
  }

  add(units: number): void {
    const current = this.#current();
    this.#spent.set(current, (this.#spent.get(current) ?? 0) + units);
  }
}

interface AccountWindows {
  readonly minute: Rolling;
  readonly day: Rolling;
  readonly pollDay: Rolling;
  readonly readDay: Rolling;
}

function checkLimits(limits: GmailLimits): void {
  for (const value of [
    limits.perMinute,
    limits.perAccountDay,
    limits.allAccountsDay,
    limits.pollPerAccountDay,
    limits.pollAllAccountsDay,
    limits.readPerAccountDay,
    limits.readAllAccountsDay,
  ]) {
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError("a Gmail limit must be a whole number of units, 1 or more");
  }
}

export interface WrapOptions {
  readonly key: string;
  readonly account: string;
  readonly log?: (event: GmailLogEvent) => void;
  /** Whether every call is logged, or only the refusals (default: every call). The app logs the HTTP status itself. */
  readonly logCalls?: boolean;
}

/**
 * The three client-side limits for the Gmail filter lane (ADR 0009 "Budget lines", global CLAUDE.md item 7): a per-minute cap and a
 * 24-hour quota per account, and one daily ceiling for all accounts together. There is ONE of these per app; it keeps the
 * counters, so a client made again for a round (or an account re-added) must come from here, not start from zero.
 * The counters are in memory: a restart begins them again (Google's own 6,000 units a minute per user stays the wall).
 */
export class GmailBudgets {
  readonly #limits: GmailLimits;
  readonly #now: () => number;
  readonly #accounts = new Map<string, AccountWindows>();
  readonly #all: Rolling;
  readonly #allPoll: Rolling;
  readonly #allRead: Rolling;

  constructor(options: { readonly limits?: GmailLimits; readonly now?: () => number } = {}) {
    this.#limits = options.limits ?? GMAIL_LIMITS;
    checkLimits(this.#limits);
    this.#now = options.now ?? Date.now;
    this.#all = new Rolling(HOUR_MS, 24, this.#now);
    this.#allPoll = new Rolling(HOUR_MS, 24, this.#now);
    this.#allRead = new Rolling(HOUR_MS, 24, this.#now);
  }

  #windows(account: string): AccountWindows {
    const found = this.#accounts.get(account);
    if (found !== undefined) return found;
    // Bounded like every other per-account structure: more accounts than the app allows is a bug, not growth.
    if (this.#accounts.size >= MAX_ACCOUNTS)
      throw new AdapterError("REJECTED", "too many Gmail accounts for the budget");
    const created = {
      minute: new Rolling(1_000, 60, this.#now),
      day: new Rolling(HOUR_MS, 24, this.#now),
      pollDay: new Rolling(HOUR_MS, 24, this.#now),
      readDay: new Rolling(HOUR_MS, 24, this.#now),
    };
    this.#accounts.set(account, created);
    return created;
  }

  /**
   * The account's counters are dropped (account removed for good). Removing and adding the same account again therefore starts
   * its minute and day from zero: that costs a whole sign-in, so it is not a way round the limit.
   */
  forget(account: string): void {
    this.#accounts.delete(account);
  }

  /**
   * Reserves `units` for one call, or throws the limit that is reached; either all three windows take it or none does. The minute
   * window is the account's own and shared by both lanes; the two 24-hour windows belong to the lane the call is paid on.
   */
  charge(account: string, units: number, lane: GmailLane = "filters"): void {
    // NaN passes every `>` check and a negative number refunds: either would switch a window off for good.
    if (!Number.isInteger(units) || units < 1)
      throw new RangeError("units must be a whole number, 1 or more");
    const windows = this.#windows(account);
    const checks: [GmailLimit, Rolling, number][] =
      lane === "filters"
        ? [
            ["minute", windows.minute, this.#limits.perMinute],
            ["account-day", windows.day, this.#limits.perAccountDay],
            ["all-accounts-day", this.#all, this.#limits.allAccountsDay],
          ]
        : lane === "poll"
          ? [
              ["minute", windows.minute, this.#limits.perMinute],
              ["poll-account-day", windows.pollDay, this.#limits.pollPerAccountDay],
              ["poll-all-accounts-day", this.#allPoll, this.#limits.pollAllAccountsDay],
            ]
          : [
              ["minute", windows.minute, this.#limits.perMinute],
              ["read-account-day", windows.readDay, this.#limits.readPerAccountDay],
              ["read-all-accounts-day", this.#allRead, this.#limits.readAllAccountsDay],
            ];
    for (const [limit, window, cap] of checks) {
      const used = window.used();
      if (used + units > cap) throw new GmailBudgetError(limit, used, cap);
    }
    for (const [, window] of checks) window.add(units);
  }

  /** Units left in each window, for the log and for tests. */
  remaining(account: string): { minute: number; accountDay: number; allAccountsDay: number } {
    const windows = this.#windows(account);
    return {
      minute: this.#limits.perMinute - windows.minute.used(),
      accountDay: this.#limits.perAccountDay - windows.day.used(),
      allAccountsDay: this.#limits.allAccountsDay - this.#all.used(),
    };
  }

  /** Units left on the poll lane's two 24-hour lines, for the log and for tests. */
  remainingPoll(account: string): { accountDay: number; allAccountsDay: number } {
    const windows = this.#windows(account);
    return {
      accountDay: this.#limits.pollPerAccountDay - windows.pollDay.used(),
      allAccountsDay: this.#limits.pollAllAccountsDay - this.#allPoll.used(),
    };
  }

  /** Units left on the read lane's two 24-hour lines, for the log and for tests. */
  remainingRead(account: string): { accountDay: number; allAccountsDay: number } {
    const windows = this.#windows(account);
    return {
      accountDay: this.#limits.readPerAccountDay - windows.readDay.used(),
      allAccountsDay: this.#limits.readAllAccountsDay - this.#allRead.used(),
    };
  }

  /**
   * Pays for each call before it is sent (a call that fails still costs Google quota, so it is paid either way) and writes it to
   * `log` as a fixed event. Shared by both clients, so the filter lane and the poll and read lanes cannot drift apart.
   */
  #guard(options: WrapOptions) {
    if (!ACCOUNT_TAG.test(options.account)) {
      throw new RangeError(
        "the log tag of an account is lowercase letters, digits and hyphens only",
      );
    }
    const emit = (event: GmailLogEvent): void => {
      try {
        options.log?.(event);
      } catch {
        // a log must not break a call
      }
    };
    const emitCall = (event: GmailLogEvent): void => {
      if (options.logCalls !== false) emit(event);
    };
    return async <T>(
      op: GmailOp,
      units: number,
      lane: GmailLane,
      call: () => Promise<T>,
      outcomeOf: (value: T) => GmailOutcome,
    ): Promise<T> => {
      try {
        this.charge(options.key, units, lane);
      } catch (error) {
        if (error instanceof GmailBudgetError) {
          emit({
            event: "gmail-budget",
            account: options.account,
            op,
            limit: error.limit,
            used: error.used,
            cap: error.cap,
          });
        }
        throw error;
      }
      const started = this.#now();
      try {
        const value = await call();
        emitCall({
          event: "gmail-call",
          account: options.account,
          op,
          outcome: outcomeOf(value),
          units,
          ms: Math.max(0, this.#now() - started),
        });
        return value;
      } catch (error) {
        const outcome: GmailOutcome =
          error instanceof FilterExistsError
            ? "exists"
            : error instanceof AdapterError
              ? error.code
              : "TRANSIENT";
        emitCall({
          event: "gmail-call",
          account: options.account,
          op,
          outcome,
          units,
          ms: Math.max(0, this.#now() - started),
        });
        throw error;
      }
    };
  }

  /**
   * The filter client with this budget in front of it. `account` is the tag the log uses for the account and must look like
   * one (`accountTag`, never an address); `key` names its counters.
   */
  wrap(client: GmailFilterClient, options: WrapOptions): GmailFilterClient {
    const run = this.#guard(options);
    return {
      list: (signal) =>
        run(
          "list",
          GMAIL_UNITS.list,
          "filters",
          () => client.list(signal),
          () => "ok",
        ),
      create: (query, signal) =>
        run(
          "create",
          GMAIL_UNITS.create,
          "filters",
          () => client.create(query, signal),
          () => "ok",
        ),
      remove: (id, signal) =>
        run(
          "delete",
          GMAIL_UNITS.delete,
          "filters",
          () => client.remove(id, signal),
          (value) => (value === "gone" ? "gone" : "ok"),
        ),
    };
  }

  /** The mail client with this budget in front of it: the same account `key` as the filter client, the poll and read lanes' own 24-hour lines. */
  wrapMail(client: GmailMailClient, options: WrapOptions): GmailMailClient {
    const run = this.#guard(options);
    return {
      profile: (signal) =>
        run(
          "profile",
          GMAIL_MAIL_UNITS.profile,
          "poll",
          () => client.profile(signal),
          () => "ok",
        ),
      history: (startHistoryId, pageToken, signal) =>
        run(
          "history",
          GMAIL_MAIL_UNITS.history,
          "poll",
          () => client.history(startHistoryId, pageToken, signal),
          () => "ok",
        ),
      message: (id, signal) =>
        run(
          "message",
          GMAIL_MAIL_UNITS.message,
          "read",
          () => client.message(id, signal),
          (value) => (value === "gone" ? "gone" : "ok"),
        ),
    };
  }
}
