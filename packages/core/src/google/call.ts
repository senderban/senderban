import { createBearerCaller } from "../oauth/bearer.js";
import type { BearerRequest } from "../oauth/bearer.js";
import { GOOGLE_TIMEOUT_MS } from "./http.js";
import type { GoogleCall } from "./http.js";

export type GoogleRequest = Omit<BearerRequest, "method"> & {
  readonly method: "GET" | "POST" | "DELETE";
};

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

/** Largest access token Google documents, in characters (`GOOGLE_TOKEN_BYTES` in oauth.ts holds the page reference). */
const GOOGLE_ACCESS_TOKEN_MAX_CHARS = 2048;

/** The shared caller, with Google's name, deadline and token size. */
export function createGoogleCaller(options: GoogleCallerOptions): GoogleCaller {
  return createBearerCaller<GoogleCall["op"]>({
    who: "Google",
    getAccessToken: options.getAccessToken,
    maxTokenChars: GOOGLE_ACCESS_TOKEN_MAX_CHARS,
    timeoutMs: options.timeoutMs ?? GOOGLE_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
  });
}
