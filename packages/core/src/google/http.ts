import { AdapterError } from "../adapter.js";

/** One request to Google: connect, answer and body. Unit: milliseconds. */
export const GOOGLE_TIMEOUT_MS = 15_000;
/**
 * Bytes read from one answer, at most. Unit: bytes. A token answer is about 1.5 KB and a profile about 200 bytes
 * (not measured on a real account: PROVISIONAL), so 64 KiB leaves a wide margin and a runaway answer is cut off.
 */
export const GOOGLE_BODY_MAX_BYTES = 65_536;

/** What the log may learn about a call: which operation, the HTTP status (null when it never got one), how long. */
export interface GoogleCall {
  readonly op:
    | "token"
    | "refresh"
    | "revoke"
    | "profile"
    | "filter-list"
    | "filter-create"
    | "filter-delete"
    | "history-list"
    | "message-get";
  readonly status: number | null;
  readonly ms: number;
}

/** The words of the error for an answer over the cap; a caller that must tell it from a passing failure looks for them. */
export const OVERSIZE = "larger than any valid one";

/** Reads the body in chunks and stops at the cap; the message is a fixed text, never part of the answer. */
export async function readBounded(
  response: Response,
  what: string,
  maxBytes: number = GOOGLE_BODY_MAX_BYTES,
): Promise<string> {
  const tooLarge = (): AdapterError =>
    new AdapterError("TRANSIENT", `Google answer is ${OVERSIZE} (${what})`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (chunk.done || chunk.value === undefined) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parses JSON from an answer body; anything that is not JSON is `null`, never an error carrying the text. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Gmail answers 403 both for a rate limit and for a missing permission (Gmail error guide), so a 403 is
 * classified by the machine-readable `reason`, never by the status alone. `null` when the body has none.
 */
export function googleErrorReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;
  const first: unknown = errors[0];
  if (typeof first !== "object" || first === null) return null;
  const reason = (first as { reason?: unknown }).reason;
  return typeof reason === "string" && /^[A-Za-z]{1,64}$/u.test(reason) ? reason : null;
}

const RATE_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

/** A failed Gmail API call as an adapter error. Fixed texts only: no body, no address, no token reaches a log. */
export function apiFailure(status: number, reason: string | null, what: string): AdapterError {
  if (status === 401)
    return new AdapterError("AUTH_REQUIRED", `Google refused the sign-in (${what})`);
  if (status === 429 || (status === 403 && reason !== null && RATE_REASONS.has(reason))) {
    return new AdapterError("QUOTA_EXCEEDED", `Google asked to slow down (${what})`);
  }
  if (status === 403) {
    return new AdapterError("AUTH_REQUIRED", `Google says the permission is missing (${what})`);
  }
  if (status >= 500) {
    return new AdapterError(
      "TRANSIENT",
      `Google is busy or unavailable (${what}, ${String(status)})`,
    );
  }
  return new AdapterError("REJECTED", `Google refused the request (${what}, ${String(status)})`);
}
