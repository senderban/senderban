import { AdapterError } from "../adapter.js";
import { GOOGLE_TIMEOUT_MS, parseJson, readBounded } from "./http.js";
import type { GoogleCall } from "./http.js";

export interface GoogleRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly body?: string;
}

export interface GoogleCallerOptions {
  /**
   * An access token for this call; the caller owns refreshing and should cache it until it expires (3,599 s measured),
   * not refresh per call. It must throw `AdapterError` only: anything else is reported as a fixed `TRANSIENT`.
   */
  readonly getAccessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Called once per request, when the answer's headers are in (or when no answer came). */
  readonly onCall?: (call: GoogleCall) => void;
}

export type GoogleCaller = (
  op: GoogleCall["op"],
  what: string,
  request: GoogleRequest,
  maxBytes: number,
  signal: AbortSignal | undefined,
) => Promise<{ status: number; json: unknown }>;

/**
 * One authenticated, bounded request to a fixed Google host: token checked, a deadline, one `onCall` entry per request, the
 * body read up to `maxBytes`, no redirect followed, every failure an `AdapterError` with a fixed text. Shared by the filter
 * client and the mail client so the two cannot drift.
 */
export function createGoogleCaller(options: GoogleCallerOptions): GoogleCaller {
  const doFetch = options.fetch ?? fetch;

  return async (op, what, request, maxBytes, signal) => {
    let accessToken: string;
    try {
      accessToken = await options.getAccessToken();
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("TRANSIENT", `the access token could not be had (${what})`);
    }
    // The token goes into a header: a value with a space, CR or LF must never get that far.
    if (!/^[!-~]{1,2048}$/u.test(accessToken)) {
      throw new AdapterError("REJECTED", "the access token is not a valid value");
    }
    const deadline = AbortSignal.timeout(options.timeoutMs ?? GOOGLE_TIMEOUT_MS);
    const started = Date.now();
    let reported = false;
    const report = (status: number | null): void => {
      // One entry per request: a failure while the body is read must not add a second one (it would count twice).
      if (reported) return;
      reported = true;
      try {
        options.onCall?.({ op, status, ms: Date.now() - started });
      } catch {
        // a listener must not break a request
      }
    };
    try {
      const response = await doFetch(request.url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        redirect: "error",
      });
      report(response.status);
      const text = await readBounded(response, what, maxBytes);
      return { status: response.status, json: text === "" ? null : parseJson(text) };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      report(null);
      if (signal?.aborted === true && signal.reason instanceof AdapterError) throw signal.reason;
      throw new AdapterError("TRANSIENT", `Google could not be reached (${what})`);
    }
  };
}
