import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode } from "../adapter.js";
import { mailboxKey } from "../address.js";
import { askConsent, oneSignIn } from "../oauth/consent.js";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_BYTES, buildAuthUrl, checkGrantedScopes } from "./oauth.js";
import type { OAuthClient, ScopeCheck } from "./oauth.js";
import { fetchProfile } from "./profile.js";
import type { ProfileOptions } from "./profile.js";

export interface SignInOptions {
  readonly clientId: string;
  /** Made by the caller from the same client ID (and secret): it does the code exchange. */
  readonly oauth: OAuthClient;
  /**
   * Opens the URL in the person's browser. Called with a URL this module built on Google's fixed host; the caller
   * (Electron's `shell.openExternal`) should still refuse anything else.
   */
  readonly openBrowser: (url: string) => Promise<void>;
  /** A re-sign-in: the mailbox the account is bound to. Another mailbox in the end is refused (`wrong-account`). */
  readonly expectEmail?: string;
  readonly profile?: ProfileOptions;
  /** How long to wait for the browser, in milliseconds; defaults to `LOOPBACK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** How long `openBrowser` may take to return, in milliseconds; defaults to `OPEN_BROWSER_TIMEOUT_MS`. */
  readonly openBrowserTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type SignInResult =
  | {
      readonly status: "signed-in";
      readonly refreshToken: string;
      /** From `getProfile`, never typed: canonical form. */
      readonly email: string;
      readonly historyId: string;
      /** Set only when Google limited the access in time: tell the person when it ends. */
      readonly refreshTokenExpiresInSeconds?: number;
    }
  /** The person said no on Google's page. */
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" }
  | { readonly status: "aborted" }
  /** Another sign-in is already open: a double click starts one listener and one tab, not two. */
  | { readonly status: "busy" }
  | { readonly status: "browser-failed" }
  /** Google granted other scopes than the two asked (granular consent). Nothing is stored. */
  | {
      readonly status: "scope";
      readonly reason: Exclude<ScopeCheck, { readonly ok: true }>["reason"];
    }
  /** A re-sign-in ended in another Google account than the one the lane is bound to. Nothing is stored. */
  | { readonly status: "wrong-account" }
  | { readonly status: "failed"; readonly code: AdapterErrorCode };

const codeOf = (error: unknown): AdapterErrorCode =>
  error instanceof AdapterError ? error.code : "TRANSIENT";

/**
 * The whole sign-in (ADR 0009 points 1-3): PKCE and `state`, a loopback listener, the browser, the code exchange,
 * the scope check, then the profile for the mailbox identity. Single-flight. It stores nothing and sends no token
 * anywhere but Google; the caller encrypts the returned refresh token.
 *
 * It never revokes a token it refuses. Google's revoke removes every grant the person gave this project, so
 * revoking after a refused sign-in could break an account that is already set up. The caller tells the person that
 * the leftover access can be removed under Google Account permissions.
 */
export async function signIn(options: SignInOptions): Promise<SignInResult> {
  return (await oneSignIn(() => run(options))) ?? { status: "busy" };
}

async function run(options: SignInOptions): Promise<SignInResult> {
  const answer = await askConsent({
    authUrl: ({ redirectUri, state, pkce }) => {
      const url = buildAuthUrl({
        clientId: options.clientId,
        redirectUri,
        state,
        challenge: pkce.challenge,
        ...(options.expectEmail === undefined ? {} : { loginHint: options.expectEmail }),
      });
      return url.startsWith(`${GOOGLE_AUTH_URL}?`) ? url : null;
    },
    openBrowser: options.openBrowser,
    maxCodeBytes: GOOGLE_TOKEN_BYTES.code,
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
    // Google documents no such answer: a word it does not document is a refusal.
    case "needs-approval":
      return { status: "failed", code: "REJECTED" };
    default:
      return answer;
  }

  try {
    const grant = await options.oauth.exchangeCode(
      { code: answer.code, verifier: answer.verifier, redirectUri: answer.redirectUri },
      options.signal,
    );
    const scopes = checkGrantedScopes(grant.scope);
    if (!scopes.ok) return { status: "scope", reason: scopes.reason };
    const profile = await fetchProfile(grant.accessToken, options.profile, options.signal);
    if (
      options.expectEmail !== undefined &&
      mailboxKey(profile.email) !== mailboxKey(options.expectEmail)
    ) {
      return { status: "wrong-account" };
    }
    return {
      status: "signed-in",
      refreshToken: grant.refreshToken,
      email: profile.email,
      historyId: profile.historyId,
      ...(grant.refreshTokenExpiresInSeconds === undefined
        ? {}
        : { refreshTokenExpiresInSeconds: grant.refreshTokenExpiresInSeconds }),
    };
  } catch (error) {
    // An abort during the exchange or the profile call is the caller's own stop, not a Google outage.
    if (options.signal?.aborted === true) return { status: "aborted" };
    return { status: "failed", code: codeOf(error) };
  }
}
