import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode } from "../adapter.js";
import { mailboxKey } from "../address.js";
import { askConsent, oneSignIn } from "../oauth/consent.js";
import {
  ApprovalRequiredError,
  MICROSOFT_AUTH_URL,
  MICROSOFT_TOKEN_BYTES,
  buildMicrosoftAuthUrl,
  checkGrantedGraphScopes,
  fetchGraphProfile,
} from "./oauth.js";
import type { GraphProfileOptions, GraphScopeCheck, MicrosoftOAuthClient } from "./oauth.js";

export interface MicrosoftSignInOptions {
  readonly clientId: string;
  /** Made by the caller from the same client ID: it does the code exchange. */
  readonly oauth: MicrosoftOAuthClient;
  /** Opens the URL in the person's browser. The caller (Electron's `shell.openExternal`) should still refuse anything but this host. */
  readonly openBrowser: (url: string) => Promise<void>;
  /** A re-sign-in: the mailbox the account is bound to. Another mailbox in the end is refused (`wrong-account`). */
  readonly expectEmail?: string;
  readonly profile?: GraphProfileOptions;
  readonly timeoutMs?: number;
  readonly openBrowserTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type MicrosoftSignInResult =
  | {
      readonly status: "signed-in";
      readonly refreshToken: string;
      /** From `/me`, never typed: canonical form. */
      readonly email: string;
    }
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" }
  | { readonly status: "aborted" }
  | { readonly status: "busy" }
  | { readonly status: "browser-failed" }
  /** Someone must approve Senderban first, usually the organization's administrator. Nothing is stored. */
  | { readonly status: "needs-approval" }
  /** Microsoft granted less than was asked. Nothing is stored. */
  | {
      readonly status: "scope";
      readonly reason: Exclude<GraphScopeCheck, { readonly ok: true }>["reason"];
    }
  /** A re-sign-in ended in another Microsoft account than the one the lane is bound to. Nothing is stored. */
  | { readonly status: "wrong-account" }
  | { readonly status: "failed"; readonly code: AdapterErrorCode };

/**
 * The whole sign-in: PKCE and `state`, a loopback listener on `http://localhost:<port>` (the redirect Microsoft recommends for an app that
 * uses the system browser, and its port is ignored in matching), the code exchange, the scope check, then `/me` for the mailbox identity.
 * Single-flight with every other provider's sign-in. It stores nothing; the caller encrypts the returned refresh token.
 */
export async function signInMicrosoft(
  options: MicrosoftSignInOptions,
): Promise<MicrosoftSignInResult> {
  return (await oneSignIn(() => run(options))) ?? { status: "busy" };
}

async function run(options: MicrosoftSignInOptions): Promise<MicrosoftSignInResult> {
  const answer = await askConsent({
    hostName: "localhost",
    maxCodeBytes: MICROSOFT_TOKEN_BYTES.code,
    authUrl: ({ redirectUri, state, pkce }) => {
      const url = buildMicrosoftAuthUrl({
        clientId: options.clientId,
        redirectUri,
        state,
        challenge: pkce.challenge,
        ...(options.expectEmail === undefined ? {} : { loginHint: options.expectEmail }),
      });
      return url.startsWith(`${MICROSOFT_AUTH_URL}?`) ? url : null;
    },
    openBrowser: options.openBrowser,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.openBrowserTimeoutMs === undefined
      ? {}
      : { openBrowserTimeoutMs: options.openBrowserTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  switch (answer.status) {
    case "approved":
      break;
    case "failed":
      return { status: "failed", code: answer.listener ? "TRANSIENT" : "REJECTED" };
    default:
      return answer;
  }

  try {
    const grant = await options.oauth.exchangeCode(
      { code: answer.code, verifier: answer.verifier, redirectUri: answer.redirectUri },
      options.signal,
    );
    const scopes = checkGrantedGraphScopes(grant.scope);
    if (!scopes.ok) return { status: "scope", reason: scopes.reason };
    const profile = await fetchGraphProfile(grant.accessToken, options.profile, options.signal);
    if (
      options.expectEmail !== undefined &&
      mailboxKey(profile.email) !== mailboxKey(options.expectEmail)
    ) {
      return { status: "wrong-account" };
    }
    return { status: "signed-in", refreshToken: grant.refreshToken, email: profile.email };
  } catch (error) {
    if (options.signal?.aborted === true) return { status: "aborted" };
    if (error instanceof ApprovalRequiredError) return { status: "needs-approval" };
    return { status: "failed", code: error instanceof AdapterError ? error.code : "TRANSIENT" };
  }
}
