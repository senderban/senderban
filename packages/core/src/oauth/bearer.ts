import { AdapterError } from "../adapter.js";
import { parseJson, readBounded } from "./http.js";
import type { ProviderName } from "./http.js";

export interface BearerRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly body?: string;
  /** More headers; the ones this caller sets win. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BearerCall<Op extends string> {
  readonly op: Op;
  readonly status: number | null;
  readonly ms: number;
}

export interface BearerAnswer {
  readonly status: number;
  readonly json: unknown;
  /** The `Retry-After` header as sent, for a caller that honours it. */
  readonly retryAfter: string | null;
}

export interface BearerCallerOptions<Op extends string> {
  /** Named in the fixed error texts. */
  readonly who: ProviderName;
  /**
   * An access token for this call; the caller owns refreshing and should cache it until it expires, not refresh per
   * call. It must throw `AdapterError` only: anything else is reported as a fixed `TRANSIENT`.
   */
  readonly getAccessToken: () => Promise<string>;
  /** The longest token this provider hands out. Unit: characters, printable ASCII only. */
  readonly maxTokenChars: number;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  /** Called once per request, when the answer's headers are in (or when no answer came). */
  readonly onCall?: (call: BearerCall<Op>) => void;
}

export type BearerCaller<Op extends string> = (
  op: Op,
  what: string,
  request: BearerRequest,
  maxBytes: number,
  signal: AbortSignal | undefined,
) => Promise<BearerAnswer>;

/**
 * One authenticated, bounded request to a fixed host: token checked, a deadline, one `onCall` entry per request, the body read
 * up to `maxBytes`, no redirect followed, every failure an `AdapterError` with a fixed text. Shared by every client that calls
 * a provider's API, so they cannot drift.
 */
export function createBearerCaller<Op extends string>(
  options: BearerCallerOptions<Op>,
): BearerCaller<Op> {
  const doFetch = options.fetch ?? fetch;
  const { who, maxTokenChars } = options;

  return async (op, what, request, maxBytes, signal) => {
    let accessToken: string;
    try {
      accessToken = await options.getAccessToken();
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("TRANSIENT", `the access token could not be had (${what})`);
    }
    // The token goes into a header: a value with a space, CR or LF must never get that far.
    if (
      accessToken.length === 0 ||
      accessToken.length > maxTokenChars ||
      !/^[!-~]+$/u.test(accessToken)
    ) {
      throw new AdapterError("REJECTED", "the access token is not a valid value");
    }
    const deadline = AbortSignal.timeout(options.timeoutMs);
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
          ...request.headers,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        redirect: "error",
      });
      report(response.status);
      const text = await readBounded(response, what, maxBytes, who);
      return {
        status: response.status,
        json: text === "" ? null : parseJson(text),
        retryAfter: response.headers.get("retry-after"),
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      report(null);
      if (signal?.aborted === true && signal.reason instanceof AdapterError) throw signal.reason;
      throw new AdapterError("TRANSIENT", `${who} could not be reached (${what})`);
    }
  };
}
