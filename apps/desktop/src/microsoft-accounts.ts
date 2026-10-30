import { randomUUID } from "node:crypto";
import {
  MAX_ACCOUNTS,
  accountLogins,
  isMicrosoftAccount,
  isMicrosoftClientId,
  mailboxKey,
} from "@senderban/core";
import type { AccountConfig, MicrosoftAccountConfig, MicrosoftOAuthClient } from "@senderban/core";
import type { MicrosoftSignInOptions, MicrosoftSignInResult } from "@senderban/core/node";
import { encryptPassword, loadAccounts, saveAccounts, serialized } from "./accounts-file.js";
import type { MicrosoftRuleLifecycle } from "./microsoft-lanes.js";

/**
 * Senderban's app registration (public client: "Personal Microsoft accounts and any organization", redirect `http://localhost`, 008 §Microsoft).
 * An Application (client) ID is not a secret. Empty until the registration exists: the button then stays off and says why.
 */
export const MICROSOFT_CLIENT_ID = "";

/** The client ID to sign in with, or null while none is set. */
export function microsoftClientId(value: string = MICROSOFT_CLIENT_ID): string | null {
  return isMicrosoftClientId(value) ? value : null;
}

/** What the main process does with Microsoft; everything that touches the network or the OS is handed in. */
export interface MicrosoftDeps {
  readonly accountsPath: string;
  readonly clientId: string | null;
  readonly makeOAuth: (clientId: string) => MicrosoftOAuthClient;
  readonly signIn: (options: MicrosoftSignInOptions) => Promise<MicrosoftSignInResult>;
  /** Already limited to Microsoft's sign-in page. */
  readonly openBrowser: (url: string) => Promise<void>;
  /** Told after this module changed accounts.json. A throw is swallowed here; the caller logs it. */
  readonly onAccountsChanged?: () => Promise<void> | void;
  /** Rules of the account that Senderban leaves alone because they were changed in Outlook. */
  readonly editedRules?: (accountId: string) => number;
  /** What happens to Senderban's rules before the token goes. Absent: there are none (tests, no lanes). */
  readonly rules?: MicrosoftRuleLifecycle;
}

/** What the manage page may know: never a token. `available`: Senderban has an app registration to sign in with. */
export interface MicrosoftPageState {
  readonly available: boolean;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly email: string;
    readonly signedIn: boolean;
    /** Rules changed in Outlook, which Senderban leaves alone: their senders may not be blocked any more, and only the person can tell. */
    readonly editedRules: number;
  }[];
}

export type MicrosoftSignInReply =
  | "signed-in"
  | "no-client"
  | "unknown-account"
  | "cancelled"
  | "timeout"
  | "aborted"
  | "busy"
  | "browser-failed"
  /** Someone must approve Senderban, usually the organization's administrator. Nothing stored. */
  | "needs-approval"
  /** Microsoft granted less than was asked. Nothing stored. */
  | "scope"
  /** A re-sign-in ended in another Microsoft account. Nothing stored. */
  | "wrong-account"
  | "client-refused"
  | "unreachable"
  /** The mailbox is already set up (another account of ours, or an IMAP login on it). Nothing stored. */
  | "duplicate"
  | "full";

export type MicrosoftRemoveReply =
  | "removed"
  /** Removed, but Senderban could not reach the mailbox to delete its rules: they stay until the person deletes them. */
  | "removed-rules-remain"
  /** The account has rules and a token but no lane this session (a new sign-in): restart first, nothing was changed. */
  | "restart-first"
  /** Senderban's rules could not be deleted (Microsoft did not answer), so the account was kept. */
  | "rules-left"
  | "unknown-account"
  | "busy";

/** One Microsoft step at a time: a removal must not land between a sign-in and its save. */
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
export function cancelMicrosoftSignIn(): void {
  waiting?.abort();
}

async function notifyChanged(deps: MicrosoftDeps): Promise<void> {
  try {
    await deps.onAccountsChanged?.();
  } catch {
    // The change is already saved; a failing listener must not turn a stored sign-in into an error.
  }
}

function microsoftAccounts(accounts: readonly AccountConfig[]): MicrosoftAccountConfig[] {
  return accounts.filter(isMicrosoftAccount);
}

export async function microsoftState(deps: MicrosoftDeps): Promise<MicrosoftPageState> {
  const accounts = microsoftAccounts(await loadAccounts(deps.accountsPath));
  return {
    available: deps.clientId !== null,
    accounts: accounts.map((a) => ({
      accountId: a.id,
      email: a.microsoft.email,
      signedIn: a.microsoft.refreshCipher !== undefined,
      editedRules: deps.editedRules?.(a.id) ?? 0,
    })),
  };
}

function failedReply(code: string): MicrosoftSignInReply {
  return code === "AUTH_REQUIRED" || code === "REJECTED" ? "client-refused" : "unreachable";
}

/** Signs in a new Microsoft account, or signs an existing one in again. Stores only the encrypted refresh token. */
export function signInMicrosoftAccount(
  deps: MicrosoftDeps,
  request: { readonly accountId?: string },
): Promise<MicrosoftSignInReply> {
  return exclusive<MicrosoftSignInReply>("busy", async () => {
    const { clientId } = deps;
    if (clientId === null) return "no-client";

    let expectEmail: string | undefined;
    if (request.accountId !== undefined) {
      const known = microsoftAccounts(await loadAccounts(deps.accountsPath)).find(
        (a) => a.id === request.accountId,
      );
      if (known === undefined) return "unknown-account";
      expectEmail = known.microsoft.email;
    }

    const abort = new AbortController();
    waiting = abort;
    let result: MicrosoftSignInResult;
    try {
      result = await deps.signIn({
        clientId,
        oauth: deps.makeOAuth(clientId),
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
        return failedReply(result.code);
      default:
        return result.status;
    }

    const refreshCipher = await encryptPassword(result.refreshToken);
    const { email } = result;
    const stored = await serialized(() =>
      storeSignIn(deps.accountsPath, request.accountId, email, refreshCipher),
    );
    if (stored !== "stored") return stored;
    await notifyChanged(deps);
    return "signed-in";
  });
}

async function storeSignIn(
  path: string,
  accountId: string | undefined,
  email: string,
  refreshCipher: string,
): Promise<"stored" | "unknown-account" | "duplicate" | "full"> {
  const accounts = await loadAccounts(path);
  if (accountId !== undefined) {
    if (!accounts.some((a) => a.id === accountId && isMicrosoftAccount(a))) {
      return "unknown-account";
    }
    await saveAccounts(
      path,
      accounts.map((a) =>
        a.id === accountId && isMicrosoftAccount(a)
          ? { ...a, microsoft: { email: a.microsoft.email, refreshCipher } }
          : a,
      ),
    );
    return "stored";
  }
  if (accounts.length >= MAX_ACCOUNTS) return "full";
  const key = mailboxKey(email);
  if (accounts.some((a) => accountLogins(a).some((login) => mailboxKey(login) === key))) {
    return "duplicate";
  }
  const ids = new Set(accounts.map((a) => a.id));
  let id = `ms-${randomUUID().slice(0, 8)}`;
  while (ids.has(id)) id = `ms-${randomUUID().slice(0, 8)}`;
  await saveAccounts(path, [...accounts, { id, microsoft: { email, refreshCipher } }]);
  return "stored";
}

/**
 * A refresh token replaced itself: the new one is stored, so the access keeps living. The account may be gone by now, and then nothing is
 * written. Runs at most once per renewal (hourly at most, and only while rounds run).
 */
export async function storeRefreshToken(
  path: string,
  accountId: string,
  refreshToken: string,
): Promise<string | null> {
  const refreshCipher = await encryptPassword(refreshToken);
  return serialized(async () => {
    const accounts = await loadAccounts(path);
    if (!accounts.some((a) => a.id === accountId && isMicrosoftAccount(a))) return null;
    await saveAccounts(
      path,
      accounts.map((a) =>
        a.id === accountId && isMicrosoftAccount(a)
          ? { ...a, microsoft: { email: a.microsoft.email, refreshCipher } }
          : a,
      ),
    );
    return refreshCipher;
  });
}

/**
 * Removes a Microsoft account, in this order: uninstall our rules, then delete the stored token. There is no revoke to call: Microsoft gives a
 * public client none for one grant, so the page tells the person where to take the access away.
 */
export function removeMicrosoftAccount(
  deps: MicrosoftDeps,
  accountId: string,
): Promise<MicrosoftRemoveReply> {
  return exclusive<MicrosoftRemoveReply>("busy", async () => {
    const account = microsoftAccounts(await loadAccounts(deps.accountsPath)).find(
      (a) => a.id === accountId,
    );
    if (account === undefined) return "unknown-account";
    let rules: "ready" | "rules-left" | "unreachable" | "restart-first";
    try {
      rules = (await deps.rules?.prepare(accountId)) ?? "ready";
    } catch (error) {
      deps.rules?.abort(accountId);
      throw error;
    }
    if (rules === "rules-left" || rules === "restart-first") {
      deps.rules?.abort(accountId);
      return rules;
    }
    try {
      await serialized(async () => {
        const accounts = await loadAccounts(deps.accountsPath);
        await saveAccounts(
          deps.accountsPath,
          accounts.filter((a) => a.id !== accountId),
        );
      });
    } catch (error) {
      deps.rules?.abort(accountId);
      throw error;
    }
    deps.rules?.done(accountId);
    await notifyChanged(deps);
    return rules === "unreachable" ? "removed-rules-remain" : "removed";
  });
}
