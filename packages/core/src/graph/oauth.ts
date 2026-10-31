import { z } from "zod";
import { AdapterError } from "../adapter.js";
import { parseAddress } from "../address.js";
import { createBearerCaller } from "../oauth/bearer.js";
import type { BearerCall } from "../oauth/bearer.js";
import { parseJson, readBounded } from "../oauth/http.js";
import { PKCE_VERIFIER } from "../oauth/pkce.js";
import { GRAPH_ACCESS_TOKEN_MAX_CHARS, GRAPH_BODY_MAX_BYTES, GRAPH_TIMEOUT_MS } from "./client.js";

// Microsoft identity platform, authorization code flow with PKCE for a public client.
// Read 2026-10-31: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow and .../reply-url.
// `common` takes personal and work accounts. The host is fixed: a code or token is only ever sent to Microsoft.
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
export const MICROSOFT_AUTH_URL = `${AUTHORITY}/authorize`;
export const MICROSOFT_TOKEN_URL = `${AUTHORITY}/token`;
export const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName";

const GRAPH_RESOURCE = "https://graph.microsoft.com/";
/** Reads and writes Inbox rules, and nothing else of the mailbox settings Senderban uses. */
export const GRAPH_RULES_SCOPE = "MailboxSettings.ReadWrite";
/** The least that reads the Junk folder's id; it reads no message body (mailfolder-get, permissions table). */
export const GRAPH_FOLDER_SCOPE = "Mail.ReadBasic";
/** The least that says who signed in (user-get, permissions table). */
export const GRAPH_PROFILE_SCOPE = "User.Read";
/** What the app asks for. `offline_access` is what brings a refresh token. */
export const GRAPH_SCOPES = [
  `${GRAPH_RESOURCE}${GRAPH_RULES_SCOPE}`,
  `${GRAPH_RESOURCE}${GRAPH_FOLDER_SCOPE}`,
  `${GRAPH_RESOURCE}${GRAPH_PROFILE_SCOPE}`,
  "offline_access",
] as const;

/**
 * Token sizes. Unit: bytes; every value is printable ASCII, so bytes = characters. Microsoft documents none and says tokens are opaque
 * and may change, so these are wide, not measured. PROVISIONAL: tighten to the first real ones. `code` must fit the loopback request.
 */
export const MICROSOFT_TOKEN_BYTES = {
  code: 4_096,
  access: GRAPH_ACCESS_TOKEN_MAX_CHARS,
  refresh: 8_192,
} as const;

const PRINTABLE = /^[!-~]+$/u;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** An Application (client) ID. Not a secret: Microsoft treats a desktop app as a public client. */
export function isMicrosoftClientId(value: string): boolean {
  return GUID.test(value);
}

export interface MicrosoftAuthUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  /** The address to preselect (a re-sign-in), never a reason to trust the answer. */
  readonly loginHint?: string;
}

/** The URL the browser is opened on, built from fixed parts. `select_account`: a browser signed in elsewhere must not pick the mailbox. */
export function buildMicrosoftAuthUrl(input: MicrosoftAuthUrlInput): string {
  const url = new URL(MICROSOFT_AUTH_URL);
  const params = url.searchParams;
  params.set("client_id", input.clientId);
  params.set("response_type", "code");
  params.set("redirect_uri", input.redirectUri);
  params.set("response_mode", "query");
  params.set("scope", GRAPH_SCOPES.join(" "));
  params.set("state", input.state);
  params.set("code_challenge", input.challenge);
  params.set("code_challenge_method", "S256");
  params.set("prompt", "select_account");
  if (input.loginHint !== undefined) params.set("login_hint", input.loginHint);
  return url.toString();
}

export type GraphScopeCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "no-rules-scope" | "no-folder-scope" | "no-profile-scope";
    };

/** A scope as it comes back: with or without the resource, in Microsoft's own capitals, percent-encoded in the docs' sample. */
function scopeWords(scope: string): Set<string> {
  let text = scope;
  try {
    text = decodeURIComponent(scope);
  } catch {
    // not encoded after all
  }
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/u)
      .filter((s) => s !== "")
      .map((s) => (s.startsWith(GRAPH_RESOURCE) ? s.slice(GRAPH_RESOURCE.length) : s)),
  );
}

/**
 * What was granted must hold the three permissions. `scope` is optional at the token endpoint and then means "what was asked". A wider
 * grant is not refused, unlike Google's: Microsoft answers with everything this app was ever granted in the tenant (an admin may have
 * given more), the app asks for no more than this, and a refusal would be a dead end the person cannot fix.
 */
export function checkGrantedGraphScopes(scope: string | undefined): GraphScopeCheck {
  if (scope === undefined || scope.trim() === "") return { ok: true };
  const granted = scopeWords(scope);
  if (!granted.has(GRAPH_RULES_SCOPE.toLowerCase())) return { ok: false, reason: "no-rules-scope" };
  if (!granted.has(GRAPH_FOLDER_SCOPE.toLowerCase())) {
    return { ok: false, reason: "no-folder-scope" };
  }
  if (!granted.has(GRAPH_PROFILE_SCOPE.toLowerCase())) {
    return { ok: false, reason: "no-profile-scope" };
  }
  return { ok: true };
}

const ASKED_SCOPES: ReadonlySet<string> = new Set(
  [
    GRAPH_RULES_SCOPE,
    GRAPH_FOLDER_SCOPE,
    GRAPH_PROFILE_SCOPE,
    "offline_access",
    "openid",
    "profile",
    "email",
  ].map((s) => s.toLowerCase()),
);

/**
 * How many permissions a token holds beyond what Senderban asks for. Not refused (see above), but a consent link with wider scopes can widen what the
 * next token holds, because the client ID is public, so the log says so: a count, never the names.
 */
export function graphScopeExtras(scope: string | undefined): number {
  if (scope === undefined) return 0;
  return [...scopeWords(scope)].filter((word) => !ASKED_SCOPES.has(word)).length;
}

/** A token answer. Microsoft may add fields (`ext_expires_in` is there already): bounded, not strict. `expires_in` is seconds. */
const TokenAnswer = z.object({
  access_token: z.string().max(MICROSOFT_TOKEN_BYTES.access).regex(PRINTABLE),
  expires_in: z.number().int().min(1).max(86_400),
  refresh_token: z.string().max(MICROSOFT_TOKEN_BYTES.refresh).regex(PRINTABLE).optional(),
  scope: z.string().max(2_048).optional(),
  token_type: z
    .string()
    .max(32)
    .refine((v) => v.toLowerCase() === "bearer"),
});

const TokenError = z.object({
  error: z.string().regex(/^[a-z_]{1,64}$/u),
  error_codes: z.array(z.number().int().min(0).max(99_999_999)).max(16).optional(),
});

/**
 * AADSTS codes that mean someone must approve this app: 65001 no consent yet, 90094 administrator consent required, 90008 the same for the
 * sign-in permission (reference-error-codes, read 2026-10-31).
 */
const APPROVAL_CODES: ReadonlySet<number> = new Set([65_001, 90_008, 90_094]);

/** Someone must approve this app, usually the organization's administrator: signing in again changes nothing. */
export class ApprovalRequiredError extends AdapterError {
  constructor(what: string) {
    super("AUTH_REQUIRED", `Your organization must approve Senderban (${what})`);
    this.name = "ApprovalRequiredError";
  }
}

/** Fixed texts only: neither a code, a token nor Microsoft's own words reach a log or a toast. */
function tokenFailure(status: number, body: unknown, what: string): AdapterError {
  const parsed = TokenError.safeParse(body);
  const reason = parsed.success ? parsed.data.error : null;
  const codes = parsed.success ? (parsed.data.error_codes ?? []) : [];
  if (reason === "consent_required" || codes.some((code) => APPROVAL_CODES.has(code))) {
    return new ApprovalRequiredError(what);
  }
  if (reason === "invalid_grant" || reason === "interaction_required") {
    return new AdapterError("AUTH_REQUIRED", `Microsoft no longer accepts this sign-in (${what})`);
  }
  if (reason === "invalid_client" || reason === "unauthorized_client") {
    return new AdapterError(
      "AUTH_REQUIRED",
      `Microsoft does not accept Senderban's client (${what})`,
    );
  }
  if (status === 429)
    return new AdapterError("QUOTA_EXCEEDED", `Microsoft asked to slow down (${what})`);
  if (reason === "temporarily_unavailable" || status >= 500) {
    return new AdapterError(
      "TRANSIENT",
      `Microsoft is busy or unavailable (${what}, ${String(status)})`,
    );
  }
  return new AdapterError("REJECTED", `Microsoft refused the request (${what}, ${String(status)})`);
}

/** What the log may learn about a sign-in request: which one, the HTTP status, how long. */
export type MicrosoftCall = BearerCall<"token" | "refresh" | "profile">;

export interface MicrosoftOAuthOptions {
  readonly clientId: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onCall?: (call: MicrosoftCall) => void;
}

export interface MicrosoftCodeGrant {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scope: string | undefined;
}

export interface MicrosoftAccessGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly scope: string | undefined;
  /** Refresh tokens replace themselves on use: the new one is kept, the old one dropped (refresh-tokens page). */
  readonly refreshToken?: string;
}

export interface MicrosoftOAuthClient {
  /** Trades the code from the redirect for tokens. The answer must carry a refresh token. */
  exchangeCode(
    input: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
    signal?: AbortSignal,
  ): Promise<MicrosoftCodeGrant>;
  /** A new access token for a stored refresh token. */
  refresh(refreshToken: string, signal?: AbortSignal): Promise<MicrosoftAccessGrant>;
}

function checked(value: string, max: number, what: string): void {
  if (value.length === 0 || value.length > max || !PRINTABLE.test(value)) {
    throw new AdapterError("REJECTED", `${what} is not a valid value`);
  }
}

/** No secret: a public client must not send one ("must not use secrets or certificates when redeeming an authorization code"). */
export function createMicrosoftOAuthClient(options: MicrosoftOAuthOptions): MicrosoftOAuthClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? GRAPH_TIMEOUT_MS;

  async function post(
    op: "token" | "refresh",
    form: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<z.infer<typeof TokenAnswer>> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const started = Date.now();
    let reported = false;
    const report = (status: number | null): void => {
      if (reported) return;
      reported = true;
      try {
        options.onCall?.({ op, status, ms: Date.now() - started });
      } catch {
        // a listener must not break a request
      }
    };
    let status: number;
    let text: string;
    try {
      const response = await doFetch(MICROSOFT_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        redirect: "error",
      });
      report(response.status);
      status = response.status;
      text = await readBounded(response, op, GRAPH_BODY_MAX_BYTES, "Microsoft");
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      report(null);
      if (signal?.aborted === true && signal.reason instanceof AdapterError) throw signal.reason;
      throw new AdapterError("TRANSIENT", `Microsoft could not be reached (${op})`);
    }
    const json = parseJson(text);
    if (status !== 200) throw tokenFailure(status, json, op);
    const parsed = TokenAnswer.safeParse(json);
    if (!parsed.success) {
      throw new AdapterError("TRANSIENT", `Microsoft answer is malformed (${op})`);
    }
    return parsed.data;
  }

  return {
    async exchangeCode({ code, verifier, redirectUri }, signal) {
      checked(code, MICROSOFT_TOKEN_BYTES.code, "the authorization code");
      if (!PKCE_VERIFIER.test(verifier)) {
        throw new AdapterError("REJECTED", "the PKCE verifier is not valid");
      }
      checked(redirectUri, 64, "the redirect address");
      const data = await post(
        "token",
        {
          client_id: options.clientId,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          scope: GRAPH_SCOPES.join(" "),
        },
        signal,
      );
      if (data.refresh_token === undefined) {
        throw new AdapterError("AUTH_REQUIRED", "Microsoft gave no refresh token (token)");
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresInSeconds: data.expires_in,
        scope: data.scope,
      };
    },
    async refresh(refreshToken, signal) {
      checked(refreshToken, MICROSOFT_TOKEN_BYTES.refresh, "the refresh token");
      const data = await post(
        "refresh",
        {
          client_id: options.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: GRAPH_SCOPES.join(" "),
        },
        signal,
      );
      return {
        accessToken: data.access_token,
        expiresInSeconds: data.expires_in,
        scope: data.scope,
        ...(data.refresh_token === undefined ? {} : { refreshToken: data.refresh_token }),
      };
    },
  };
}

/** A user's id at Graph: a GUID at work, 16 hex digits for a personal account. Unit: characters, the same bound as the stored field. PROVISIONAL. */
const GRAPH_USER_ID_MAX_CHARS = 256;

/**
 * Bounded, not strict: Graph sends more than was selected (`@odata.context`). `mail` is null on many personal accounts, whose sign-in
 * address is in `userPrincipalName`.
 */
const ProfileAnswer = z.object({
  id: z
    .string()
    .min(1)
    .max(GRAPH_USER_ID_MAX_CHARS)
    .regex(/^[!-~]+$/u),
  mail: z.string().max(320).nullish(),
  userPrincipalName: z.string().max(320).nullish(),
});

export interface GraphProfile {
  /** The mailbox the token belongs to, in the canonical form `parseAddress` returns. */
  readonly email: string;
  /** Who it is. An address can be reassigned or shared by a personal and a work account; Microsoft says not to identify anyone by one (claims-validation page). */
  readonly userId: string;
}

export interface GraphProfileOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onCall?: (call: MicrosoftCall) => void;
}

/** Who the token is for: where a Microsoft account's address comes from, never typed by a person. */
export async function fetchGraphProfile(
  accessToken: string,
  options: GraphProfileOptions = {},
  signal?: AbortSignal,
): Promise<GraphProfile> {
  const call = createBearerCaller<"profile">({
    who: "Microsoft",
    getAccessToken: () => Promise.resolve(accessToken),
    maxTokenChars: GRAPH_ACCESS_TOKEN_MAX_CHARS,
    timeoutMs: options.timeoutMs ?? GRAPH_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
  });
  const { status, json } = await call(
    "profile",
    "profile",
    { method: "GET", url: GRAPH_ME_URL },
    GRAPH_BODY_MAX_BYTES,
    signal,
  );
  if (status === 401 || status === 403) {
    throw new AdapterError("AUTH_REQUIRED", "Microsoft refused the sign-in (profile)");
  }
  if (status !== 200) {
    throw new AdapterError(
      status >= 500 || status === 429 ? "TRANSIENT" : "REJECTED",
      `Microsoft refused the request (profile, ${String(status)})`,
    );
  }
  const parsed = ProfileAnswer.safeParse(json);
  if (!parsed.success)
    throw new AdapterError("TRANSIENT", "Microsoft answer is malformed (profile)");
  const { mail, userPrincipalName } = parsed.data;
  const address = parseAddress(
    mail !== null && mail !== undefined && mail !== "" ? mail : (userPrincipalName ?? ""),
  );
  // An address Senderban cannot hold is not stored half-way: the account cannot be identified, so it is refused.
  if (!address.ok) {
    throw new AdapterError("REJECTED", "Microsoft gave an address that cannot be used (profile)");
  }
  return { email: address.value.address, userId: parsed.data.id };
}
