import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode } from "../adapter.js";
import { mailboxKey } from "../address.js";
import { startLoopback } from "./loopback.js";
import { GOOGLE_AUTH_URL, buildAuthUrl, checkGrantedScopes, newPkce, newState } from "./oauth.js";
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

/**
 * How long opening the browser may take before the sign-in gives up on it. Unit: milliseconds. PROVISIONAL: starting
 * a browser is quick; a call that does not return in this time (a hung `shell.openExternal`) must not hold the single
 * sign-in slot, which would answer `busy` to every later attempt until a restart.
 */
export const OPEN_BROWSER_TIMEOUT_MS = 15_000;

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

let running = false;

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
  if (running) return { status: "busy" };
  running = true;
  try {
    return await run(options);
  } finally {
    running = false;
  }
}

async function run(options: SignInOptions): Promise<SignInResult> {
  const pkce = newPkce();
  const state = newState();
  let loopback: Awaited<ReturnType<typeof startLoopback>>;
  try {
    loopback = await startLoopback({
      state,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { status: "failed", code: "TRANSIENT" };
  }

  const url = buildAuthUrl({
    clientId: options.clientId,
    redirectUri: loopback.redirectUri,
    state,
    challenge: pkce.challenge,
    ...(options.expectEmail === undefined ? {} : { loginHint: options.expectEmail }),
  });
  if (!url.startsWith(`${GOOGLE_AUTH_URL}?`)) {
    loopback.close();
    return { status: "failed", code: "REJECTED" };
  }
  // The call may fail, hang, or be overtaken by an abort: none of them keeps the slot.
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, options.openBrowserTimeoutMs ?? OPEN_BROWSER_TIMEOUT_MS);
    });
    const outcome = await Promise.race([
      options.openBrowser(url).then(() => "opened" as const),
      timedOut,
      loopback.result.then(() => "settled" as const),
    ]);
    if (outcome === "timeout") {
      loopback.close();
      return { status: "browser-failed" };
    }
  } catch {
    loopback.close();
    return { status: "browser-failed" };
  } finally {
    clearTimeout(timer);
  }

  const answer = await loopback.result;
  if (answer.kind === "denied") return { status: "cancelled" };
  if (answer.kind === "failed") {
    if (answer.reason === "timeout") return { status: "timeout" };
    if (answer.reason === "aborted") return { status: "aborted" };
    return { status: "failed", code: "REJECTED" };
  }

  try {
    const grant = await options.oauth.exchangeCode(
      { code: answer.code, verifier: pkce.verifier, redirectUri: loopback.redirectUri },
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
