import { startLoopback } from "./loopback.js";
import type { Loopback } from "./loopback.js";
import { newPkce, newState } from "./pkce.js";
import type { LoopbackHostName, Pkce } from "./pkce.js";

/**
 * How long opening the browser may take before the sign-in gives up on it. Unit: milliseconds. PROVISIONAL: starting
 * a browser is quick; a call that does not return in this time (a hung `shell.openExternal`) must not hold the single
 * sign-in slot, which would answer `busy` to every later attempt until a restart.
 */
export const OPEN_BROWSER_TIMEOUT_MS = 15_000;

/** The first half of every sign-in: the person answered in the browser, or did not. */
export type ConsentResult =
  | {
      readonly status: "approved";
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
    }
  /** The person said no on the provider's page. */
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" }
  | { readonly status: "aborted" }
  | { readonly status: "browser-failed" }
  /** The provider's page answered `consent_required`: someone else has to approve this app. */
  | { readonly status: "needs-approval" }
  /** No listener could start, or the answer was not one a sign-in can use. */
  | { readonly status: "failed"; readonly listener: boolean };

export interface ConsentOptions {
  /** Builds the provider's URL from fixed parts; `null` means it did not come out on the provider's host. */
  readonly authUrl: (input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly pkce: Pkce;
  }) => string | null;
  /**
   * Opens the URL in the person's browser. Called with a URL this module's caller built on the provider's fixed host; the
   * caller (Electron's `shell.openExternal`) should still refuse anything else.
   */
  readonly openBrowser: (url: string) => Promise<void>;
  readonly hostName?: LoopbackHostName;
  /** The longest code this provider sends. Unit: bytes. */
  readonly maxCodeBytes?: number;
  /** How long to wait for the browser, in milliseconds; defaults to `LOOPBACK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** How long `openBrowser` may take to return, in milliseconds; defaults to `OPEN_BROWSER_TIMEOUT_MS`. */
  readonly openBrowserTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

let running = false;

/**
 * One sign-in at a time, whichever provider: a double click starts one listener and one tab, not two. `null` when another
 * sign-in is already open.
 */
export async function oneSignIn<T>(work: () => Promise<T>): Promise<T | null> {
  if (running) return null;
  running = true;
  try {
    return await work();
  } finally {
    running = false;
  }
}

/** PKCE and `state`, a loopback listener, the browser, the answer (RFC 8252). It stores nothing and sees no token. */
export async function askConsent(options: ConsentOptions): Promise<ConsentResult> {
  const pkce = newPkce();
  const state = newState();
  let loopback: Loopback;
  try {
    loopback = await startLoopback({
      state,
      ...(options.hostName === undefined ? {} : { hostName: options.hostName }),
      ...(options.maxCodeBytes === undefined ? {} : { maxCodeBytes: options.maxCodeBytes }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { status: "failed", listener: true };
  }

  const url = options.authUrl({ redirectUri: loopback.redirectUri, state, pkce });
  if (url === null) {
    loopback.close();
    return { status: "failed", listener: false };
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
  if (answer.kind === "needs-approval") return { status: "needs-approval" };
  if (answer.kind === "failed") {
    if (answer.reason === "timeout") return { status: "timeout" };
    if (answer.reason === "aborted") return { status: "aborted" };
    return { status: "failed", listener: false };
  }
  return {
    status: "approved",
    code: answer.code,
    verifier: pkce.verifier,
    redirectUri: loopback.redirectUri,
  };
}
