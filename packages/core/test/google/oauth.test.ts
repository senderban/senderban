import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import {
  GMAIL_FILTERS_SCOPE,
  GMAIL_METADATA_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  buildAuthUrl,
  checkGrantedScopes,
  createOAuthClient,
  loopbackRedirectUri,
  newPkce,
  newState,
  stateMatches,
} from "../../src/google/oauth.js";
import { GOOGLE_BODY_MAX_BYTES } from "../../src/google/http.js";
import type { GoogleCall } from "../../src/google/http.js";
import { ACCESS, CODE, FakeGoogle, REFRESH, SECRET } from "./fake-google.js";

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";
const REDIRECT = loopbackRedirectUri(54321);

function setup(options: { secret?: string; timeoutMs?: number } = {}) {
  const fake = new FakeGoogle();
  const calls: GoogleCall[] = [];
  const pkce = newPkce();
  fake.challenge = pkce.challenge;
  const client = createOAuthClient({
    clientId: CLIENT_ID,
    ...(options.secret === undefined
      ? {}
      : { getClientSecret: () => Promise.resolve(options.secret) }),
    fetch: fake.fetch,
    timeoutMs: options.timeoutMs ?? 500,
    onCall: (call) => calls.push(call),
  });
  return { fake, client, calls, pkce };
}

const failure = async (work: Promise<unknown>): Promise<AdapterError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AdapterError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
};

describe("PKCE and state", () => {
  it("makes a 43-character base64url verifier and its S256 challenge, new every time", () => {
    const a = newPkce();
    const b = newPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier).not.toBe(b.verifier);
  });

  it("makes a 256-bit state and compares it without a shortcut for another length", () => {
    const state = newState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(newState()).not.toBe(state);
    expect(stateMatches(state, state)).toBe(true);
    expect(stateMatches(state, `${state.slice(0, -1)}x`)).toBe(false);
    expect(stateMatches(state, state.slice(0, -1))).toBe(false);
    expect(stateMatches(state, `${state}x`)).toBe(false);
    expect(stateMatches(state, "")).toBe(false);
  });
});

describe("buildAuthUrl", () => {
  const input = {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    state: "s".repeat(43),
    challenge: "c".repeat(43),
  };

  it("always points at Google's authorization endpoint with the fixed parameters", () => {
    const url = new URL(buildAuthUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: `${GMAIL_FILTERS_SCOPE} ${GMAIL_METADATA_SCOPE}`,
      state: input.state,
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
  });

  it("adds a login hint only when given", () => {
    const url = new URL(buildAuthUrl({ ...input, loginHint: "me@gmail.com" }));
    expect(url.searchParams.get("login_hint")).toBe("me@gmail.com");
  });

  it("encodes a hostile client ID instead of letting it add a parameter or change the host", () => {
    const hostile = "x&scope=https://mail.google.com/&redirect_uri=http://evil.example";
    const url = new URL(buildAuthUrl({ ...input, clientId: hostile }));
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.getAll("scope")).toEqual([
      `${GMAIL_FILTERS_SCOPE} ${GMAIL_METADATA_SCOPE}`,
    ]);
    expect(url.searchParams.getAll("redirect_uri")).toEqual([REDIRECT]);
    expect(url.searchParams.get("client_id")).toBe(hostile);
  });

  it("builds the loopback redirect in the documented form, for a real port only", () => {
    expect(loopbackRedirectUri(8080)).toBe("http://127.0.0.1:8080");
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => loopbackRedirectUri(port)).toThrow(RangeError);
    }
  });
});

describe("checkGrantedScopes", () => {
  const both = `${GMAIL_FILTERS_SCOPE} ${GMAIL_METADATA_SCOPE}`;
  it.each([
    ["both, in the asked order", both, { ok: true }],
    ["both, in the other order", `${GMAIL_METADATA_SCOPE} ${GMAIL_FILTERS_SCOPE}`, { ok: true }],
    ["both with extra spaces", `  ${both}  `, { ok: true }],
    ["none named", undefined, { ok: false, reason: "scope-missing" }],
    ["an empty string", "   ", { ok: false, reason: "scope-missing" }],
    ["only metadata", GMAIL_METADATA_SCOPE, { ok: false, reason: "no-filter-scope" }],
    ["only filters", GMAIL_FILTERS_SCOPE, { ok: false, reason: "no-metadata-scope" }],
    [
      "both plus a wider one",
      `${both} https://mail.google.com/`,
      { ok: false, reason: "extra-scope" },
    ],
    ["both plus the email scope", `${both} email`, { ok: false, reason: "extra-scope" }],
    [
      "a look-alike scope",
      `${GMAIL_FILTERS_SCOPE}x ${GMAIL_METADATA_SCOPE}`,
      { ok: false, reason: "no-filter-scope" },
    ],
  ])("%s", (_name, scope, expected) => {
    expect(checkGrantedScopes(scope)).toEqual(expected);
  });
});

describe("exchangeCode", () => {
  it("posts the form to Google's token endpoint, with no redirect and no secret by default", async () => {
    const { fake, client, pkce } = setup();
    await client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT });
    const call = fake.calls[0];
    expect(call?.url).toBe(GOOGLE_TOKEN_URL);
    expect(call?.method).toBe("POST");
    expect(call?.redirect).toBe("error");
    expect(call?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call?.form).toEqual({
      client_id: CLIENT_ID,
      code: CODE,
      code_verifier: pkce.verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    });
  });

  it("returns the tokens when the verifier pairs with the challenge, and ignores a field it does not know", async () => {
    const { client, pkce } = setup();
    expect(
      await client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    ).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresInSeconds: 3599,
      scope: `${GMAIL_FILTERS_SCOPE} ${GMAIL_METADATA_SCOPE}`,
    });
  });

  it("is refused by Google when the verifier is not the one that made the challenge", async () => {
    const { client } = setup();
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: newPkce().verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("AUTH_REQUIRED");
  });

  it("sends the client secret when there is one, read for the call and not held", async () => {
    const { fake, client, pkce } = setup({ secret: SECRET });
    await client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT });
    expect(fake.calls[0]?.form["client_secret"]).toBe(SECRET);
  });

  it("refuses an answer without a refresh token", async () => {
    const { fake, client, pkce } = setup();
    fake.forced.push({
      status: 200,
      body: JSON.stringify({ access_token: ACCESS, expires_in: 3599, token_type: "Bearer" }),
    });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("AUTH_REQUIRED");
  });

  it.each([
    ["no access token", { expires_in: 3599, refresh_token: REFRESH, token_type: "Bearer" }],
    [
      "an expiry of 0 seconds",
      { access_token: ACCESS, expires_in: 0, refresh_token: REFRESH, token_type: "Bearer" },
    ],
    [
      "an expiry past a day",
      { access_token: ACCESS, expires_in: 86_401, refresh_token: REFRESH, token_type: "Bearer" },
    ],
    [
      "an expiry that is a string",
      { access_token: ACCESS, expires_in: "3599", refresh_token: REFRESH, token_type: "Bearer" },
    ],
    [
      "a token type other than Bearer",
      { access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, token_type: "MAC" },
    ],
    [
      "an access token past 2048 characters (Google's largest)",
      {
        access_token: "a".repeat(2049),
        expires_in: 3599,
        refresh_token: REFRESH,
        token_type: "Bearer",
      },
    ],
  ])("treats an answer with %s as malformed, naming nothing from it", async (_name, answer) => {
    const { fake, client, pkce } = setup();
    fake.forced.push({ status: 200, body: JSON.stringify(answer) });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("TRANSIENT");
    expect(error.message).not.toContain(ACCESS);
  });

  it.each([
    ["invalid_grant", 400, "AUTH_REQUIRED"],
    ["invalid_client", 401, "AUTH_REQUIRED"],
    ["unauthorized_client", 400, "AUTH_REQUIRED"],
    ["invalid_request", 400, "REJECTED"],
    ["something_else", 418, "REJECTED"],
    ["server_error", 500, "TRANSIENT"],
    ["temporarily_unavailable", 503, "TRANSIENT"],
    ["rate_limit", 429, "QUOTA_EXCEEDED"],
  ])("maps the error word %s (%i) to %s", async (word, status, code) => {
    const { fake, client, pkce } = setup({ secret: SECRET });
    fake.forced.push({
      status,
      body: JSON.stringify({ error: word, error_description: `bad ${CODE} ${SECRET} ${ACCESS}` }),
    });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe(code);
    for (const secret of [CODE, SECRET, ACCESS, REFRESH, pkce.verifier, "bad "]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it("reads a non-JSON error page as a plain failure of that status", async () => {
    const { fake, client, pkce } = setup();
    fake.forced.push({ status: 502, body: "<html>Bad gateway for 1//the-refresh-token</html>" });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("TRANSIENT");
    expect(error.message).not.toContain("html");
  });

  it("cuts off an answer larger than any valid one", async () => {
    const { fake, client, pkce } = setup();
    fake.forced.push({ status: 200, body: "x".repeat(GOOGLE_BODY_MAX_BYTES + 1) });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("TRANSIENT");
  });

  it("answers a network failure with a fixed text and no detail", async () => {
    const { fake, client, pkce } = setup();
    fake.failNetwork = 1;
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("TRANSIENT");
    expect(error.message).toBe("Google could not be reached (token)");
  });

  it("gives up on a server that never answers, at its own deadline", async () => {
    const { fake, client, pkce } = setup({ timeoutMs: 30 });
    fake.stall = true;
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("TRANSIENT");
  });

  it("stops at once when the caller aborts", async () => {
    const { fake, client, pkce } = setup({ timeoutMs: 5000 });
    fake.stall = true;
    const controller = new AbortController();
    const pending = failure(
      client.exchangeCode(
        { code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT },
        controller.signal,
      ),
    );
    controller.abort(new AdapterError("TRANSIENT", "the engine gave up"));
    const error = await pending;
    expect(error.message).toBe("the engine gave up");
  });

  it("refuses when the stored client secret cannot be read, before any request", async () => {
    const fake = new FakeGoogle();
    const client = createOAuthClient({
      clientId: CLIENT_ID,
      getClientSecret: () => Promise.reject(new Error("DPAPI says no")),
      fetch: fake.fetch,
    });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: "v".repeat(43), redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("REJECTED");
    expect(error.message).not.toContain("DPAPI");
    expect(fake.calls).toHaveLength(0);
  });

  it("tells the log the operation, status and time, and nothing else", async () => {
    const { client, calls, pkce } = setup();
    await client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["ms", "op", "status"]);
    expect(calls[0]).toMatchObject({ op: "token", status: 200 });
  });
});

describe("refresh", () => {
  it("posts the refresh token and returns a new access token", async () => {
    const { fake, client } = setup();
    const grant = await client.refresh(REFRESH);
    expect(fake.calls[0]?.url).toBe(GOOGLE_TOKEN_URL);
    expect(fake.calls[0]?.form).toEqual({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: REFRESH,
    });
    expect(grant).toMatchObject({ accessToken: ACCESS, expiresInSeconds: 3599 });
  });

  it("reads invalid_grant as 'sign in again' and never repeats the token", async () => {
    const { client } = setup();
    const error = await failure(client.refresh("1//a-revoked-refresh-token"));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).not.toContain("1//a-revoked");
  });
});

describe("revoke", () => {
  it("revokes a known token at Google's revoke endpoint", async () => {
    const { fake, client } = setup();
    expect(await client.revoke(REFRESH)).toBe("revoked");
    expect(fake.calls[0]?.url).toBe(GOOGLE_REVOKE_URL);
    expect(fake.calls[0]?.form).toEqual({ token: REFRESH });
  });

  it("counts a token Google no longer knows as done (400)", async () => {
    const { client } = setup();
    expect(await client.revoke("1//already-gone")).toBe("already-invalid");
  });

  it("does not hide a server failure", async () => {
    const { fake, client } = setup();
    fake.forced.push({ status: 503, body: "" });
    expect((await failure(client.revoke(REFRESH))).code).toBe("TRANSIENT");
  });
});

describe("what the caller hands over", () => {
  const verifier = "v".repeat(43);

  it.each([
    ["an empty code", { code: "", verifier, redirectUri: REDIRECT }],
    ["a code with a space", { code: "a b", verifier, redirectUri: REDIRECT }],
    ["a code with a line break", { code: "a\r\nb", verifier, redirectUri: REDIRECT }],
    ["a code past 256 characters", { code: "a".repeat(257), verifier, redirectUri: REDIRECT }],
    [
      "a verifier of 42 characters",
      { code: CODE, verifier: "v".repeat(42), redirectUri: REDIRECT },
    ],
    [
      "a verifier of 129 characters",
      { code: CODE, verifier: "v".repeat(129), redirectUri: REDIRECT },
    ],
    [
      "a verifier with a space",
      { code: CODE, verifier: `${"v".repeat(42)} `, redirectUri: REDIRECT },
    ],
    [
      "a redirect with a line break",
      { code: CODE, verifier, redirectUri: "http://127.0.0.1:1\r\nX: y" },
    ],
  ])("refuses %s before any request", async (_name, input) => {
    const { fake, client } = setup();
    expect((await failure(client.exchangeCode(input))).code).toBe("REJECTED");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a refresh or revoke token that cannot be a token, before any request", async () => {
    const { fake, client } = setup();
    for (const bad of ["", "a b", "a\nb", "a".repeat(513)]) {
      expect((await failure(client.refresh(bad))).code).toBe("REJECTED");
    }
    expect((await failure(client.revoke("a\nb"))).code).toBe("REJECTED");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("a client secret callback that misbehaves", () => {
  it("answers a callback that throws at once, or rejects, with the same fixed text and no request", async () => {
    for (const getClientSecret of [
      () => {
        throw new Error("DPAPI says no: GOCSPX-leak");
      },
      () => Promise.reject(new Error("DPAPI says no: GOCSPX-leak")),
    ]) {
      const fake = new FakeGoogle();
      const client = createOAuthClient({ clientId: CLIENT_ID, getClientSecret, fetch: fake.fetch });
      const error = await failure(client.refresh(REFRESH));
      expect(error.code).toBe("REJECTED");
      expect(error.message).toBe("the stored client secret cannot be read");
      expect(fake.calls).toHaveLength(0);
    }
  });
});

describe("token answers with characters a token cannot have", () => {
  it.each([
    ["an access token with a line break", { access_token: "ya29.a\r\nb", refresh_token: REFRESH }],
    ["an access token with a space", { access_token: "ya29.a b", refresh_token: REFRESH }],
    ["a refresh token with a line break", { access_token: ACCESS, refresh_token: "1//a\r\nb" }],
    ["a refresh token with a space", { access_token: ACCESS, refresh_token: "1//a b" }],
    ["an empty refresh token", { access_token: ACCESS, refresh_token: "" }],
    [
      "a refresh token past 512 characters",
      { access_token: ACCESS, refresh_token: "1".repeat(513) },
    ],
  ])("treats %s as a malformed answer", async (_name, tokens) => {
    const { fake, client, pkce } = setup();
    fake.forced.push({
      status: 200,
      body: JSON.stringify({ expires_in: 3599, token_type: "Bearer", ...tokens }),
    });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("TRANSIENT");
  });
});

describe("revoke, other 400 answers", () => {
  it.each([
    ["invalid_request", "REJECTED"],
    ["invalid_client", "AUTH_REQUIRED"],
  ])("does not read %s as 'already gone': the token may still be live", async (word, code) => {
    const { fake, client } = setup();
    fake.forced.push({ status: 400, body: JSON.stringify({ error: word }) });
    expect((await failure(client.revoke(REFRESH))).code).toBe(code);
  });

  it("does not read a 400 without a body as 'already gone' either", async () => {
    const { fake, client } = setup();
    fake.forced.push({ status: 400, body: "" });
    expect((await failure(client.revoke(REFRESH))).code).toBe("REJECTED");
  });
});

describe("answers that are bigger than they say", () => {
  it("refuses at once an answer whose content-length is past the cap, without reading it", async () => {
    const { fake, client, pkce } = setup();
    fake.forced.push({
      status: 200,
      body: "{}",
      headers: { "content-length": String(GOOGLE_BODY_MAX_BYTES + 1) },
    });
    const error = await failure(
      client.exchangeCode({ code: CODE, verifier: pkce.verifier, redirectUri: REDIRECT }),
    );
    expect(error.code).toBe("TRANSIENT");
    expect(error.message).toContain("larger than any valid one");
  });

  it("returns a refresh token's time limit when Google sets one, and stays silent about it otherwise", async () => {
    const { fake, client, pkce } = setup();
    fake.forced.push({
      status: 200,
      body: JSON.stringify({
        access_token: ACCESS,
        expires_in: 3599,
        refresh_token: REFRESH,
        refresh_token_expires_in: 604_800,
        token_type: "Bearer",
      }),
    });
    const timed = await client.exchangeCode({
      code: CODE,
      verifier: pkce.verifier,
      redirectUri: REDIRECT,
    });
    expect(timed.refreshTokenExpiresInSeconds).toBe(604_800);
    const plain = await client.exchangeCode({
      code: CODE,
      verifier: pkce.verifier,
      redirectUri: REDIRECT,
    });
    expect("refreshTokenExpiresInSeconds" in plain).toBe(false);
  });
});
