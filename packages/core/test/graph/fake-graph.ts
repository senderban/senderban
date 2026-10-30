import { createHash } from "node:crypto";
import { GRAPH_JUNK_URL, GRAPH_RULES_URL } from "../../src/graph/client.js";
import { GRAPH_ME_URL, MICROSOFT_TOKEN_URL } from "../../src/graph/oauth.js";

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly redirect: string | undefined;
}

export interface FakeRule {
  id: string;
  displayName: string;
  sequence: number;
  isEnabled: boolean;
  hasError: boolean;
  isReadOnly: boolean;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
  exceptions?: Record<string, unknown>;
}

export const JUNK_ID = "AAMkAGjunkfolder=";
export const CODE = "M.C123_BAY.2.U.the-authorization-code";
export const ACCESS = "EwBwA8l6BAAU-the-access-token";
export const REFRESH = "M.C123_BL2.0.U.the-refresh-token";
export const ROTATED = "M.C123_BL2.0.U.the-next-refresh-token";

type Forced = number | { status: number; body?: unknown; headers?: Record<string, string> };

/**
 * In-memory stand-in for Graph `messageRules`, the Junk folder, `/me` and the token endpoint. Shapes come from the v1.0 reference (read
 * 2026-10-31), not from a real mailbox: create 201 with the rule, PATCH 200, DELETE 204, `senderContains` stored in capitals as in the
 * docs' sample, `sequence` moved by the server. It enforces the limits M1 is to measure with `maxStrings` (a 400 past it) and `maxRules`.
 */
export class FakeGraph {
  readonly rules = new Map<string, FakeRule>();
  readonly calls: RecordedCall[] = [];
  /** Strings one condition may hold; past it a write answers 400. */
  maxStrings = 10_000;
  /** Rules the mailbox holds; past it a create answers `quotaCode`. */
  maxRules = 10_000;
  quotaCode = "ErrorQuotaExceeded";
  /** Forced answers for the next requests of one method, consumed one per request; `"pass"` lets one through. */
  readonly forced = new Map<string, (Forced | "pass")[]>();
  /** The next POSTs create the rule and then answer this status: an answer that was lost on its way back. */
  createThenFail: number[] = [];
  /** The same for PATCH. */
  updateThenFail: number[] = [];
  /** Makes the next requests throw like a network failure. */
  failNetwork = 0;
  /** New rules are stored with an action the client did not send: what a systematic difference would look like. */
  storeExtraAction = false;
  /** Junk folder id handed out; `null` answers 403, as without `Mail.ReadBasic`. */
  junkId: string | null = JUNK_ID;
  /** What `/me` says. */
  me: Record<string, unknown> = {
    id: "0123456789abcdef",
    mail: null,
    userPrincipalName: "me@outlook.example",
  };
  /** The PKCE challenge the authorization request registered. */
  challenge = "";
  tokenScope: string | undefined =
    "https://graph.microsoft.com/MailboxSettings.ReadWrite https://graph.microsoft.com/Mail.ReadBasic https://graph.microsoft.com/User.Read";
  /** Replaces the token endpoint's answer. */
  tokenError: { status: number; body: unknown } | null = null;
  #next = 1;

  stringsOf(rule: FakeRule): string[] {
    const from = rule.conditions.fromAddresses as
      { emailAddress: { address: string } }[] | undefined;
    if (from !== undefined) return from.map((r) => r.emailAddress.address);
    return rule.conditions.senderContains as string[];
  }

  allStrings(): string[] {
    return [...this.rules.values()].flatMap((r) => this.stringsOf(r));
  }

  writes(): number {
    return this.calls.filter((c) => c.method !== "GET" && !c.url.startsWith(MICROSOFT_TOKEN_URL))
      .length;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.calls.push({ method, url, headers, body, redirect: init?.redirect });
    await Promise.resolve();
    init?.signal?.throwIfAborted();
    if (this.failNetwork > 0) {
      this.failNetwork -= 1;
      throw new TypeError("fetch failed");
    }
    const json = (status: number, value: unknown, extra: Record<string, string> = {}): Response =>
      new Response(status === 204 ? null : JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", ...extra },
      });
    if (url === MICROSOFT_TOKEN_URL) return this.#token(body ?? "", json);

    const forced = this.forced.get(method)?.shift();
    if (forced !== undefined && forced !== "pass") {
      if (typeof forced === "number") {
        return json(forced, { error: { code: "Forced", message: "secret words of the server" } });
      }
      return json(
        forced.status,
        forced.body ?? { error: { code: "Forced" } },
        forced.headers ?? {},
      );
    }
    if (headers.Authorization !== `Bearer ${ACCESS}`) {
      return json(401, { error: { code: "InvalidAuthenticationToken" } });
    }
    if (url === GRAPH_ME_URL) return json(200, this.me);
    if (url === GRAPH_JUNK_URL) {
      return this.junkId === null
        ? json(403, { error: { code: "ErrorAccessDenied" } })
        : json(200, { id: this.junkId });
    }
    if (url === GRAPH_RULES_URL && method === "GET") {
      return json(200, { value: [...this.rules.values()] });
    }
    if (url === GRAPH_RULES_URL && method === "POST") return this.#create(body ?? "{}", json);
    const id = decodeURIComponent(url.slice(GRAPH_RULES_URL.length + 1));
    const rule = this.rules.get(id);
    if (method === "PATCH") {
      if (rule === undefined) return json(404, { error: { code: "ErrorItemNotFound" } });
      const patch = JSON.parse(body ?? "{}") as { conditions: Record<string, unknown> };
      const conditions = this.#stored(patch.conditions);
      if (this.#count(conditions) > this.maxStrings) {
        return json(400, { error: { code: "ErrorInvalidArgument" } });
      }
      rule.conditions = conditions;
      const late = this.updateThenFail.shift();
      return late === undefined ? json(200, rule) : json(late, { error: { code: "Late" } });
    }
    if (method === "DELETE") {
      if (rule === undefined) return json(404, { error: { code: "ErrorItemNotFound" } });
      this.rules.delete(id);
      return json(204, null);
    }
    return json(405, { error: { code: "MethodNotAllowed" } });
  };

  /** Stored as the docs' sample shows it: `senderContains` in capitals. */
  #stored(conditions: Record<string, unknown>): Record<string, unknown> {
    const contains = conditions.senderContains as string[] | undefined;
    return contains === undefined
      ? conditions
      : { ...conditions, senderContains: contains.map((s) => s.toUpperCase()) };
  }

  #count(conditions: Record<string, unknown>): number {
    const from = conditions.fromAddresses as unknown[] | undefined;
    const contains = conditions.senderContains as unknown[] | undefined;
    return (from ?? contains ?? []).length;
  }

  #create(
    body: string,
    json: (status: number, value: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const sent = JSON.parse(body) as {
      displayName: string;
      sequence: number;
      isEnabled: boolean;
      conditions: Record<string, unknown>;
      actions: Record<string, unknown>;
    };
    if (this.rules.size >= this.maxRules)
      return json(403 + 104, { error: { code: this.quotaCode } });
    const conditions = this.#stored(sent.conditions);
    if (this.#count(conditions) > this.maxStrings) {
      return json(400, { error: { code: "ErrorInvalidArgument" } });
    }
    const id = `AQAAAJ5d${String(this.#next++)}+/=`;
    const rule: FakeRule = {
      id,
      displayName: sent.displayName,
      sequence: sent.sequence + this.rules.size,
      isEnabled: sent.isEnabled,
      hasError: false,
      isReadOnly: false,
      conditions,
      actions: this.storeExtraAction ? { ...sent.actions, markAsRead: true } : sent.actions,
    };
    this.rules.set(id, rule);
    const late = this.createThenFail.shift();
    return late === undefined ? json(201, rule) : json(late, { error: { code: "Late" } });
  }

  #token(
    body: string,
    json: (status: number, value: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    if (this.tokenError !== null) return json(this.tokenError.status, this.tokenError.body);
    const form = new URLSearchParams(body);
    const answer = {
      token_type: "Bearer",
      expires_in: 3599,
      ext_expires_in: 3599,
      ...(this.tokenScope === undefined ? {} : { scope: this.tokenScope }),
      access_token: ACCESS,
    };
    if (form.get("grant_type") === "refresh_token") {
      return form.get("refresh_token") === REFRESH
        ? json(200, { ...answer, refresh_token: ROTATED })
        : json(400, { error: "invalid_grant", error_codes: [700082] });
    }
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (form.get("code") !== CODE || challenge !== this.challenge) {
      return json(400, { error: "invalid_grant", error_codes: [70000] });
    }
    return json(200, { ...answer, refresh_token: REFRESH });
  }
}
