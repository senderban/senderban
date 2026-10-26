import { z } from "zod";
import { AdapterError } from "../adapter.js";
import { parseAddress } from "../address.js";
import {
  GOOGLE_TIMEOUT_MS,
  apiFailure,
  googleErrorReason,
  parseJson,
  readBounded,
} from "./http.js";
import type { GoogleCall } from "./http.js";

/** Gmail API, `users.getProfile` (read 2026-10-26; 1 quota unit; accepts the `gmail.metadata` scope). Fixed host. */
export const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/**
 * Bounded, not strict: Google may add fields (`messagesTotal`, `threadsTotal` are there already). `historyId` is a
 * decimal string that outgrows a double, so it stays a string and is compared as a BigInt where it is compared.
 */
const ProfileAnswer = z.object({
  emailAddress: z.string().min(3).max(254),
  historyId: z.string().regex(/^[0-9]{1,20}$/u),
});

export interface GmailProfile {
  /** The mailbox the token belongs to, in the canonical form `parseAddress` returns. */
  readonly email: string;
  readonly historyId: string;
}

export interface ProfileOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onCall?: (call: GoogleCall) => void;
}

/**
 * Who the token is for. This is where a Gmail account's address comes from: never typed by a person, and compared
 * on a re-sign-in so a browser that is signed in to another Google account cannot rebind a lane (ADR 0009 point 3).
 */
export async function fetchProfile(
  accessToken: string,
  options: ProfileOptions = {},
  signal?: AbortSignal,
): Promise<GmailProfile> {
  // The token goes into a header: a value with a space, CR or LF must never get that far.
  if (!/^[!-~]{1,2048}$/u.test(accessToken)) {
    throw new AdapterError("REJECTED", "the access token is not a valid value");
  }
  const doFetch = options.fetch ?? fetch;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? GOOGLE_TIMEOUT_MS);
  const started = Date.now();
  const report = (status: number | null): void => {
    try {
      options.onCall?.({ op: "profile", status, ms: Date.now() - started });
    } catch {
      // a listener must not break a request
    }
  };
  let status: number;
  let text: string;
  try {
    const response = await doFetch(GMAIL_PROFILE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      redirect: "error",
    });
    report(response.status);
    status = response.status;
    text = await readBounded(response, "profile");
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    report(null);
    if (signal?.aborted === true && signal.reason instanceof AdapterError) throw signal.reason;
    throw new AdapterError("TRANSIENT", "Google could not be reached (profile)");
  }
  const json = parseJson(text);
  if (status !== 200) throw apiFailure(status, googleErrorReason(json), "profile");
  const parsed = ProfileAnswer.safeParse(json);
  if (!parsed.success) throw new AdapterError("TRANSIENT", "Google answer is malformed (profile)");
  const address = parseAddress(parsed.data.emailAddress);
  // An address Senderban cannot hold is not stored half-way: the account cannot be identified, so it is refused.
  if (!address.ok)
    throw new AdapterError("REJECTED", "Google gave an address that cannot be used (profile)");
  return { email: address.value.address, historyId: parsed.data.historyId };
}
