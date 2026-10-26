import { createHash } from "node:crypto";
import {
  GMAIL_METADATA_SCOPE,
  GMAIL_FILTERS_SCOPE,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
} from "../../src/google/oauth.js";
import { GMAIL_PROFILE_URL } from "../../src/google/profile.js";

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The form body, parsed, for the OAuth endpoints. */
  readonly form: Readonly<Record<string, string>>;
  readonly redirect: string | undefined;
}

export const CODE = "4/0AX-the-authorization-code";
export const ACCESS = "ya29.the-access-token";
export const REFRESH = "1//the-refresh-token";
export const SECRET = "GOCSPX-the-client-secret";

/**
 * In-memory stand-in for Google's OAuth and profile endpoints. It checks the PKCE pairing itself (the verifier must
 * hash to the challenge the test registered), so a client that sends the wrong verifier fails here as it would there.
 * Statuses and bodies follow the documented ones; the error word `invalid_grant` is Google's own.
 */
export class FakeGoogle {
  readonly calls: RecordedCall[] = [];
  challenge = "";
  scope = `${GMAIL_FILTERS_SCOPE} ${GMAIL_METADATA_SCOPE}`;
  email = "me@gmail.com";
  historyId = "1234567";
  /** Forced raw answer for the next requests, consumed one per request. */
  readonly forced: { status: number; body: string; headers?: Record<string, string> }[] = [];
  failNetwork = 0;
  /** Makes a request wait until the caller's signal aborts, like a server that never answers. */
  stall = false;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    const form: Record<string, string> = {};
    if (typeof init?.body === "string") {
      for (const [k, v] of new URLSearchParams(init.body)) form[k] = v;
    }
    this.calls.push({
      method: init?.method ?? "GET",
      url,
      headers,
      form,
      redirect: init?.redirect,
    });
    // A real fetch rejects at once on a signal that is already aborted.
    init?.signal?.throwIfAborted();
    if (this.stall) {
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted"));
        });
      });
    }
    init?.signal?.throwIfAborted();
    if (this.failNetwork > 0) {
      this.failNetwork -= 1;
      throw new TypeError("fetch failed");
    }
    const forced = this.forced.shift();
    if (forced !== undefined) {
      return new Response(forced.body, { status: forced.status, headers: forced.headers ?? {} });
    }
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url === GOOGLE_TOKEN_URL) {
      if (form["grant_type"] === "authorization_code") {
        const pairs =
          createHash("sha256")
            .update(form["code_verifier"] ?? "")
            .digest("base64url") === this.challenge;
        if (form["code"] !== CODE || !pairs) return json(400, { error: "invalid_grant" });
        return json(200, {
          access_token: ACCESS,
          expires_in: 3599,
          refresh_token: REFRESH,
          scope: this.scope,
          token_type: "Bearer",
          a_field_google_may_add_later: true,
        });
      }
      if (form["grant_type"] === "refresh_token") {
        if (form["refresh_token"] !== REFRESH) return json(400, { error: "invalid_grant" });
        return json(200, {
          access_token: ACCESS,
          expires_in: 3599,
          scope: this.scope,
          token_type: "Bearer",
        });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url === GOOGLE_REVOKE_URL) {
      return form["token"] === REFRESH || form["token"] === ACCESS
        ? json(200, {})
        : json(400, { error: "invalid_token" });
    }
    if (url === GMAIL_PROFILE_URL) {
      if (headers["Authorization"] !== `Bearer ${ACCESS}`) {
        return json(401, { error: { code: 401, message: "Invalid Credentials" } });
      }
      return json(200, {
        emailAddress: this.email,
        historyId: this.historyId,
        messagesTotal: 10,
        threadsTotal: 5,
      });
    }
    return new Response(null, { status: 404 });
  };
}
