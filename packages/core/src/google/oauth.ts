import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AdapterError } from "../adapter.js";
import { GOOGLE_TIMEOUT_MS, parseJson, readBounded } from "./http.js";
import type { GoogleCall } from "./http.js";

// Google OAuth 2.0 for a Desktop-app client, loopback redirect, PKCE.
// Read 2026-10-26: https://developers.google.com/identity/protocols/oauth2/native-app (endpoints, parameters, PKCE
// S256, optional client_secret, code_verifier 43-128 characters) and .../oauth2/web-server (`access_type=offline`).
// The hosts are fixed: a code or token is only ever sent to Google, never to an address a person typed.
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** The two scopes Senderban asks for, nothing wider (ADR 0009 point 2). Both are Restricted. */
export const GMAIL_FILTERS_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
export const GMAIL_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
export const GOOGLE_SCOPES = [GMAIL_FILTERS_SCOPE, GMAIL_METADATA_SCOPE] as const;

/**
 * Largest token sizes Google documents (https://developers.google.com/identity/protocols/oauth2, "Token size", read
 * 2026-10-26; Google may change sizes within these limits). Unit: bytes; every value is printable ASCII, so bytes =
 * characters. Anything larger is not a token of Google's.
 */
export const GOOGLE_TOKEN_BYTES = { code: 256, access: 2048, refresh: 512 } as const;
/** The PKCE verifier Google accepts: 43-128 characters of the unreserved set (native-app page, read 2026-10-26). */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const PRINTABLE = /^[!-~]+$/u;

/**
 * Random bytes behind the PKCE verifier and the `state`. 32 bytes = 256 bits; the verifier is 43 base64url
 * characters (Google: 43-128), the state is 43 as well (RFC 6749 §10.12 asks for an unguessable value).
 */
export const RANDOM_BYTES = 32;

export interface Pkce {
  readonly verifier: string;
  /** S256: base64url(SHA-256(verifier)), no padding. */
  readonly challenge: string;
}

export function newPkce(): Pkce {
  const verifier = randomBytes(RANDOM_BYTES).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function newState(): string {
  return randomBytes(RANDOM_BYTES).toString("base64url");
}

/** Constant-time comparison of the `state` that came back; any other length is a different value. */
export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The redirect URI of a loopback listener, in the form Google documents (`http://127.0.0.1:port`). */
export function loopbackRedirectUri(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("port must be an integer from 1 to 65535");
  }
  return `http://127.0.0.1:${String(port)}`;
}

export interface AuthUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  /** The address to preselect on Google's page (a re-sign-in), never a reason to trust the answer. */
  readonly loginHint?: string;
}

/**
 * The URL the browser is opened on. Built here from fixed parts so no value from the page or from a mail
 * decides the host or the scopes. `prompt=consent` makes Google issue a refresh token again on a repeat
 * sign-in; `access_type=offline` is what the web-server page names for it (the native-app page says refresh
 * tokens are always returned, so it costs nothing there).
 */
export function buildAuthUrl(input: AuthUrlInput): string {
  const url = new URL(GOOGLE_AUTH_URL);
  const params = url.searchParams;
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("response_type", "code");
  params.set("scope", GOOGLE_SCOPES.join(" "));
  params.set("state", input.state);
  params.set("code_challenge", input.challenge);
  params.set("code_challenge_method", "S256");
  params.set("access_type", "offline");
  params.set("prompt", "consent");
  if (input.loginHint !== undefined) params.set("login_hint", input.loginHint);
  return url.toString();
}

export type ScopeCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `scope-missing`: the answer named none; the others say what the person must fix. */
      readonly reason: "scope-missing" | "no-filter-scope" | "no-metadata-scope" | "extra-scope";
    };

/**
 * Google lets a person grant fewer scopes than asked, and the app must check what it got (granular consent). The
 * granted set must be exactly the two scopes: without the filter scope nothing can be blocked, without the metadata
 * scope there is no watcher, and an extra scope is refused and never stored (least privilege).
 */
export function checkGrantedScopes(scope: string | undefined): ScopeCheck {
  if (scope === undefined || scope.trim() === "") return { ok: false, reason: "scope-missing" };
  const granted = new Set(scope.split(/\s+/u).filter((s) => s !== ""));
  if (!granted.has(GMAIL_FILTERS_SCOPE)) return { ok: false, reason: "no-filter-scope" };
  if (!granted.has(GMAIL_METADATA_SCOPE)) return { ok: false, reason: "no-metadata-scope" };
  if (granted.size !== GOOGLE_SCOPES.length) return { ok: false, reason: "extra-scope" };
  return { ok: true };
}

export interface OAuthClientOptions {
  readonly clientId: string;
  /** Optional for a Desktop client (Google: a public client cannot keep it secret); read per call, never held. */
  readonly getClientSecret?: () => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Told after every request; nothing of the request or the answer. */
  readonly onCall?: (call: GoogleCall) => void;
}

/**
 * A token answer. Google may add fields, so this is bounded but not strict (unknown keys are stripped): a strict
 * schema would reject every sign-in on the day Google adds one. `expires_in` is seconds; Google's is about an hour.
 */
const TokenAnswer = z.object({
  // Printable ASCII only: a token goes into a header and a form, so one with a space or a line break is not Google's.
  access_token: z.string().max(GOOGLE_TOKEN_BYTES.access).regex(PRINTABLE),
  expires_in: z.number().int().min(1).max(86_400),
  refresh_token: z.string().max(GOOGLE_TOKEN_BYTES.refresh).regex(PRINTABLE).optional(),
  /** Only with time-based access (Google): seconds until the refresh token stops working. */
  refresh_token_expires_in: z.number().int().min(1).max(31_536_000).optional(),
  scope: z.string().max(2048).optional(),
  token_type: z
    .string()
    .max(32)
    .refine((v) => v.toLowerCase() === "bearer"),
});

export interface AccessGrant {
  readonly accessToken: string;
  /** Seconds the access token lives from now. */
  readonly expiresInSeconds: number;
  readonly scope: string | undefined;
}
export interface CodeGrant extends AccessGrant {
  readonly refreshToken: string;
  /** Set only when Google limited the access in time: the person is told when it ends (ADR 0009). */
  readonly refreshTokenExpiresInSeconds?: number;
}

/** What the caller hands over is checked too: a value that cannot be a token never reaches a request body or header. */
function printable(value: string, max: number, what: string): void {
  if (value.length === 0 || value.length > max || !PRINTABLE.test(value)) {
    throw new AdapterError("REJECTED", `${what} is not a valid value`);
  }
}

/** Error answers carry a short machine word in `error` (`invalid_grant`); the description is never read. */
function oauthReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && /^[a-z_]{1,64}$/u.test(error) ? error : null;
}

/** Fixed texts only: neither a code, a token, the client secret nor Google's own words reach a log or a toast. */
function tokenFailure(status: number, reason: string | null, what: string): AdapterError {
  if (reason === "invalid_grant") {
    return new AdapterError("AUTH_REQUIRED", `Google no longer accepts this sign-in (${what})`);
  }
  if (reason === "invalid_client" || reason === "unauthorized_client") {
    return new AdapterError("AUTH_REQUIRED", `Google does not accept the OAuth client (${what})`);
  }
  if (status === 429)
    return new AdapterError("QUOTA_EXCEEDED", `Google asked to slow down (${what})`);
  if (status >= 500) {
    return new AdapterError(
      "TRANSIENT",
      `Google is busy or unavailable (${what}, ${String(status)})`,
    );
  }
  return new AdapterError("REJECTED", `Google refused the request (${what}, ${String(status)})`);
}

export interface OAuthClient {
  /** Trades the code from the redirect for tokens. The answer must carry a refresh token. */
  exchangeCode(
    input: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
    signal?: AbortSignal,
  ): Promise<CodeGrant>;
  /** A new access token for a stored refresh token. */
  refresh(refreshToken: string, signal?: AbortSignal): Promise<AccessGrant>;
  /**
   * Revokes a token (Google: an access or a refresh token; revoking one revokes the grant). `already-invalid` is
   * Google's 400 `invalid_token`: the token was gone already, which is what a removal wants. Any other failure
   * throws, so the caller keeps the stored token and the person can try again.
   */
  revoke(token: string, signal?: AbortSignal): Promise<"revoked" | "already-invalid">;
}

export function createOAuthClient(options: OAuthClientOptions): OAuthClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? GOOGLE_TIMEOUT_MS;

  async function post(
    op: GoogleCall["op"],
    url: string,
    form: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; text: string }> {
    const body = new URLSearchParams(form);
    let secret: string | undefined;
    try {
      // A callback that throws at once, or rejects, ends the same way: a fixed text, never its own message.
      secret = await Promise.resolve().then(() => options.getClientSecret?.());
    } catch {
      throw new AdapterError("REJECTED", "the stored client secret cannot be read");
    }
    if (secret !== undefined && secret !== "") body.set("client_secret", secret);
    const deadline = AbortSignal.timeout(timeoutMs);
    const started = Date.now();
    const report = (status: number | null): void => {
      try {
        options.onCall?.({ op, status, ms: Date.now() - started });
      } catch {
        // a listener must not break a request
      }
    };
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        redirect: "error",
      });
      report(response.status);
      return { status: response.status, text: await readBounded(response, op) };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      report(null);
      if (signal?.aborted === true && signal.reason instanceof AdapterError) throw signal.reason;
      throw new AdapterError("TRANSIENT", `Google could not be reached (${op})`);
    }
  }

  function grant(status: number, text: string, op: "token" | "refresh") {
    const json = parseJson(text);
    if (status !== 200) throw tokenFailure(status, oauthReason(json), op);
    const parsed = TokenAnswer.safeParse(json);
    if (!parsed.success) throw new AdapterError("TRANSIENT", `Google answer is malformed (${op})`);
    return parsed.data;
  }

  return {
    async exchangeCode({ code, verifier, redirectUri }, signal) {
      printable(code, GOOGLE_TOKEN_BYTES.code, "the authorization code");
      if (!VERIFIER.test(verifier))
        throw new AdapterError("REJECTED", "the PKCE verifier is not valid");
      printable(redirectUri, 64, "the redirect address");
      const { status, text } = await post(
        "token",
        GOOGLE_TOKEN_URL,
        {
          client_id: options.clientId,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        },
        signal,
      );
      const data = grant(status, text, "token");
      if (data.refresh_token === undefined) {
        throw new AdapterError("AUTH_REQUIRED", "Google gave no refresh token (token)");
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresInSeconds: data.expires_in,
        scope: data.scope,
        ...(data.refresh_token_expires_in === undefined
          ? {}
          : { refreshTokenExpiresInSeconds: data.refresh_token_expires_in }),
      };
    },
    async refresh(refreshToken, signal) {
      printable(refreshToken, GOOGLE_TOKEN_BYTES.refresh, "the refresh token");
      const { status, text } = await post(
        "refresh",
        GOOGLE_TOKEN_URL,
        { client_id: options.clientId, grant_type: "refresh_token", refresh_token: refreshToken },
        signal,
      );
      const data = grant(status, text, "refresh");
      return {
        accessToken: data.access_token,
        expiresInSeconds: data.expires_in,
        scope: data.scope,
      };
    },
    async revoke(token, signal) {
      printable(token, GOOGLE_TOKEN_BYTES.access, "the token");
      const { status, text } = await post("revoke", GOOGLE_REVOKE_URL, { token }, signal);
      if (status === 200) return "revoked";
      const reason = oauthReason(parseJson(text));
      // Only Google's own "this token is not valid" counts as done; any other 400 means the token may still be live.
      if (status === 400 && reason === "invalid_token") return "already-invalid";
      throw tokenFailure(status, reason, "revoke");
    },
  };
}
