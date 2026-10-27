// Scale budget: one gate bounds how many provider connections open at once across all accounts. Without it
// start, resume and unpause open one login per account at the same moment (50 accounts = 50 simultaneous
// logins, measured by test/perf/storm.test.ts); with it the work queues FIFO and drains MAX_CONCURRENT per
// slot time. A waiter is added per login or sync round and leaves when its job settles or its epoch is stale,
// so the queue is short-lived; it is not capped, and a stale waiter returns without opening a connection.

/** Runs `work` once a slot is free (FIFO); resolves or rejects with whatever `work` does. */
export type Gate = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * IMAP logins in flight at once (watchers: start, resume, unpause, reconnect). One login takes 1.8-2.2 s
 * (MXroute, 2026-10-24), so 50 accounts drain in about 20 s at 5 slots. 5 is a conservative starting value:
 * no provider's per-IP login threshold has been measured, so it is a constant to tune, not a known limit.
 */
export const MAX_CONCURRENT_LOGINS = 5;
/** Provider sync rounds (ManageSieve plan + apply, verify) in flight at once; same reasoning and same caveat. */
export const MAX_CONCURRENT_SYNCS = 5;

/**
 * Rounds in flight at once on `background` lanes (MXroute blacklist writes). Each runs up to 30 requests under a
 * 60 writes a minute limit per key, so two at a time is already more than the limit lets through; keeping it
 * small leaves the main gate to the clicks of a person.
 */
export const MAX_CONCURRENT_BACKGROUND = 2;

/**
 * Gmail new-mail polls in flight at once, on a gate of their own so a Google outage (every poll waiting out its 15 s request) cannot
 * hold the slots that IMAP logins need. A poll is one to a handful of short requests, so 5 slots carry 50 accounts at one poll a
 * minute if a poll takes under about 6 s. PROVISIONAL: the poll time with many accounts at once is not measured (G6 saw one account).
 */
export const MAX_CONCURRENT_GMAIL_POLLS = 5;

/** Upper bound for a gate: one slot per account at most (kept equal to MAX_ACCOUNTS in sync/engine.ts, a test checks it). */
export const MAX_GATE_SIZE = 50;

/** No limit: what the code did before the gate existed. Used by default and by tests. */
export const unlimited: Gate = (work) => work();

/**
 * First-in first-out semaphore. A slot is handed straight to the next waiter when `work` settles, so the
 * number of running jobs never exceeds `max`, even for a job that throws. `work` must settle (callers
 * give it a deadline); a job that never settles holds its slot for good.
 */
export function createGate(max: number): Gate {
  if (!Number.isInteger(max) || max < 1 || max > MAX_GATE_SIZE) {
    throw new RangeError(`gate size must be an integer from 1 to ${String(MAX_GATE_SIZE)}`);
  }
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}
