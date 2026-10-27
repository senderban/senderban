import { createHash } from "node:crypto";
import {
  GmailAdapter,
  createGmailClient,
  gmailLaneId,
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
