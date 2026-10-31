import { createHash } from "node:crypto";
import {
  AdapterError,
  GraphAdapter,
  createGraphClient,
  graphLaneId,
  graphMatchReaches,
  graphReachTest,
  graphScopeExtras,
  graphStateHoldsDeletable,
  graphStateHoldsRules,
  isMicrosoftAccount,
} from "@senderban/core";
import type {
  AccountConfig,
  BlockEntry,
  Blocklist,
  GraphBudgetEvent,
  GraphBudgets,
  GraphCall,
  MicrosoftOAuthClient,
  OpaqueState,
  OwnMail,
} from "@senderban/core";
import { createAccessTokenSource } from "./gmail-lanes.js";
import { accountTag } from "./log.js";
import type { Log } from "./log.js";

export interface MicrosoftLane {
  readonly laneId: string;
  readonly accountId: string;
  /** The address the person knows the account by. */
  readonly email: string;
  readonly adapter: GraphAdapter;
}

export interface MicrosoftLaneDeps {
  readonly accounts: readonly AccountConfig[];
  /** Null while Senderban has no app registration to sign in with. */
  readonly oauth: MicrosoftOAuthClient | null;
  /** ONE for the whole app: its counters are the limits. */
  readonly budgets: GraphBudgets;
  /** Writes the lane's state in the middle of a round (the app binds `store.setState`). */
  readonly saveState: (laneId: string, state: OpaqueState) => void;
  readonly decrypt: (cipher: string) => Promise<string>;
  /** Stores a refresh token that replaced itself; the new ciphertext, or null when the account is gone. */
  readonly saveRefreshToken: (accountId: string, refreshToken: string) => Promise<string | null>;
  readonly log: Log;
  /** The person's own mail as it is now: a domain whose text match would reach it is not written. */
  readonly own: () => OwnMail;
  /** Lane ids already taken: a lane whose id clashes is left out, it must not stop the app starting. */
  readonly reservedLaneIds?: ReadonlySet<string>;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

export type MicrosoftSkipReason = "no-client" | "signed-out" | "lane-id";
export interface MicrosoftSkipped {
  readonly accountId: string;
  readonly email: string;
  readonly reason: MicrosoftSkipReason;
}

/** An account id without `@` and a hash of one with it: the log's tag is never an address. */
function logTag(accountId: string): string {
  const tag = accountTag(accountId);
  return /^[a-z0-9-]{1,64}$/u.test(tag)
    ? tag
    : `acct-${createHash("sha256").update(accountId).digest("hex").slice(0, 8)}`;
}

/**
 * One background lane per Microsoft account that can act now. Nothing here touches the network: a lane connects when a round has something to
 * write. A refresh token replaces itself on use, so the source keeps the newest ciphertext, and a save that fails leaves the old token, which
 * Microsoft does not revoke, in use.
 */
export function buildMicrosoftLanes(deps: MicrosoftLaneDeps): {
  lanes: MicrosoftLane[];
  skipped: MicrosoftSkipped[];
} {
  const lanes: MicrosoftLane[] = [];
  const skipped: MicrosoftSkipped[] = [];
  const taken = new Set(deps.reservedLaneIds);
  for (const account of deps.accounts) {
    if (!isMicrosoftAccount(account)) continue;
    const tag = logTag(account.id);
    const { email, refreshCipher } = account.microsoft;
    const skip = (reason: MicrosoftSkipReason): void => {
      skipped.push({ accountId: account.id, email, reason });
      deps.log("graph-lane-skipped", { account: tag, reason });
    };
    if (deps.oauth === null) {
      skip("no-client");
      continue;
    }
    if (refreshCipher === undefined) {
      skip("signed-out");
      continue;
    }
    const laneId = graphLaneId(account.id);
    if (taken.has(laneId)) {
      skip("lane-id");
      continue;
    }
    taken.add(laneId);
    const oauth = deps.oauth;
    let cipher = refreshCipher;
    const getAccessToken = createAccessTokenSource({
      oauth: {
        refresh: async (token) => {
          const grant = await oauth.refresh(token);
          const extras = graphScopeExtras(grant.scope);
          if (extras > 0) deps.log("graph-scope-wider", { account: tag, extras });
          if (grant.refreshToken !== undefined) {
            try {
              cipher = (await deps.saveRefreshToken(account.id, grant.refreshToken)) ?? cipher;
            } catch {
              deps.log("graph-refresh-save-failed", { account: tag });
            }
          }
          return grant;
        },
      },
      refreshToken: () => deps.decrypt(cipher),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    const client = createGraphClient({
      getAccessToken,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      // Operation, HTTP status and duration only.
      onCall: (call: GraphCall) => {
        deps.log("graph-http", { account: tag, ...call });
      },
    });
    const budgeted = deps.budgets.wrap(client, {
      key: laneId,
      account: tag,
      log: (event: GraphBudgetEvent) => {
        const { event: name, ...fields } = event;
        deps.log(name, fields);
      },
    });
    lanes.push({
      laneId,
      accountId: account.id,
      email,
      adapter: new GraphAdapter({
        accountId: laneId,
        client: budgeted,
        reaches: () => graphReachTest(deps.own()),
        // Counts and a duration only.
        onRound: (round) => {
          deps.log("graph-round", { account: tag, ...round });
        },
        checkpoint: (state) => {
          deps.saveState(laneId, state);
        },
      }),
    });
    deps.log("graph-lane", { account: tag });
  }
  return { lanes, skipped };
}

/**
 * What a Microsoft account does with one list entry (ADR 0012): "exact" for a single address, "wide" for a domain, which is a text match there, "no" for a
 * domain whose text match would also reach the person's own mail or a mail provider. Cheap: the window asks for the whole list on every change.
 */
export function outlookCover(
  entry: Pick<BlockEntry, "match" | "value">,
  own: OwnMail,
): "exact" | "wide" | "no" {
  if (entry.match === "exactAddress") return "exact";
  return graphMatchReaches(entry, own) ? "no" : "wide";
}

/** What the result toast adds after a block of a domain when a Microsoft account is set up. */
export function microsoftWideNote(list: Blocklist, target: string, own: OwnMail): string {
  const entry = list.find((e) => e.value === target);
  if (entry === undefined) return "";
  const cover = outlookCover(entry, own);
  if (cover === "no") {
    return " Not blocked on Outlook: a domain is a text match there, and this one would also catch your own mail or a mail provider.";
  }
  return cover === "wide"
    ? " On Outlook this is a text match, so it can also catch longer domains that start the same way."
    : "";
}

const SKIP_TEXT: Record<MicrosoftSkipReason, string> = {
  "no-client": "Microsoft sign-in is not set up in this version",
  "signed-out": "it is signed out",
  "lane-id": "its name clashes with another account",
};
/** The most accounts named in one note; the rest are counted. */
const SKIP_NOTE_NAMED = 2;

/** A Microsoft account with no lane is not updated by a block or an Unblock: the result says so by name. */
export function microsoftSkippedNote(skipped: readonly MicrosoftSkipped[]): string {
  if (skipped.length === 0) return "";
  const named = skipped
    .slice(0, SKIP_NOTE_NAMED)
    .map((s) => `${s.email} (${SKIP_TEXT[s.reason]})`)
    .join("; ");
  const more =
    skipped.length > SKIP_NOTE_NAMED ? ` (+${String(skipped.length - SKIP_NOTE_NAMED)} more)` : "";
  return ` Outlook not updated: ${named}${more}.`;
}

/**
 * What removing an account does about its Outlook rules: uninstall ours, then forget the token. `prepare` ends in one of:
 * - `ready`: nothing of ours is left (the lane, if any, is held still so no round writes another);
 * - `rules-left`: they could not be deleted, a later try may work: the caller keeps the account;
 * - `unreachable`: Microsoft refused the sign-in, or the person edited them, so they are out of reach: the caller goes on and tells the person;
 * - `restart-first`: rules exist but no lane this session.
 * After `prepare` the caller ends with `abort` (the removal did not finish) or `done`.
 */
export interface MicrosoftRuleLifecycle {
  prepare(accountId: string): Promise<"ready" | "rules-left" | "unreachable" | "restart-first">;
  abort(accountId: string): void;
  done(accountId: string): void;
}

export interface MicrosoftLifecycleDeps {
  readonly lanes: ReadonlyMap<string, MicrosoftLane>;
  readonly store: {
    getState(laneId: string): OpaqueState | undefined;
    setState(laneId: string, state: OpaqueState): void;
  };
  /** A lane is held still (true) or free again (false): a failed round is not news meanwhile. */
  readonly onHold: (laneId: string, held: boolean) => void;
  /** A held lane is free again: it must catch up with what happened meanwhile. */
  readonly onResumed: (laneId: string) => void;
  readonly onDone: (accountId: string, lane: MicrosoftLane | undefined) => void;
  /** Why the account has no lane this session, if it has none. */
  readonly skipReasonOf: (accountId: string) => MicrosoftSkipReason | undefined;
  readonly log: Log;
}

export function createMicrosoftLifecycle(deps: MicrosoftLifecycleDeps): MicrosoftRuleLifecycle {
  return {
    async prepare(accountId) {
      const laneId = graphLaneId(accountId);
      const lane = deps.lanes.get(accountId);
      if (lane === undefined) {
        const known = deps.store.getState(laneId);
        if (known === undefined || !graphStateHoldsRules(known)) return "ready";
        // Signed out or no client: a restart changes nothing, the rules are out of reach. Otherwise it signed in after the app started.
        return deps.skipReasonOf(accountId) === undefined ? "restart-first" : "unreachable";
      }
      deps.onHold(laneId, true);
      // Held still first, and the state read AFTER: a round that was running has its last write's intent on disk by the time this returns, and `uninstall` settles it.
      if (!(await lane.adapter.suspend())) return "rules-left";
      const state = deps.store.getState(laneId);
      if (state === undefined || !graphStateHoldsRules(state)) return "ready";
      try {
        const left = await lane.adapter.uninstall(state);
        deps.store.setState(laneId, left);
        if (graphStateHoldsDeletable(left)) return "rules-left";
        // Only rules the person edited are left: not ours to delete, and they cannot hold the account hostage.
        return graphStateHoldsRules(left) ? "unreachable" : "ready";
      } catch (error) {
        const code = error instanceof AdapterError ? error.code : "UNKNOWN";
        // Fixed words only.
        deps.log("graph-uninstall-failed", { account: logTag(accountId), code });
        // Refused for good (a sign-in that ended, a state that no longer reads): waiting changes nothing, and the account must not be held hostage.
        return code === "AUTH_REQUIRED" || code === "REJECTED" ? "unreachable" : "rules-left";
      }
    },
    abort(accountId) {
      const lane = deps.lanes.get(accountId);
      if (lane === undefined) return;
      lane.adapter.resume();
      deps.onHold(lane.laneId, false);
      deps.onResumed(lane.laneId);
    },
    done(accountId) {
      const lane = deps.lanes.get(accountId);
      if (lane !== undefined) {
        lane.adapter.retire();
        deps.onHold(lane.laneId, false);
      }
      deps.onDone(accountId, lane);
    },
  };
}
