import { randomUUID } from "node:crypto";
import {
  MAX_ACCOUNTS,
  createGate,
  isGmailAccount,
  isImapAccount,
  mailboxKey,
} from "@senderban/core";
import type {
  AccountConfig,
  GmailAccountConfig,
  GoogleClientInput,
  OAuthClient,
} from "@senderban/core";
import type { SignInOptions, SignInResult } from "@senderban/core/node";
import {
  decryptPassword,
  encryptPassword,
  loadAccounts,
  saveAccounts,
  serialized,
} from "./accounts-file.js";
import {
  ClientFileInvalid,
  clientSecretGetter,
  loadGoogleClient,
  saveGoogleClient,
} from "./google-client.js";

/** Token revokes in flight at once when the app-wide client changes: 50 accounts drain in 10 waves of one <= 15 s call. */
export const MAX_CONCURRENT_REVOKES = 5;

/** What the main process does with Google; everything that touches the network or the OS is handed in. */
export interface GoogleDeps {
  readonly accountsPath: string;
  readonly clientPath: string;
  /** An OAuth client for the stored app-wide client (the secret is read per request from the ciphertext). */
  readonly makeOAuth: (clientId: string, getClientSecret: () => Promise<string>) => OAuthClient;
  readonly signIn: (options: SignInOptions) => Promise<SignInResult>;
  /** Already limited to Google's consent page. */
  readonly openBrowser: (url: string) => Promise<void>;
  /**
   * Told after this module changed accounts.json (a sign-in stored, accounts signed out, one removed): whatever was
   * derived from the file, such as the never-refuse addresses, must follow. A throw is swallowed here; the caller logs it.
   */
  readonly onAccountsChanged?: () => Promise<void> | void;
  /** The clock in milliseconds; tests move it. */
  readonly now?: () => number;
}

/** What the manage page may know: the client's ID (not secret), and per account the address and whether it can act. */
export interface GooglePageState {
  readonly client: { readonly clientId: string } | null;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly email: string;
    /** A token is stored (it may have expired: see `expired`). */
    readonly signedIn: boolean;
    /** Google's limit on the stored token has passed: the account must sign in again. */
    readonly expired: boolean;
    /** Epoch seconds when Google ends the stored token, or null when it did not limit it. */
    readonly accessEndsAt: number | null;
  }[];
}

export type GoogleSignInReply =
  | "signed-in"
  | "no-client"
  | "unknown-account"
  | "cancelled"
  | "timeout"
  | "aborted"
  | "busy"
  | "browser-failed"
  /** Google granted other permissions than the two asked. Nothing stored. */
  | "scope"
  /** A re-sign-in ended in another Google account. Nothing stored. */
  | "wrong-account"
  /** Google refused the client ID or secret (or the request): the typed values are the first suspect. */
  | "client-refused"
  | "unreachable"
  /** The mailbox is already set up (another account of ours, or an IMAP login on it). Nothing stored. */
  | "duplicate"
  | "full";

export interface GoogleSignInOutcome {
  readonly reply: GoogleSignInReply;
  /** Set only when Google limits the access in time ("Testing": 7 days): the person is told when it ends. */
  readonly accessEndsInDays?: number;
}

export type GoogleClientReply =
  | "saved"
  /** Saved, but the old client file was unreadable: the signed-in accounts were signed out without a revoke. */
  | "saved-left-access"
  /** Accounts are signed in with the old client: the person must confirm they will be signed out. */
  | "needs-confirm"
  /** A token could not be revoked (offline, Google error). The client was not changed. */
  | "revoke-failed"
  | "busy";

export type GoogleRemoveReply =
  | "removed"
  /** Removed, but the account held no token, so no revoke ran: Google may still list the access. */
  | "removed-not-revoked"
  | "unknown-account"
  | "revoke-failed"
  | "busy";

/** One Google operation at a time: a client change must not land between a sign-in and its save. */
let working = false;
async function exclusive<T>(busy: T, work: () => Promise<T>): Promise<T> {
  if (working) return busy;
  working = true;
  try {
    return await work();
  } finally {
    working = false;
  }
}

/** The sign-in that waits for the browser, if any: Cancel, closing the page and quitting stop it. */
let waiting: AbortController | null = null;
export function cancelGoogleSignIn(): void {
  waiting?.abort();
}

const SECONDS_PER_DAY = 86_400;

const nowSeconds = (deps: GoogleDeps): number => Math.floor((deps.now ?? Date.now)() / 1000);

async function notifyChanged(deps: GoogleDeps): Promise<void> {
  try {
    await deps.onAccountsChanged?.();
  } catch {
    // The change is already saved; a failing listener must not turn a stored sign-in into an error.
  }
}

function gmailAccounts(accounts: readonly AccountConfig[]): GmailAccountConfig[] {
  return accounts.filter(isGmailAccount);
}

export async function googleState(deps: GoogleDeps): Promise<GooglePageState> {
  const [client, accounts] = await Promise.all([
    // An invalid client file shows as "no client": the person can save one over it (see saveGoogleClientSettings).
    // An I/O error is not that: it throws and the page says it could not load.
    loadGoogleClient(deps.clientPath).catch((error: unknown) => {
      if (error instanceof ClientFileInvalid) return null;
      throw error;
    }),
    loadAccounts(deps.accountsPath),
  ]);
  const now = nowSeconds(deps);
  return {
    client: client === null ? null : { clientId: client.clientId },
    accounts: gmailAccounts(accounts).map((a) => ({
      accountId: a.id,
      email: a.gmail.email,
      signedIn: a.gmail.refreshCipher !== undefined,
      expired:
        a.gmail.refreshCipher !== undefined &&
        a.gmail.accessEndsAt !== undefined &&
        a.gmail.accessEndsAt <= now,
      accessEndsAt: a.gmail.accessEndsAt ?? null,
    })),
  };
}

function failedReply(code: string): GoogleSignInReply {
  // Google refusing the client (a wrong or missing secret answers 400) is told apart from "could not reach Google".
  return code === "AUTH_REQUIRED" || code === "REJECTED" ? "client-refused" : "unreachable";
}

/** Signs in a new Gmail account, or signs an existing one in again (`accountId`). Stores only the encrypted refresh token. */
export function signInGoogle(
  deps: GoogleDeps,
  request: { readonly accountId?: string },
): Promise<GoogleSignInOutcome> {
  return exclusive<GoogleSignInOutcome>({ reply: "busy" }, async () => {
    const client = await loadGoogleClient(deps.clientPath);
    if (client === null) return { reply: "no-client" };

    let expectEmail: string | undefined;
    if (request.accountId !== undefined) {
      const known = gmailAccounts(await loadAccounts(deps.accountsPath)).find(
        (a) => a.id === request.accountId,
      );
      if (known === undefined) return { reply: "unknown-account" };
      expectEmail = known.gmail.email;
    }

    // Made only once the slot is ours: a refused (busy) call must never replace the controller of the one that waits.
    const abort = new AbortController();
    waiting = abort;
    let result: SignInResult;
    try {
      result = await deps.signIn({
        clientId: client.clientId,
        oauth: deps.makeOAuth(client.clientId, clientSecretGetter(client)),
        openBrowser: deps.openBrowser,
        ...(expectEmail === undefined ? {} : { expectEmail }),
        signal: abort.signal,
      });
    } finally {
      if (waiting === abort) waiting = null;
    }
    switch (result.status) {
      case "signed-in":
        break;
      case "failed":
        return { reply: failedReply(result.code) };
      default:
        return { reply: result.status };
    }

    const refreshCipher = await encryptPassword(result.refreshToken);
    const accessEndsAt =
      result.refreshTokenExpiresInSeconds === undefined
        ? undefined
        : nowSeconds(deps) + result.refreshTokenExpiresInSeconds;
    const stored = await serialized(() =>
      storeSignIn(deps.accountsPath, request.accountId, result.email, refreshCipher, accessEndsAt),
    );
    if (stored !== "stored") return { reply: stored };
    await notifyChanged(deps);
    return {
      reply: "signed-in",
      ...(result.refreshTokenExpiresInSeconds === undefined
        ? {}
        : {
            accessEndsInDays: Math.max(
              1,
              Math.round(result.refreshTokenExpiresInSeconds / SECONDS_PER_DAY),
            ),
          }),
    };
  });
}

async function storeSignIn(
  path: string,
  accountId: string | undefined,
  email: string,
  refreshCipher: string,
  accessEndsAt: number | undefined,
): Promise<"stored" | "unknown-account" | "duplicate" | "full"> {
  // A new token replaces the old limit: the date of the last sign-in is the only one that counts.
  const stored = {
    refreshCipher,
    ...(accessEndsAt === undefined ? {} : { accessEndsAt }),
  };
  const accounts = await loadAccounts(path);
  if (accountId !== undefined) {
    // The address was checked against the account's own in `signIn` (expectEmail); the account may be gone since.
    if (!accounts.some((a) => a.id === accountId && isGmailAccount(a))) return "unknown-account";
    await saveAccounts(
      path,
      accounts.map((a) =>
        a.id === accountId && isGmailAccount(a)
          ? { ...a, gmail: { email: a.gmail.email, ...stored } }
          : a,
      ),
    );
    return "stored";
  }
  if (accounts.length >= MAX_ACCOUNTS) return "full";
  const key = mailboxKey(email);
  const taken = accounts.some((a) =>
    isImapAccount(a)
      ? [a.imap.user, a.sieve.user].some((login) => mailboxKey(login.toLowerCase()) === key)
      : mailboxKey(a.gmail.email) === key,
  );
  if (taken) return "duplicate";
  const ids = new Set(accounts.map((a) => a.id));
  let id = `gmail-${randomUUID().slice(0, 8)}`;
  while (ids.has(id)) id = `gmail-${randomUUID().slice(0, 8)}`;
  await saveAccounts(path, [...accounts, { id, gmail: { email, ...stored } }]);
  return "stored";
}

/**
 * Revokes the stored tokens with the client they were issued by, at most MAX_CONCURRENT_REVOKES at a time; true per
 * account when the token is gone. Google's "already invalid" counts as gone (it is what a removal wants).
 */
async function revokeAll(
  oauth: OAuthClient,
  signedIn: readonly GmailAccountConfig[],
): Promise<Map<string, boolean>> {
  const gate = createGate(MAX_CONCURRENT_REVOKES);
  const done = await Promise.all(
    signedIn.map((account) =>
      gate(async () => {
        try {
          const cipher = account.gmail.refreshCipher;
          if (cipher === undefined) return [account.id, true] as const;
          await oauth.revoke(await decryptPassword(cipher));
          return [account.id, true] as const;
        } catch {
          return [account.id, false] as const;
        }
      }),
    ),
  );
  return new Map(done);
}

/** Drops the stored token of these accounts; address and id stay, the person signs in again. */
function signOut(accounts: readonly AccountConfig[], ids: ReadonlySet<string>): AccountConfig[] {
  return accounts.map((a) => {
    if (!isGmailAccount(a) || !ids.has(a.id)) return a;
    return { ...a, gmail: { email: a.gmail.email } };
  });
}

/**
 * Saves the app-wide Google client. Another client ID makes every stored token unusable (a token is bound to its
 * client), so with accounts signed in it asks for confirmation, revokes their tokens with the old client, signs them
 * out, and only then saves. A failed revoke leaves the client as it was. The same ID with a new secret keeps tokens.
 */
export function saveGoogleClientSettings(
  deps: GoogleDeps,
  input: GoogleClientInput,
): Promise<GoogleClientReply> {
  return exclusive<GoogleClientReply>("busy", async () => {
    // A client file that is not ours must not be a dead end: it is replaced, and what it held cannot be revoked.
    // Only that: an I/O error (a scanner holding the file) throws and the person tries again, nothing is dropped.
    const old = await loadGoogleClient(deps.clientPath).catch((error: unknown) => {
      if (error instanceof ClientFileInvalid) return "unreadable" as const;
      throw error;
    });
    const changed = old === "unreadable" || (old !== null && old.clientId !== input.clientId);
    let leftAccess = false;
    if (changed) {
      const signedIn = gmailAccounts(await loadAccounts(deps.accountsPath)).filter(
        (a) => a.gmail.refreshCipher !== undefined,
      );
      if (signedIn.length > 0) {
        if (!input.confirmSignOut) return "needs-confirm";
        // Unreadable: no client to revoke with. The tokens are useless without it, so they are dropped here and
        // the access Google still lists is the person's to remove.
        const revoked =
          old === "unreadable"
            ? new Map(signedIn.map((a) => [a.id, true] as const))
            : await revokeAll(deps.makeOAuth(old.clientId, clientSecretGetter(old)), signedIn);
        leftAccess = old === "unreadable";
        const gone = new Set([...revoked].filter(([, ok]) => ok).map(([id]) => id));
        // A token that is gone at Google is gone here too, whatever happens to the rest.
        await serialized(async () => {
          await saveAccounts(
            deps.accountsPath,
            signOut(await loadAccounts(deps.accountsPath), gone),
          );
        });
        await notifyChanged(deps);
        if (gone.size !== signedIn.length) return "revoke-failed";
      }
    }
    await saveGoogleClient(deps.clientPath, input.clientId, input.clientSecret);
    return leftAccess ? "saved-left-access" : "saved";
  });
}

/**
 * Removes a Gmail account (ADR 0009 point 3), in this order: uninstall our filters (none exist before the filter
 * adapter, which must put its step here), revoke the token, delete the ciphertext. A revoke that fails for any reason
 * but "this token is already invalid" keeps the account so the person can try again.
 */
export function removeGoogleAccount(
  deps: GoogleDeps,
  accountId: string,
): Promise<GoogleRemoveReply> {
  return exclusive<GoogleRemoveReply>("busy", async () => {
    const account = gmailAccounts(await loadAccounts(deps.accountsPath)).find(
      (a) => a.id === accountId,
    );
    if (account === undefined) return "unknown-account";
    const hadToken = account.gmail.refreshCipher !== undefined;
    if (hadToken) {
      const client = await loadGoogleClient(deps.clientPath);
      if (client === null) return "revoke-failed";
      const revoked = await revokeAll(deps.makeOAuth(client.clientId, clientSecretGetter(client)), [
        account,
      ]);
      if (revoked.get(account.id) !== true) return "revoke-failed";
    }
    await serialized(async () => {
      const accounts = await loadAccounts(deps.accountsPath);
      await saveAccounts(
        deps.accountsPath,
        accounts.filter((a) => a.id !== accountId),
      );
    });
    await notifyChanged(deps);
    // No token, no revoke: the page must not say the access was revoked.
    return hadToken ? "removed" : "removed-not-revoked";
  });
}
