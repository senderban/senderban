import { createHash } from "node:crypto";
import {
  AdapterError,
  GmailAdapter,
  createGmailClient,
  gmailLaneId,
  gmailStateHoldsFilters,
  gmailUnsupported,
  isGmailAccount,
} from "@senderban/core";
import type {
  AccountConfig,
  Blocklist,
  GmailBudgets,
  GmailLogEvent,
  OAuthClient,
  OpaqueState,
} from "@senderban/core";
import { accountTag } from "./log.js";
import type { Log } from "./log.js";

/**
 * An access token is renewed this long before Google ends it. Unit: milliseconds. Google's tokens live 3,599 s (measured);
 * a call that starts a minute before the end still has time to finish inside its own 15 s deadline.
 */
export const ACCESS_TOKEN_MARGIN_MS = 60_000;

/**
 * Hands out the access token of one Gmail account: kept in memory until shortly before it ends, renewed by ONE refresh
 * however many calls ask at once (a round makes a dozen), never written down. The refresh token is read (decrypted) for
 * each renewal only, so the plain value lives for the length of one request.
 */
export function createAccessTokenSource(options: {
  readonly oauth: OAuthClient;
  readonly refreshToken: () => Promise<string>;
  readonly now?: () => number;
}): () => Promise<string> {
  const now = options.now ?? Date.now;
  let cached: { readonly token: string; readonly until: number } | null = null;
  let renewing: Promise<string> | null = null;
  return () => {
    if (cached !== null && now() < cached.until) return Promise.resolve(cached.token);
    renewing ??= (async () => {
      try {
        const grant = await options.oauth.refresh(await options.refreshToken());
        const until = now() + grant.expiresInSeconds * 1000 - ACCESS_TOKEN_MARGIN_MS;
        cached = { token: grant.accessToken, until };
        return grant.accessToken;
      } finally {
        renewing = null;
      }
    })();
    return renewing;
  };
}

/** What the log calls an account: lowercase letters, digits and hyphens (the budget refuses anything else, so an address cannot get in). */
const LOG_TAG = /^[a-z0-9-]{1,64}$/u;
export function gmailLogTag(accountId: string): string {
  const tag = accountTag(accountId);
  return LOG_TAG.test(tag)
    ? tag
    : `acct-${createHash("sha256").update(accountId).digest("hex").slice(0, 8)}`;
}

export interface GmailLane {
  readonly laneId: string;
  readonly accountId: string;
  /** The address the person knows the account by. */
  readonly email: string;
  readonly adapter: GmailAdapter;
}

export interface GmailLaneDeps {
  readonly accounts: readonly AccountConfig[];
  /** The app-wide OAuth client, or null while the person has not set one up. */
  readonly oauth: OAuthClient | null;
  /** ONE for the whole app: its counters are the limits (a budget made again per round would start from zero). */
  readonly budgets: GmailBudgets;
  /** Writes the lane's state in the middle of a round (the app binds `store.setState`). */
  readonly saveState: (laneId: string, state: OpaqueState) => void;
  readonly decrypt: (cipher: string) => Promise<string>;
  readonly log: Log;
  /** Why `oauth` is null: nothing set up, or a client file that could not be read (shown apart in the log). */
  readonly noClientReason?: "no-client" | "client-unreadable";
  /** Lane ids already taken by other accounts' lanes: a Gmail lane whose id clashes is left out, it must not stop the app starting. */
  readonly reservedLaneIds?: ReadonlySet<string>;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

/** Why a Gmail account has no lane; fixed words, they go to the log and (spelled out) into the result toast. */
export type GmailSkipReason =
  "no-client" | "client-unreadable" | "signed-out" | "expired" | "lane-id";
export interface GmailSkipped {
  readonly accountId: string;
  readonly email: string;
  readonly reason: GmailSkipReason;
}
export interface GmailLanes {
  readonly lanes: GmailLane[];
  readonly skipped: GmailSkipped[];
}

/**
 * One background lane per Gmail account that can act now. A signed-out account (no token), an expired one (Google ended the
 * token) and every account while no OAuth client is set up are left out with a fixed reason in the log; the Gmail page shows
 * the person why. Nothing here touches the network: a lane only connects when a round has something to write.
 */
export function buildGmailLanes(deps: GmailLaneDeps): GmailLanes {
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  const lanes: GmailLane[] = [];
  const skipped: GmailSkipped[] = [];
  const taken = new Set(deps.reservedLaneIds);
  for (const account of deps.accounts) {
    if (!isGmailAccount(account)) continue;
    const tag = gmailLogTag(account.id);
    const skip = (reason: GmailSkipReason): void => {
      skipped.push({ accountId: account.id, email: account.gmail.email, reason });
      deps.log("gmail-lane-skipped", { account: tag, reason });
    };
    const { refreshCipher, accessEndsAt } = account.gmail;
    if (deps.oauth === null) {
      skip(deps.noClientReason ?? "no-client");
      continue;
    }
    if (refreshCipher === undefined) {
      skip("signed-out");
      continue;
    }
    if (accessEndsAt !== undefined && accessEndsAt <= nowSeconds) {
      skip("expired");
      continue;
    }
    const laneId = gmailLaneId(account.id);
    if (taken.has(laneId)) {
      skip("lane-id");
      continue;
    }
    taken.add(laneId);
    const oauth = deps.oauth;
    const client = createGmailClient({
      getAccessToken: createAccessTokenSource({
        oauth,
        refreshToken: () => deps.decrypt(refreshCipher),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      // Operation, HTTP status and duration only.
      onCall: (call) => {
        deps.log("gmail-http", { account: tag, ...call });
      },
    });
    const budgeted = deps.budgets.wrap(client, {
      key: laneId,
      account: tag,
      log: (event: GmailLogEvent) => {
        const { event: name, ...fields } = event;
        deps.log(name, fields);
      },
    });
    lanes.push({
      laneId,
      accountId: account.id,
      email: account.gmail.email,
      adapter: new GmailAdapter({
        accountId: laneId,
        client: budgeted,
        checkpoint: (state) => {
          deps.saveState(laneId, state);
        },
      }),
    });
    deps.log("gmail-lane", { account: tag });
  }
  return { lanes, skipped };
}

/**
 * What the result toast adds after a block when a Gmail account is set up (ADR 0009 point 6): the choice is applied where it
 * exists, and the toast says where it was not. A Gmail filter takes single addresses and Trash only, and only an address form
 * the query contract lets through; everything else is not blocked there.
 */
export function gmailMissNote(list: Blocklist, target: string): string {
  const entry = list.find((e) => e.value === target);
  if (entry === undefined) return "";
  if (entry.match !== "exactAddress") {
    return " Not blocked on Gmail: a Gmail filter takes single addresses only.";
  }
  if (entry.action !== "trash") {
    return " Not blocked on Gmail: Gmail has no Junk filter, choose Trash to block there.";
  }
  return gmailUnsupported(list).some((e) => e.id === entry.id)
    ? " Not blocked on Gmail: this address form cannot be written as a Gmail filter."
    : "";
}

const SKIP_TEXT: Record<GmailSkipReason, string> = {
  "no-client": "no Google client is set up",
  "client-unreadable": "the Google client file could not be read",
  "signed-out": "it is signed out",
  expired: "its access has ended",
  "lane-id": "its name clashes with another account",
};
/** The most accounts named in one note; the rest are counted. */
const SKIP_NOTE_NAMED = 2;

/**
 * A Gmail account with no lane is not updated by a block or an Unblock: the result toast says so by name, or an earlier
 * Trash filter would go on trashing mail from a sender the person just unblocked while the toast reads as done.
 */
export function gmailSkippedNote(skipped: readonly GmailSkipped[]): string {
  if (skipped.length === 0) return "";
  const named = skipped
    .slice(0, SKIP_NOTE_NAMED)
    .map((s) => `${s.email} (${SKIP_TEXT[s.reason]})`)
    .join("; ");
  const more =
    skipped.length > SKIP_NOTE_NAMED ? ` (+${String(skipped.length - SKIP_NOTE_NAMED)} more)` : "";
  return ` Gmail not updated: ${named}${more}.`;
}

/**
 * What an account's removal or sign-out does about its Gmail filters (ADR 0009 point 3, in this order: uninstall our
 * filters, revoke the token, delete the ciphertext). `prepare` is the first step and ends in one of:
 * - `ready`: nothing of ours is left in Gmail (the lane, if any, is held still so no round writes another);
 * - `filters-left`: some could not be deleted (Google did not answer): the caller keeps the account;
 * - `unreachable`: the state says filters exist but no lane can reach Gmail (signed out, expired): the caller goes on and tells the person.
 * After `prepare` the caller ends with `abort` (the removal did not finish: the lane writes again) or `done` (it finished: the lane is retired).
 */
export interface GmailFilterLifecycle {
  /**
   * What `prepare` would find, without doing anything (no network, nothing held still): `lane` when a lane can act, otherwise
   * the answer a lane-less account gets. Lets a caller refuse a whole change before it deletes a single filter.
   */
  classify(accountId: string): "lane" | "ready" | "unreachable" | "restart-cures";
  /**
   * `restart-cures` is `unreachable` with a cure: there is no lane because of what a restart rebuilds (the account was signed
   * out or its access had ended when the app started), so if the account has a usable token now, restarting lets Senderban delete.
   */
  prepare(accountId: string): Promise<"ready" | "filters-left" | "unreachable" | "restart-cures">;
  abort(accountId: string): void;
  done(accountId: string, why: "removed" | "signed-out"): void;
}

export interface GmailLifecycleDeps {
  readonly lanes: ReadonlyMap<string, GmailLane>;
  readonly store: {
    getState(laneId: string): OpaqueState | undefined;
    setState(laneId: string, state: OpaqueState): void;
  };
  /** A lane is held still (true) or free again (false): the app keeps its own "working on it" notices quiet meanwhile. */
  readonly onHold?: (laneId: string, held: boolean) => void;
  /** A held lane is free again after a removal that did not finish: it must catch up with what happened meanwhile (a sync). */
  readonly onResumed: (laneId: string) => void;
  /**
   * The removal or sign-out finished. `lane` is missing for an account that had none this session. The app drops the lane from
   * its lists and keeps `gmailSkipped` right (see `skippedAfterDone`).
   */
  readonly onDone: (
    accountId: string,
    why: "removed" | "signed-out",
    lane: GmailLane | undefined,
  ) => void;
  /** Why the account has no lane this session, if it has none (see `buildGmailLanes`). */
  readonly skipReasonOf: (accountId: string) => GmailSkipReason | undefined;
  readonly log: Log;
}

export function createGmailLifecycle(deps: GmailLifecycleDeps): GmailFilterLifecycle {
  /** What an account with no lane gets: nothing to delete, or filters it cannot reach (and whether a restart would change that). */
  const laneless = (accountId: string): "ready" | "unreachable" | "restart-cures" => {
    const known = deps.store.getState(gmailLaneId(accountId));
    if (known === undefined || !gmailStateHoldsFilters(known)) return "ready";
    const reason = deps.skipReasonOf(accountId);
    // No reason is an account that signed in after the app started; signed-out and expired are what a new sign-in cures.
    return reason === undefined || reason === "signed-out" || reason === "expired"
      ? "restart-cures"
      : "unreachable";
  };
  return {
    classify(accountId) {
      return deps.lanes.has(accountId) ? "lane" : laneless(accountId);
    },
    async prepare(accountId) {
      const laneId = gmailLaneId(accountId);
      const lane = deps.lanes.get(accountId);
      if (lane === undefined) return laneless(accountId);
      deps.onHold?.(laneId, true);
      // Held still first, and the state read AFTER: a round that was running has saved its last filter by the time this returns.
      // A round that does not end in time leaves the filters where they are: the caller keeps the account.
      if (!(await lane.adapter.suspend())) return "filters-left";
      const state = deps.store.getState(laneId);
      if (state === undefined || !gmailStateHoldsFilters(state)) return "ready";
      try {
        const left = await lane.adapter.uninstall(state);
        deps.store.setState(laneId, left);
        return gmailStateHoldsFilters(left) ? "filters-left" : "ready";
      } catch (error) {
        const code = error instanceof AdapterError ? error.code : "UNKNOWN";
        // Fixed words only: a Google answer or an address must not reach the log.
        deps.log("gmail-uninstall-failed", { account: gmailLogTag(accountId), code });
        // Google refusing the sign-in (an ended access) is nothing a retry or a restart fixes: the filters are out of reach, not late.
        return code === "AUTH_REQUIRED" ? "unreachable" : "filters-left";
      }
    },
    abort(accountId) {
      const lane = deps.lanes.get(accountId);
      if (lane === undefined) return;
      lane.adapter.resume();
      deps.onHold?.(lane.laneId, false);
      deps.onResumed(lane.laneId);
    },
    done(accountId, why) {
      const lane = deps.lanes.get(accountId);
      if (lane !== undefined) {
        lane.adapter.retire();
        deps.onHold?.(lane.laneId, false);
      }
      deps.onDone(accountId, why, lane);
    },
  };
}

/**
 * The accounts the toasts name as "Gmail not updated", after one finished its removal or sign-out. A removed account is no
 * longer named; a signed-out one is named as signed out (whatever the reason was before), by the address the lane or the earlier
 * entry knew.
 */
export function skippedAfterDone(
  skipped: readonly GmailSkipped[],
  accountId: string,
  why: "removed" | "signed-out",
  laneEmail: string | undefined,
): GmailSkipped[] {
  const email = laneEmail ?? skipped.find((s) => s.accountId === accountId)?.email;
  const rest = skipped.filter((s) => s.accountId !== accountId);
  return why === "signed-out" && email !== undefined
    ? [...rest, { accountId, email, reason: "signed-out" }]
    : rest;
}

/** Lanes held still for a removal. Apart from the toast click's own set: an Unblock releases that one when it ends. */
export function createHeldLanes(): {
  has(laneId: string): boolean;
  hold(laneId: string, held: boolean): void;
} {
  const held = new Set<string>();
  return {
    has: (laneId) => held.has(laneId),
    hold: (laneId, value) => {
      if (value) held.add(laneId);
      else held.delete(laneId);
    },
  };
}
