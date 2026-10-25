import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode, BlockAdapter, Drift, OpaqueState } from "../adapter.js";
import { MAX_CONCURRENT_SYNCS, createGate } from "../gate.js";
import type { Gate } from "../gate.js";
import type { Store } from "../store/store.js";

/**
 * Accounts one device syncs. Each one is an independent queue (architecture K8), but provider rounds share
 * one gate (MAX_CONCURRENT_SYNCS): a block on 50 accounts opens 50 ManageSieve connections one wave of 5 at a time.
 */
export const MAX_ACCOUNTS = 50;
export const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,64}$/;

export const DEFAULT_DEBOUNCE_MS = 2_000;
/** One provider round (plan is local; this bounds `apply`). Longer means the provider is stuck. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * A sync that failed for a reason that can pass (network, provider hiccup) is tried again, so a rule
 * the person removed does not stay on one account until some unrelated block triggers a sync.
 * Budget: at the cap the delay is 15-30 min, so 2-4 attempts/hour/account (one ManageSieve
 * connection each); at most 200/hour at MAX_ACCOUNTS, and only for accounts that still have a difference to apply.
 */
export const DEFAULT_RETRY = { baseMs: 30_000, maxMs: 1_800_000 } as const;
/** Whether the engine tries a failed sync again by itself; false means the person has to act. */
export function willRetry(code: AdapterErrorCode | "UNKNOWN"): boolean {
  return !PERMANENT.has(code);
}

/** Retrying these cannot help (wrong password, unsupported rule, provider says no) and risks a lockout. */
const PERMANENT: ReadonlySet<string> = new Set([
  "AUTH_REQUIRED",
  "CAPABILITY_NOT_SUPPORTED",
  "REJECTED",
  "QUOTA_EXCEEDED",
]);

export interface EngineAccount {
  readonly id: string;
  readonly adapter: BlockAdapter;
  /** State used the first time this account is synced, before the store has any. */
  readonly initialState: OpaqueState;
}

export interface FailedOutcome {
  readonly accountId: string;
  readonly status: "failed";
  readonly code: AdapterErrorCode | "UNKNOWN";
  readonly message: string;
}

export type SyncOutcome =
  | { readonly accountId: string; readonly status: "unchanged" }
  | {
      readonly accountId: string;
      readonly status: "applied" | "partial";
      readonly applied: number;
      readonly failed: number;
    }
  | FailedOutcome;

export type VerifyOutcome =
  | { readonly accountId: string; readonly status: "verified" }
  | { readonly accountId: string; readonly status: "drifted"; readonly detail: string }
  | FailedOutcome;

export interface RecoveryReport {
  readonly accountId: string;
  /** Journal rows that were still open from the dead process. */
  readonly interrupted: number;
  /** Absent when the account is no longer registered. */
  readonly outcome?: SyncOutcome;
  /** Read-back after the repair sync; absent if the sync failed or verify threw. */
  readonly drift?: Drift;
  readonly verifyError?: string;
}

export interface EngineOptions {
  readonly debounceMs?: number;
  readonly timeoutMs?: number;
  readonly onOutcome?: (outcome: SyncOutcome) => void;
  readonly retry?: { readonly baseMs: number; readonly maxMs: number };
  /** Provider rounds in flight at once across all accounts (default MAX_CONCURRENT_SYNCS). */
  readonly maxConcurrent?: number;
  /** Injectable for tests; returns [0, 1). */
  readonly random?: () => number;
}

interface Lane {
  running: Promise<SyncOutcome> | null;
  /** At most one follow-up waits; it reads the list when it starts, so it covers every change since. */
  queued: Promise<SyncOutcome> | null;
  timer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Consecutive failed syncs that a retry may fix; 0 after any sync that did not fail. */
  failures: number;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AdapterError("TRANSIENT", `provider did not answer within ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([work, limit]).finally(() => {
    clearTimeout(timer);
  });
}

function failure(accountId: string, error: unknown): FailedOutcome {
  const message = error instanceof Error ? error.message : "unknown error";
  return {
    accountId,
    status: "failed",
    code: error instanceof AdapterError ? error.code : "UNKNOWN",
    message: message.slice(0, 500),
  };
}

/**
 * Drives `list -> adapter.plan -> journal -> adapter.apply -> journal` for every account. A failing
 * account never delays another: each has its own lane, and the engine itself never throws on a
 * provider error (it returns a `failed` outcome).
 */
export class SyncEngine {
  readonly #store: Store;
  readonly #accounts = new Map<string, EngineAccount>();
  readonly #lanes = new Map<string, Lane>();
  readonly #debounceMs: number;
  readonly #timeoutMs: number;
  readonly #onOutcome: ((outcome: SyncOutcome) => void) | undefined;
  readonly #retry: { readonly baseMs: number; readonly maxMs: number };
  readonly #random: () => number;
  readonly #gate: Gate;
  #disposed = false;

  constructor(store: Store, options: EngineOptions = {}) {
    this.#store = store;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onOutcome = options.onOutcome;
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.#random = options.random ?? Math.random;
    this.#gate = createGate(options.maxConcurrent ?? MAX_CONCURRENT_SYNCS);
  }

  addAccount(account: EngineAccount): void {
    if (!ACCOUNT_ID.test(account.id)) throw new Error("invalid account id");
    if (this.#accounts.has(account.id)) throw new Error(`account ${account.id} already added`);
    if (this.#accounts.size >= MAX_ACCOUNTS) {
      throw new Error(`at most ${String(MAX_ACCOUNTS)} accounts per device`);
    }
    this.#accounts.set(account.id, account);
    this.#lanes.set(account.id, {
      running: null,
      queued: null,
      timer: null,
      retryTimer: null,
      failures: 0,
    });
  }

  /** Waits for any sync already running, then syncs once more so the latest list is covered. */
  sync(accountId: string): Promise<SyncOutcome> {
    const lane = this.#lanes.get(accountId);
    if (lane === undefined)
      return Promise.resolve(failure(accountId, new Error("unknown account")));

    if (lane.running === null) {
      lane.running = this.#run(accountId).finally(() => {
        lane.running = null;
      });
      return lane.running;
    }
    lane.queued ??= lane.running.then(() => {
      lane.queued = null;
      return this.sync(accountId);
    });
    return lane.queued;
  }

  /** Reads the provider back: did the rule we wrote land and is it still active? Never throws. */
  async verify(accountId: string): Promise<VerifyOutcome> {
    const account = this.#accounts.get(accountId);
    if (account === undefined) return failure(accountId, new Error("unknown account"));
    try {
      const state = this.#store.getState(accountId) ?? account.initialState;
      const drift = await this.#gate(() =>
        withTimeout(account.adapter.verify(state), this.#timeoutMs),
      );
      return drift.drifted
        ? { accountId, status: "drifted", detail: drift.detail.slice(0, 500) }
        : { accountId, status: "verified" };
    } catch (error) {
      return failure(accountId, error);
    }
  }

  syncAll(): Promise<SyncOutcome[]> {
    return Promise.all([...this.#accounts.keys()].map((id) => this.sync(id)));
  }

  /** Call after the list changed: collapses a burst of edits into one sync per account. */
  requestSync(accountId?: string): void {
    for (const id of accountId === undefined ? this.#accounts.keys() : [accountId]) {
      const lane = this.#lanes.get(id);
      if (lane === undefined) continue;
      if (lane.timer !== null) clearTimeout(lane.timer);
      lane.timer = setTimeout(() => {
        lane.timer = null;
        void this.sync(id);
      }, this.#debounceMs);
    }
  }

  /**
   * Call once at start, after the accounts are added. Syncs again every account that died mid-sync
   * (planning from stored state is idempotent: adapters recognise an already-written remote), then
   * reads the provider back.
   */
  async recover(): Promise<RecoveryReport[]> {
    const counts = new Map<string, number>();
    for (const row of this.#store.recoverInterrupted()) {
      counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
    }
    return Promise.all(
      [...counts].map(async ([accountId, interrupted]): Promise<RecoveryReport> => {
        const account = this.#accounts.get(accountId);
        if (account === undefined) return { accountId, interrupted };

        const outcome = await this.sync(accountId);
        if (outcome.status === "failed") return { accountId, interrupted, outcome };
        try {
          const state = this.#store.getState(accountId) ?? account.initialState;
          const drift = await this.#gate(() =>
            withTimeout(account.adapter.verify(state), this.#timeoutMs),
          );
          return { accountId, interrupted, outcome, drift };
        } catch (error) {
          const verifyError = failure(accountId, error);
          return {
            accountId,
            interrupted,
            outcome,
            verifyError: verifyError.message,
          };
        }
      }),
    );
  }

  /** Cancels pending debounce timers; running syncs finish on their own. */
  dispose(): void {
    this.#disposed = true;
    for (const lane of this.#lanes.values()) {
      if (lane.timer !== null) clearTimeout(lane.timer);
      lane.timer = null;
      if (lane.retryTimer !== null) clearTimeout(lane.retryTimer);
      lane.retryTimer = null;
    }
  }

  /** Capped exponential backoff with equal jitter, so accounts that failed together do not retry in lockstep. */
  #scheduleRetry(accountId: string, outcome: SyncOutcome): void {
    const lane = this.#lanes.get(accountId);
    if (lane === undefined) return;
    if (lane.retryTimer !== null) clearTimeout(lane.retryTimer);
    lane.retryTimer = null;
    if (outcome.status !== "failed") {
      lane.failures = 0;
      return;
    }
    if (this.#disposed || !willRetry(outcome.code)) return;

    lane.failures += 1;
    const ceiling = Math.min(this.#retry.maxMs, this.#retry.baseMs * 2 ** (lane.failures - 1));
    const delay = Math.round(ceiling / 2 + (ceiling / 2) * this.#random());
    lane.retryTimer = setTimeout(() => {
      lane.retryTimer = null;
      void this.sync(accountId);
    }, delay);
  }

  async #run(accountId: string): Promise<SyncOutcome> {
    // The gate holds the round, not the lane: `running` includes the wait for a slot, and later calls queue
    // one follow-up behind it. A round still waiting when the engine is disposed never touches the provider
    // (shutdown closes the store right after).
    const { outcome, skipped } = await this.#gate(async () =>
      this.#disposed
        ? { outcome: failure(accountId, new Error("engine disposed")), skipped: true }
        : { outcome: await this.#attempt(accountId), skipped: false },
    );
    if (skipped) return outcome;
    this.#scheduleRetry(accountId, outcome);
    try {
      this.#onOutcome?.(outcome);
    } catch {
      // a listener must not break the lane
    }
    return outcome;
  }

  async #attempt(accountId: string): Promise<SyncOutcome> {
    const account = this.#accounts.get(accountId);
    if (account === undefined) return failure(accountId, new Error("unknown account"));

    let seq: number | null = null;
    try {
      const state = this.#store.getState(accountId) ?? account.initialState;
      // The Sieve plan is local, but an adapter may read the provider while planning; a deadline keeps a stuck
      // read from holding a slot for good.
      const plan = await withTimeout(
        account.adapter.plan(this.#store.list(), state),
        this.#timeoutMs,
      );
      if (plan.changes.length === 0) return { accountId, status: "unchanged" };

      seq = this.#store.beginSync(plan);
      const result = await withTimeout(account.adapter.apply(plan), this.#timeoutMs);
      this.#store.completeSync(seq, accountId, result);
      return {
        accountId,
        status: result.failed.length === 0 ? "applied" : "partial",
        applied: result.applied,
        failed: result.failed.length,
      };
    } catch (error) {
      const outcome = failure(accountId, error);
      if (seq !== null) {
        this.#store.failSync(seq, accountId, `${outcome.code}: ${outcome.message}`);
      }
      return outcome;
    }
  }
}
