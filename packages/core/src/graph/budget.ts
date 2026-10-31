import { AdapterError } from "../adapter.js";
import { Rolling } from "../rolling.js";
import { MAX_ACCOUNTS } from "../sync/engine.js";
import type { GraphRuleClient } from "./client.js";

/**
 * Requests one account may make in a minute. Unit: requests. An `uninstall` of the most rules a lane holds (GRAPH_MAX_RULES = 200)
 * is a list and 200 deletes, and fits. Outlook's own wall is 10,000 requests in 10 minutes per app and mailbox
 * (https://learn.microsoft.com/en-us/graph/throttling-limits, read 2026-10-31): this line is 3,000 of them, so a loop stops here first.
 */
export const GRAPH_REQUESTS_PER_MINUTE = 300;
/**
 * Requests one account may make in 24 hours. Unit: requests. A first import of 5,000 addresses is 50 rules, about 60 requests, and
 * 50 block changes a day are about 100, so this is thirty times what honest use needs.
 */
export const GRAPH_REQUESTS_PER_ACCOUNT_DAY = 5_000;
/**
 * Requests all Microsoft accounts of this app together may make in 24 hours. Unit: requests. At 50 accounts (MAX_ACCOUNTS) of 1,000
 * each, the busy case, that is 50,000, so this is twice that: one runaway account stops at its own line, a bug that runs on every
 * account at this one.
 */
export const GRAPH_REQUESTS_PER_DAY_ALL = 100_000;

export type GraphLimit = "minute" | "account-day" | "all-accounts-day";
export type GraphOp = "junk" | "list" | "create" | "update" | "delete";

/** Our own limit was reached, before any request left. A `QUOTA_EXCEEDED`, so the adapter treats it as a rate limit. */
export class GraphBudgetError extends AdapterError {
  readonly limit: GraphLimit;
  readonly used: number;
  readonly cap: number;
  constructor(limit: GraphLimit, used: number, cap: number) {
    super("QUOTA_EXCEEDED", `Senderban's own Microsoft limit is reached (${limit}), later`);
    this.name = "GraphBudgetError";
    this.limit = limit;
    this.used = used;
    this.cap = cap;
  }
}

export interface GraphLimits {
  readonly perMinute: number;
  readonly perAccountDay: number;
  readonly allAccountsDay: number;
}
export const GRAPH_LIMITS: GraphLimits = {
  perMinute: GRAPH_REQUESTS_PER_MINUTE,
  perAccountDay: GRAPH_REQUESTS_PER_ACCOUNT_DAY,
  allAccountsDay: GRAPH_REQUESTS_PER_DAY_ALL,
};

/** What the log may learn about a refusal: fixed words and numbers, never an address, a rule id or a token. */
export interface GraphBudgetEvent {
  readonly event: "graph-budget";
  readonly account: string;
  readonly op: GraphOp;
  readonly limit: GraphLimit;
  readonly used: number;
  readonly cap: number;
}

const HOUR_MS = 3_600_000;

interface AccountWindows {
  readonly minute: Rolling;
  readonly day: Rolling;
}

export interface GraphWrapOptions {
  readonly key: string;
  /** The tag the log uses for the account, never an address. */
  readonly account: string;
  readonly log?: (event: GraphBudgetEvent) => void;
}

/**
 * The three client-side limits of the Microsoft lane (global CLAUDE.md item 7): a per-minute cap and a 24-hour quota per account, and
 * one daily ceiling for all accounts. ONE per app. The counters are in memory: a restart begins them again, and Outlook's wall stays.
 */
export class GraphBudgets {
  readonly #limits: GraphLimits;
  readonly #now: () => number;
  readonly #accounts = new Map<string, AccountWindows>();
  readonly #all: Rolling;

  constructor(options: { readonly limits?: GraphLimits; readonly now?: () => number } = {}) {
    this.#limits = options.limits ?? GRAPH_LIMITS;
    this.#now = options.now ?? Date.now;
    this.#all = new Rolling(HOUR_MS, 24, this.#now);
  }

  #windows(account: string): AccountWindows {
    const found = this.#accounts.get(account);
    if (found !== undefined) return found;
    // Bounded like every other per-account structure: more accounts than the app allows is a bug, not growth.
    if (this.#accounts.size >= MAX_ACCOUNTS)
      throw new AdapterError("REJECTED", "too many Microsoft accounts for the budget");
    const created = {
      minute: new Rolling(1_000, 60, this.#now),
      day: new Rolling(HOUR_MS, 24, this.#now),
    };
    this.#accounts.set(account, created);
    return created;
  }

  /** The account's counters are dropped (account removed for good). */
  forget(account: string): void {
    this.#accounts.delete(account);
  }

  /** Reserves one request, or throws the limit that is reached; all three windows take it or none does. */
  charge(account: string): void {
    const windows = this.#windows(account);
    const checks: [GraphLimit, Rolling, number][] = [
      ["minute", windows.minute, this.#limits.perMinute],
      ["account-day", windows.day, this.#limits.perAccountDay],
      ["all-accounts-day", this.#all, this.#limits.allAccountsDay],
    ];
    for (const [limit, window, cap] of checks) {
      const used = window.used();
      if (used + 1 > cap) throw new GraphBudgetError(limit, used, cap);
    }
    for (const [, window] of checks) window.add(1);
  }

  /** The rule client with this budget in front of it. Each call is paid before it is sent: a call that fails still counts at Outlook. */
  wrap(client: GraphRuleClient, options: GraphWrapOptions): GraphRuleClient {
    const pay = (op: GraphOp): void => {
      try {
        this.charge(options.key);
      } catch (error) {
        if (error instanceof GraphBudgetError) {
          try {
            options.log?.({
              event: "graph-budget",
              account: options.account,
              op,
              limit: error.limit,
              used: error.used,
              cap: error.cap,
            });
          } catch {
            // a log must not break a call
          }
        }
        throw error;
      }
    };
    return {
      junkFolderId: async (signal) => {
        pay("junk");
        return client.junkFolderId(signal);
      },
      list: async (signal) => {
        pay("list");
        return client.list(signal);
      },
      create: async (rule, signal) => {
        pay("create");
        return client.create(rule, signal);
      },
      update: async (id, conditions, signal) => {
        pay("update");
        return client.update(id, conditions, signal);
      },
      remove: async (id, signal) => {
        pay("delete");
        return client.remove(id, signal);
      },
    };
  }
}
