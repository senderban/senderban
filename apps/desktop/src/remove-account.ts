import {
  AdapterError,
  SIEVE_SUSPEND_WAIT_MS,
  initialSieveState,
  isImapAccount,
  mxrouteLaneId,
  sieveStateForReinstall,
  sieveStateHoldsRules,
} from "@senderban/core";
import type { OpaqueState } from "@senderban/core";
import { loadAccounts, saveAccounts, serialized } from "./accounts-file.js";
import { settleWithin } from "./deadline.js";
import { accountTag } from "./log.js";
import type { Log } from "./log.js";

/** Longest the uninstall may take, once the lane is quiet. A removal holds every other account change, so it needs one total. */
export const SIEVE_UNINSTALL_MS = 60_000;

export type AccountRemoveResult =
  | "removed"
  /** Removed, but the account had an MXroute key: what it put on the blacklist stays there. */
  | "removed-blacklist-remains"
  /** Removed at the person's word, with Senderban's rules still on the mail server. */
  | "removed-rules-remain"
  /** The state says rules exist but this session has no lane to reach them: restart, then remove. Nothing was changed. */
  | "restart-first"
  /** The rules could not be deleted and the person kept the account. */
  | "rules-left"
  | "unknown-account"
  | "cancelled";

/** The lane's side of a removal; `SieveAdapter` is the real one. */
export interface SieveLane {
  suspend(): Promise<boolean>;
  resume(): void;
  retire(): void;
  uninstall(state: OpaqueState, signal: AbortSignal): Promise<OpaqueState>;
}

/**
 * What removing an account does about its Sieve rules (the order of ADR 0009 point 3: uninstall ours, then delete the password).
 * `prepare` ends in one of:
 * - `ready`: nothing of ours is left on the server (the lane, if any, is held still so no round writes another);
 * - `rules-left`: they could not be deleted, a later try may work;
 * - `unreachable`: the server refused the login, so they are out of reach until the password is right;
 * - `restart-first`: rules exist but no lane this session.
 * After `prepare` the caller ends with `abort` (the removal did not finish: the lane writes again) or `done` (the lane is retired;
 * `rulesRemain` keeps the state, the only record of what is still on the server).
 */
export interface SieveRulesLifecycle {
  prepare(accountId: string): Promise<"ready" | "rules-left" | "unreachable" | "restart-first">;
  abort(accountId: string): void;
  done(accountId: string, rulesRemain: boolean): void;
}

export interface SieveLifecycleDeps {
  readonly lanes: ReadonlyMap<string, SieveLane>;
  /** Accounts that got no lane at start: their id is another lane's, so nothing stored under it is theirs. */
  readonly skipped: ReadonlySet<string>;
  readonly store: {
    getState(accountId: string): OpaqueState | undefined;
    setState(accountId: string, state: OpaqueState): void;
  };
  /** Resolves when a round that reached the provider has saved its result. */
  readonly attemptDone: (accountId: string) => Promise<void>;
  /** A lane is held still (true) or free again (false): the app keeps its own "working on it" notices quiet meanwhile. */
  readonly onHold: (accountId: string, held: boolean) => void;
  /** A held lane is free again: it must catch up with what happened meanwhile (a sync). */
  readonly onResumed: (accountId: string) => void;
  /** The removal finished: the app drops the account from its lists. */
  readonly onDone: (accountId: string, rulesRemain: boolean) => void;
  readonly log: Log;
}

export function createSieveLifecycle(deps: SieveLifecycleDeps): SieveRulesLifecycle {
  return {
    async prepare(accountId) {
      if (deps.skipped.has(accountId)) return "ready";
      const lane = deps.lanes.get(accountId);
      if (lane === undefined) {
        const known = deps.store.getState(accountId);
        return known !== undefined && sieveStateHoldsRules(known) ? "restart-first" : "ready";
      }
      deps.onHold(accountId, true);
      // The engine saves a Sieve round's state after `apply` returned, so the adapter going idle is not yet the end of it.
      const round = { quiet: false };
      const stilled = lane.suspend().then(async (idle) => {
        if (idle) await deps.attemptDone(accountId);
        round.quiet = idle;
      });
      await settleWithin(stilled, SIEVE_SUSPEND_WAIT_MS);
      if (!round.quiet) {
        deps.log("sieve-uninstall-failed", { account: accountTag(accountId), code: "BUSY" });
        return "rules-left";
      }
      const state = deps.store.getState(accountId) ?? initialSieveState();
      try {
        // Marked first: a crash during the uninstall must not leave a state that says everything is in place.
        deps.store.setState(accountId, sieveStateForReinstall(state));
        // Always, even when the state says nothing is there: a lost state must not leave rules behind. It goes by script
        // name, keeps to what is ours, and costs one login at a person's click.
        const signal = AbortSignal.timeout(SIEVE_UNINSTALL_MS);
        deps.store.setState(accountId, await lane.uninstall(state, signal));
        return "ready";
      } catch (error) {
        const code = error instanceof AdapterError ? error.code : "UNKNOWN";
        // A fixed word only: a server's answer or an address must not reach the log.
        deps.log("sieve-uninstall-failed", { account: accountTag(accountId), code });
        return code === "AUTH_REQUIRED" ? "unreachable" : "rules-left";
      }
    },
    abort(accountId) {
      const lane = deps.lanes.get(accountId);
      if (lane === undefined) return;
      lane.resume();
      deps.onHold(accountId, false);
      deps.onResumed(accountId);
    },
    done(accountId, rulesRemain) {
      if (deps.skipped.has(accountId)) return;
      const lane = deps.lanes.get(accountId);
      if (lane !== undefined) {
        lane.retire();
        deps.onHold(accountId, false);
      }
      // A later re-add must not read a missing script as someone else's edit: the person was told to delete it.
      const kept = rulesRemain ? deps.store.getState(accountId) : undefined;
      if (kept !== undefined) deps.store.setState(accountId, sieveStateForReinstall(kept));
      deps.onDone(accountId, rulesRemain);
    },
  };
}

/** The running app's view of its accounts: the parts a removal changes, as `main.ts` holds them. */
export interface LiveAccounts {
  readonly lanes: string[];
  readonly labels: Map<string, string>;
  readonly mxrouteLanes: Set<string>;
  readonly mxrouteAdapters: ReadonlyMap<string, { retire(): void }>;
  readonly rejectingAccounts: Set<string>;
  /** Every account that shares this account's MXroute blacklist, itself included. */
  readonly blacklistGroup: (accountId: string) => readonly string[];
  readonly pending: { dropAccount(accountId: string): void };
  readonly store: {
    forgetAccount(accountId: string): void;
    forgetCursor(accountId: string): void;
  };
  /** Resolves when the engine has saved the result of the lane's last round. */
  readonly settled: (accountId: string) => Promise<void>;
  readonly sieveLanes: Map<string, unknown>;
  readonly watchers: Map<string, { stop(): Promise<void> }>;
  readonly states: Map<string, unknown>;
}

/**
 * Takes a removed account out of the running app. An MXroute lane it owned goes with it: the lane stays in the engine until the
 * restart the window offers, but its key is not used again, and the mailboxes that shared it stop promising a refusal.
 */
export function dropImapAccount(accountId: string, rulesRemain: boolean, live: LiveAccounts): void {
  const laneId = mxrouteLaneId(accountId);
  const ownedLane = live.mxrouteLanes.has(laneId);
  if (ownedLane) {
    live.mxrouteAdapters.get(laneId)?.retire();
    live.mxrouteLanes.delete(laneId);
    for (const id of live.blacklistGroup(accountId)) live.rejectingAccounts.delete(id);
  }
  live.rejectingAccounts.delete(accountId);
  for (const id of [accountId, laneId]) {
    const at = live.lanes.indexOf(id);
    if (at >= 0) live.lanes.splice(at, 1);
    live.labels.delete(id);
    live.pending.dropAccount(id);
  }
  // After its last round: a round in flight would write the row back.
  if (ownedLane) {
    void live
      .settled(laneId)
      .then(() => {
        live.store.forgetAccount(laneId);
      })
      .catch(() => undefined);
  }
  // With rules still on the server the state is the only record of them: a re-add finds its own script by that hash.
  if (rulesRemain) live.store.forgetCursor(accountId);
  else live.store.forgetAccount(accountId);
  // A re-add this session has no lane: this one still holds the old server and the old password.
  live.sieveLanes.delete(accountId);
  const watcher = live.watchers.get(accountId);
  live.watchers.delete(accountId);
  void watcher?.stop().catch(() => undefined);
  live.states.delete(accountId);
}

export interface AccountRemoveSteps {
  /** The person's own yes, asked by the main process, naming the account. */
  readonly confirm: (label: string) => Promise<boolean>;
  /** The rules could not be deleted: does the person want the account gone anyway? */
  readonly confirmLeaveRules: (label: string) => Promise<boolean>;
  readonly rules: () => Promise<SieveRulesLifecycle>;
  /** Runs once, after the account left the file. It must not throw: the account is gone by then. */
  readonly onRemoved: () => Promise<void>;
}

/**
 * Removes an IMAP account, in this order: its rules on the server, then the file (with the password). A failure before the file
 * changed leaves the account working; a server that is gone for good cannot hold the account hostage, the person decides.
 */
export async function removeImapAccount(
  path: string,
  accountId: string,
  steps: AccountRemoveSteps,
): Promise<AccountRemoveResult> {
  const account = (await loadAccounts(path)).filter(isImapAccount).find((a) => a.id === accountId);
  if (account === undefined) return "unknown-account";
  const label = account.imap.user;
  if (!(await steps.confirm(label))) return "cancelled";

  const rules = await steps.rules();
  let rulesRemain = false;
  try {
    const prepared = await rules.prepare(accountId);
    if (prepared === "restart-first") {
      rules.abort(accountId);
      return "restart-first";
    }
    if (prepared === "unreachable" || prepared === "rules-left") {
      if (!(await steps.confirmLeaveRules(label))) {
        rules.abort(accountId);
        return "rules-left";
      }
      rulesRemain = true;
    }
    await serialized(async () => {
      const accounts = await loadAccounts(path);
      await saveAccounts(
        path,
        accounts.filter((a) => a.id !== accountId),
      );
    });
  } catch (error) {
    rules.abort(accountId);
    throw error;
  }
  rules.done(accountId, rulesRemain);
  await steps.onRemoved();
  if (rulesRemain) return "removed-rules-remain";
  return account.mxroute === undefined ? "removed" : "removed-blacklist-remains";
}
