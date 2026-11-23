import { willRetry } from "@senderban/core";
import type { BlockEntry, SyncOutcome, VerifyOutcome } from "@senderban/core";
import type { Log } from "./log.js";

// The rules on a mail server can stop running without Senderban: another program makes its own script the active one, or somebody
// edits or deletes ours. A round is planned from what Senderban wrote, not from the server, so nothing notices until the next block.
// This reads the rules back on a schedule, and at once when mail of a blocked sender reaches the Inbox.
//
// Scale budget: unit = Sieve account. One read-back (one ManageSieve login, 3 commands) 2-5 minutes after start and one a day; a leak adds at
// most one an hour per account, a server that could not be reached one more 10-15 minutes later. 10 accounts: about 10 logins a day and 10 at
// start; 50 (MAX_ACCOUNTS): 50 and 50. All of them wait in one line, so never two at once from here, leaks included (`engine.verify` also
// waits for its gate and has its own deadline). A repair is one more round, at most one in 20 hours per account and run. The stored state of an
// account is parsed when its turn comes, never all at once (7.8 ms at 5,000 entries, 390 ms for 50 accounts, measured 2026-11-22). Memory:
// two numbers per account and one place in the line. One timer, unref'd, cleared by `stop()`.

/** A mail that came in this soon after the block may have been ahead of the rule: the debounce plus one 60 s round, doubled. Milliseconds. */
export const RULE_GRACE_MS = 120_000;
/** A leak starts a read-back at most this often per account. Milliseconds. */
export const LEAK_CHECK_EVERY_MS = 3_600_000;
/**
 * Senderban switches its rules back on at most this often per account, so two programs do not fight over one script. Milliseconds: 20 h,
 * under the shortest wait between two scheduled rounds, so that each of them may.
 */
export const REPAIR_EVERY_MS = 72_000_000;
/** The first scheduled read-back after start, drawn from this window so that a start does not add its logins to the watchers'. Milliseconds. */
export const FIRST_CHECK_MS = { min: 120_000, max: 300_000 } as const;
/** The wait between two scheduled rounds. Milliseconds: a day, an hour either way. */
export const NEXT_CHECK_MS = { min: 82_800_000, max: 90_000_000 } as const;
/** The wait before the accounts whose server could not be reached are asked once more. Milliseconds: 10-15 minutes. */
export const RETRY_CHECK_MS = { min: 600_000, max: 900_000 } as const;

/** `earlier`: the mail was there before the rule could be (moved back to the Inbox, or waiting). `leak`: the rule should have taken it. */
export type BlockedArrival = "earlier" | "leak";

/** A mail with no usable delivery time counts as a leak: a rule that does not hold must not be explained away. */
export function blockedArrival(
  entry: Pick<BlockEntry, "createdAt">,
  deliveredAt: number | null,
): BlockedArrival {
  if (deliveredAt === null) return "leak";
  return deliveredAt <= Date.parse(entry.createdAt) + RULE_GRACE_MS ? "earlier" : "leak";
}

/** A mail whose sender may be blocked already. */
export interface ArrivedMail {
  readonly accountId: string;
  readonly uid: number;
  readonly domain: string;
  readonly deliveredAt: number | null;
}

/**
 * What a mail of a blocked sender means before anything is shown. `silent`: older than its block (moved back by the person, or waiting
 * since), so there is nothing to ask. `announce`: not blocked, or a leak, which is also reported to `leak`; its notification still comes.
 */
export function screenBlocked(
  mail: ArrivedMail,
  deps: {
    /** The entry that covers the sender. May throw (a row of the list that cannot be read): the mail is then announced, never lost. */
    readonly covering: () => BlockEntry | null;
    readonly leak: (accountId: string, entryId: string) => void;
    readonly tagOf: (accountId: string) => string;
    readonly log: Log;
  },
): "announce" | "silent" {
  const base = { account: deps.tagOf(mail.accountId), uid: mail.uid };
  let covered: BlockEntry | null;
  try {
    covered = deps.covering();
  } catch (error) {
    deps.log("blocked-arrival", { ...base, result: "error", detail: errorName(error) });
    return "announce";
  }
  if (covered === null) return "announce";
  const arrival = blockedArrival(covered, mail.deliveredAt);
  deps.log("blocked-arrival", {
    ...base,
    domain: mail.domain,
    arrival,
    match: covered.match,
    action: covered.action,
    // Delivered that long after the block; negative: before it.
    afterBlockS:
      mail.deliveredAt === null
        ? null
        : Math.round((mail.deliveredAt - Date.parse(covered.createdAt)) / 1000),
  });
  if (arrival === "earlier") return "silent";
  deps.leak(mail.accountId, covered.id);
  return "announce";
}

export interface RuleCheckDeps {
  /** The accounts that may be read back now: running, signed in, not held for a removal. Empty while paused. Ids only: cheap to ask. */
  readonly accounts: () => readonly string[];
  /** Whether the server should be doing something for this account. Reads its stored state. */
  readonly hasWork: (accountId: string) => boolean;
  /** Whether the last finished round wrote this entry to the account's server. */
  readonly holds: (accountId: string, entryId: string) => boolean;
  readonly verify: (accountId: string) => Promise<VerifyOutcome>;
  /** Writes every rule again and makes sure they run. */
  readonly reinstall: (accountId: string) => Promise<SyncOutcome>;
  /** A read-back that got an answer: whether the blocks of this account run. The list must not go on saying "applied" when they do not. */
  readonly onResult: (accountId: string, running: boolean) => void;
  readonly labelOf: (accountId: string) => string;
  readonly tagOf: (accountId: string) => string;
  readonly notice: (title: string, body: string) => void;
  readonly log: Log;
  readonly now?: () => number;
  /** Injectable for tests; returns [0, 1). */
  readonly random?: () => number;
}

export interface RuleChecks {
  start(): void;
  stop(): void;
  /** Mail of a sender this entry blocks reached this account's Inbox. */
  leak(accountId: string, entryId: string): void;
}

/** Why each failed check stops the blocks, in the person's words. The names are the Sieve adapter's (`verify`). */
const REASON: Readonly<Record<string, string>> = {
  "rules-present": "Senderban's rules are gone from the mail server",
  "rules-unchanged": "Senderban's rules were edited on the mail server",
  "include-active": "another filter script runs on the mail server instead of Senderban's rules",
  "none-active": "no filter script is switched on at the mail server",
  "main-edited": "the filter script that starts Senderban's rules was edited on the mail server",
  "include-removed":
    "the active filter script on the mail server no longer starts Senderban's rules",
  "active-unreadable": "the filter script on the mail server could not be read",
};
/** The one failure that is put right without a click. A script switched off, edited or deleted was meant by somebody. */
const REPAIRABLE = "include-active";

/** What a block click puts right by itself, when it is the only thing wrong. */
const BY_A_BLOCK = new Set(["main-edited", "include-removed"]);

function reasonText(failed: readonly string[]): string {
  const known = failed.flatMap((name) => REASON[name] ?? []);
  if (known.length === 0) return "the rules on the mail server differ";
  const byABlock = failed.length === 1 && BY_A_BLOCK.has(failed[0] ?? "");
  return known.join(", and ") + (byABlock ? " (the next block puts them back)" : "");
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** `unreached`: the server gave no answer and may give one soon. */
type CheckEnd = "done" | "unreached";

export function createRuleChecks(deps: RuleCheckDeps): RuleChecks {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const checkedAt = new Map<string, number>();
  const repairedAt = new Map<string, number>();
  /** Accounts in the line, the one being read included. */
  const waiting = new Set<string>();
  /** The entry a leak was about, for an account in the line: its read-back answers the leak, whatever it was started for. */
  const leaks = new Map<string, string>();
  let line: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  /** A method would do; a function so the compiler does not assume the flag is still false after an await. */
  const isStopped = (): boolean => stopped;
  /** Held for a removal, paused, signed out or gone: what a read-back says about it then is not news about the rules. */
  const isOff = (accountId: string): boolean => stopped || !deps.accounts().includes(accountId);

  const broken = (accountId: string, failed: readonly string[]): void => {
    deps.onResult(accountId, false);
    deps.notice(
      "Some blocks are not working",
      `${deps.labelOf(accountId)}: ${reasonText(failed)}. Check the filters on the mail server, or remove the account under Accounts and add it again.`,
    );
  };

  /** Only when the one thing wrong is that another script runs instead: then a block click would put the include into it too. */
  const repair = async (accountId: string, failed: readonly string[]): Promise<void> => {
    repairedAt.set(accountId, now());
    const outcome = await deps.reinstall(accountId);
    if (isOff(accountId)) return;
    const after = outcome.status === "failed" ? null : await deps.verify(accountId);
    if (isOff(accountId)) return;
    const fixed = after?.status === "verified";
    deps.log("rule-repair", {
      account: deps.tagOf(accountId),
      sync: outcome.status,
      result: after?.status ?? "not-read",
    });
    if (!fixed) {
      broken(accountId, failed);
      return;
    }
    deps.onResult(accountId, true);
    deps.notice(
      "Senderban",
      `${deps.labelOf(accountId)}: Senderban's rules were not running on the mail server, because another filter script was. They are on again.`,
    );
  };

  /** A leak, once the rules were read. Not "the rule holds": what else on that server moves mail is not known here. */
  const leaked = (accountId: string, entryId: string, readBack: boolean): void => {
    const why = !deps.holds(accountId, entryId)
      ? "The block is not on that mail server yet: the last update of its rules did not finish."
      : readBack
        ? "The rule is on the mail server, so a filter before it, a forward or a mail program may have put it there."
        : "The rules on the mail server could not be read just now.";
    deps.notice(
      "Senderban",
      `Mail from a sender you blocked came into ${deps.labelOf(accountId)}. ${why}`,
    );
  };

  const read = async (accountId: string): Promise<CheckEnd> => {
    const leakOf = (): string | undefined => leaks.get(accountId);
    const why = (): string => (leakOf() === undefined ? "scheduled" : "leak");
    try {
      if (isOff(accountId)) return "done";
      if (!deps.hasWork(accountId)) {
        const entryId = leakOf();
        if (entryId === undefined) return "done";
        checkedAt.set(accountId, now());
        // Nothing was ever written there: no connection can say more.
        leaked(accountId, entryId, false);
        return "done";
      }
      checkedAt.set(accountId, now());
      const outcome = await deps.verify(accountId);
      if (isOff(accountId)) return "done";
      const failed = outcome.status === "drifted" ? outcome.failed : [];
      deps.log("rule-check", {
        account: deps.tagOf(accountId),
        why: why(),
        result: outcome.status,
        ...(outcome.status === "drifted" ? { failed: failed.join(",") } : {}),
        ...(outcome.status === "failed" ? { code: outcome.code } : {}),
      });
      if (outcome.status === "drifted") {
        const last = repairedAt.get(accountId);
        const may = last === undefined || now() - last >= REPAIR_EVERY_MS;
        if (failed.length === 1 && failed[0] === REPAIRABLE && may) {
          await repair(accountId, failed);
        } else {
          broken(accountId, failed);
        }
        return "done";
      }
      if (outcome.status === "verified") deps.onResult(accountId, true);
      const entryId = leakOf();
      if (entryId !== undefined) leaked(accountId, entryId, outcome.status === "verified");
      return outcome.status === "failed" && willRetry(outcome.code) ? "unreached" : "done";
    } catch (error) {
      deps.log("rule-check", {
        account: deps.tagOf(accountId),
        why: why(),
        result: "error",
        detail: errorName(error),
      });
      return "done";
    }
  };

  /** One line for all of them: an account already in it is not added twice. */
  const enqueue = (accountId: string): Promise<CheckEnd> => {
    if (waiting.has(accountId)) return Promise.resolve("done");
    waiting.add(accountId);
    const turn = line.then(() => read(accountId));
    line = turn.finally(() => {
      waiting.delete(accountId);
      leaks.delete(accountId);
    });
    return turn;
  };

  const schedule = (
    window: { readonly min: number; readonly max: number },
    only: readonly string[] | null = null,
  ): void => {
    timer = setTimeout(
      () => {
        timer = null;
        void round(only);
      },
      Math.round(window.min + (window.max - window.min) * random()),
    );
    timer.unref();
  };

  /** `only`: the accounts a round could not reach, asked once more; null for a whole round. */
  const round = async (only: readonly string[] | null): Promise<void> => {
    const unreached: string[] = [];
    try {
      const accounts = deps.accounts();
      // An account that is gone leaves nothing behind. An empty answer is a pause, which must not forget the last repair.
      for (const map of accounts.length === 0 ? [] : [checkedAt, repairedAt]) {
        for (const id of map.keys()) if (!accounts.includes(id)) map.delete(id);
      }
      // One after another on purpose: a login each, and nobody waits for the answer. At most MAX_ACCOUNTS turns.
      for (const accountId of only ?? accounts) {
        if (isStopped()) return;
        if ((await enqueue(accountId)) === "unreached") unreached.push(accountId);
      }
    } catch (error) {
      deps.log("rule-check", { result: "error", detail: errorName(error) });
    }
    if (isStopped()) return;
    if (only === null && unreached.length > 0) schedule(RETRY_CHECK_MS, unreached);
    else schedule(NEXT_CHECK_MS);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(FIRST_CHECK_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    leak(accountId, entryId) {
      if (stopped) return;
      const last = checkedAt.get(accountId);
      // No line for one held back by the hour: `blocked-arrival` is written for each of these mails already.
      const recent = last !== undefined && now() - last < LEAK_CHECK_EVERY_MS;
      if (recent && !waiting.has(accountId)) return;
      if (!leaks.has(accountId)) leaks.set(accountId, entryId);
      void enqueue(accountId);
    },
  };
}
