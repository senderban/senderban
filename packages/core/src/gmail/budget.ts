import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode } from "../adapter.js";
import { FilterExistsError } from "./client.js";
import type { GmailFilterClient } from "./client.js";
import { MAX_ACCOUNTS } from "../sync/engine.js";

/**
 * Quota units Google charges per call (Gmail API usage limits, read 2026-10-26; the counting fake charges the same and a test
 * holds the two together). Unit: quota units.
 */
export const GMAIL_UNITS = { list: 1, create: 5, delete: 5 } as const;

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

export type GmailLimit = "minute" | "account-day" | "all-accounts-day";

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
}
export const GMAIL_LIMITS: GmailLimits = {
  perMinute: GMAIL_UNITS_PER_MINUTE,
  perAccountDay: GMAIL_UNITS_PER_ACCOUNT_DAY,
  allAccountsDay: GMAIL_UNITS_PER_DAY_ALL,
};

/** What the log may learn about a call: fixed words and numbers, never an address, a filter id, a token or a Google message. */
export type GmailOutcome = "ok" | "gone" | "exists" | AdapterErrorCode;
export type GmailLogEvent =
  | {
      readonly event: "gmail-call";
      readonly account: string;
      readonly op: keyof typeof GMAIL_UNITS;
      readonly outcome: GmailOutcome;
      readonly units: number;
      readonly ms: number;
    }
  | {
      readonly event: "gmail-budget";
      readonly account: string;
      readonly op: keyof typeof GMAIL_UNITS;
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
}

function checkLimits(limits: GmailLimits): void {
  for (const value of [limits.perMinute, limits.perAccountDay, limits.allAccountsDay]) {
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError("a Gmail limit must be a whole number of units, 1 or more");
  }
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

  constructor(options: { readonly limits?: GmailLimits; readonly now?: () => number } = {}) {
    this.#limits = options.limits ?? GMAIL_LIMITS;
    checkLimits(this.#limits);
    this.#now = options.now ?? Date.now;
    this.#all = new Rolling(HOUR_MS, 24, this.#now);
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

  /** Reserves `units` for one call, or throws the limit that is reached; either all three windows take it or none does. */
  charge(account: string, units: number): void {
    // NaN passes every `>` check and a negative number refunds: either would switch a window off for good.
    if (!Number.isInteger(units) || units < 1)
      throw new RangeError("units must be a whole number, 1 or more");
    const windows = this.#windows(account);
    const checks: [GmailLimit, Rolling, number][] = [
      ["minute", windows.minute, this.#limits.perMinute],
      ["account-day", windows.day, this.#limits.perAccountDay],
      ["all-accounts-day", this.#all, this.#limits.allAccountsDay],
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

  /**
   * The client with this budget in front of it: every call is paid for before it is sent (a call that fails still costs
   * Google quota, so it is paid either way) and written to `log` as a fixed event. `account` is the tag the log uses for the
   * account and must look like one (`accountTag`, never an address); `key` names its counters.
   */
  wrap(
    client: GmailFilterClient,
    options: {
      readonly key: string;
      readonly account: string;
      readonly log?: (event: GmailLogEvent) => void;
      /** Whether every call is logged, or only the refusals (default: every call). The app logs the HTTP status itself. */
      readonly logCalls?: boolean;
    },
  ): GmailFilterClient {
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
    const run = async <T>(
      op: keyof typeof GMAIL_UNITS,
      call: () => Promise<T>,
      outcomeOf: (value: T) => GmailOutcome,
    ): Promise<T> => {
      try {
        this.charge(options.key, GMAIL_UNITS[op]);
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
          units: GMAIL_UNITS[op],
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
          units: GMAIL_UNITS[op],
          ms: Math.max(0, this.#now() - started),
        });
        throw error;
      }
    };
    return {
      list: (signal) =>
        run(
          "list",
          () => client.list(signal),
          () => "ok",
        ),
      create: (query, signal) =>
        run(
          "create",
          () => client.create(query, signal),
          () => "ok",
        ),
      remove: (id, signal) =>
        run(
          "delete",
          () => client.remove(id, signal),
          (value) => (value === "gone" ? "gone" : "ok"),
        ),
    };
  }
}
