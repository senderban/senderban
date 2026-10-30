import { request } from "node:http";
import { describe, expect, it } from "vitest";
import {
  GRAPH_SCOPES,
  MICROSOFT_AUTH_URL,
  MICROSOFT_TOKEN_BYTES,
  MICROSOFT_TOKEN_URL,
  ApprovalRequiredError,
  buildMicrosoftAuthUrl,
  checkGrantedGraphScopes,
  createMicrosoftOAuthClient,
  fetchGraphProfile,
  isMicrosoftClientId,
} from "../../src/graph/oauth.js";
import { signInMicrosoft } from "../../src/graph/sign-in.js";
import type { MicrosoftSignInOptions, MicrosoftSignInResult } from "../../src/graph/sign-in.js";
import { oneSignIn } from "../../src/oauth/consent.js";
import { ACCESS, CODE, FakeGraph, REFRESH, ROTATED } from "./fake-graph.js";

const CLIENT_ID = "00000000-1111-2222-3333-444444444444";
const VERIFIER = "v".repeat(43);
const REDIRECT = "http://localhost:51234";

const oauth = (fake: FakeGraph) =>
  createMicrosoftOAuthClient({ clientId: CLIENT_ID, fetch: fake.fetch });

/** The person's browser: reads the URL, registers the challenge, follows the redirect to the app's port. */
function browser(
  fake: FakeGraph,
  then: "approve" | "deny" | "approval" | "other-error" = "approve",
) {
  const opened: string[] = [];
  const openBrowser = (url: string): Promise<void> => {
    opened.push(url);
    const params = new URL(url).searchParams;
    fake.challenge = params.get("code_challenge") ?? "";
    const target = new URL(params.get("redirect_uri") ?? "");
    const state = encodeURIComponent(params.get("state") ?? "");
    const query =
      then === "approve"
        ? `code=${encodeURIComponent(CODE)}&state=${state}`
        : then === "deny"
          ? `error=access_denied&state=${state}`
          : then === "approval"
            ? `error=consent_required&state=${state}`
            : `error=server_error&state=${state}`;
    // The listener binds 127.0.0.1 and is named localhost: a browser connects there and sends that name in Host.
    request({
      host: "127.0.0.1",
      port: Number(target.port),
      path: `/?${query}`,
      headers: { host: target.host },
    })
      .on("response", (response) => response.resume())
      .on("error", () => undefined)
      .end();
    return Promise.resolve();
  };
  return { opened, openBrowser };
}

const signInWith = (
  fake: FakeGraph,
  options: Partial<MicrosoftSignInOptions> = {},
  then?: Parameters<typeof browser>[1],
): Promise<MicrosoftSignInResult> =>
  signInMicrosoft({
    clientId: CLIENT_ID,
    oauth: oauth(fake),
    openBrowser: browser(fake, then).openBrowser,
    profile: { fetch: fake.fetch },
    timeoutMs: 2_000,
    ...options,
  });

describe("Microsoft authorization URL", () => {
  it("carries the code flow with S256 on the fixed host, and no secret", () => {
    const url = new URL(
      buildMicrosoftAuthUrl({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        state: "s",
        challenge: "c",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(MICROSOFT_AUTH_URL);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("response_mode")).toBe("query");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("scope")?.split(" ")).toEqual([...GRAPH_SCOPES]);
    expect(p.has("client_secret")).toBe(false);
    expect(p.has("login_hint")).toBe(false);
  });

  it("asks for nothing that reads a message body, and for no delete of mail", () => {
    expect(GRAPH_SCOPES.join(" ")).not.toMatch(/Mail\.Read(\s|$)|Mail\.ReadWrite|Mail\.Send/u);
  });

  it("preselects the mailbox of a re-sign-in", () => {
    const url = new URL(
      buildMicrosoftAuthUrl({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        state: "s",
        challenge: "c",
        loginHint: "me@outlook.example",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("me@outlook.example");
  });

  it("tells a client ID from anything else", () => {
    expect(isMicrosoftClientId(CLIENT_ID)).toBe(true);
    expect(isMicrosoftClientId("")).toBe(false);
    expect(isMicrosoftClientId("not-a-guid")).toBe(false);
  });
});

describe("granted scopes", () => {
  it("takes them with or without the resource, in any case, and percent-encoded", () => {
    for (const scope of [
      "https://graph.microsoft.com/MailboxSettings.ReadWrite https://graph.microsoft.com/Mail.ReadBasic https://graph.microsoft.com/User.Read",
      "User.Read Mail.ReadBasic MailboxSettings.ReadWrite",
      "user.read mail.readbasic mailboxsettings.readwrite openid profile",
      "https%3A%2F%2Fgraph.microsoft.com%2Fmail.readbasic%20https%3A%2F%2Fgraph.microsoft.com%2Fmailboxsettings.readwrite%20user.read",
    ]) {
      expect(checkGrantedGraphScopes(scope)).toEqual({ ok: true });
    }
  });

  it("reads no scope at all as what was asked, as the protocol says", () => {
    expect(checkGrantedGraphScopes(undefined)).toEqual({ ok: true });
  });

  it("names what is missing", () => {
    expect(checkGrantedGraphScopes("User.Read Mail.ReadBasic")).toEqual({
      ok: false,
      reason: "no-rules-scope",
    });
    expect(checkGrantedGraphScopes("User.Read MailboxSettings.ReadWrite")).toEqual({
      ok: false,
      reason: "no-folder-scope",
    });
    expect(checkGrantedGraphScopes("Mail.ReadBasic MailboxSettings.ReadWrite")).toEqual({
      ok: false,
      reason: "no-profile-scope",
    });
  });
});

describe("Microsoft token client", () => {
  it("exchanges a code with the verifier and no secret", async () => {
    const fake = new FakeGraph();
    fake.challenge = "6dFd2yQhKsq8DN0ptBmXbMGUWSwYPiwkcQjeLVcpHgI";
    await oauth(fake)
      .exchangeCode({ code: CODE, verifier: VERIFIER, redirectUri: REDIRECT })
      .catch(() => undefined);
    const form = new URLSearchParams(fake.calls[0]?.body);
    expect(fake.calls[0]?.url).toBe(MICROSOFT_TOKEN_URL);
    expect(fake.calls[0]?.redirect).toBe("error");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe(VERIFIER);
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(form.has("client_secret")).toBe(false);
  });

  it("hands back the refresh token that replaced the old one", async () => {
    const fake = new FakeGraph();
    const grant = await oauth(fake).refresh(REFRESH);
    expect(grant.accessToken).toBe(ACCESS);
    expect(grant.refreshToken).toBe(ROTATED);
    expect(grant.expiresInSeconds).toBe(3599);
  });

  it.each([
    [{ status: 400, body: { error: "invalid_grant", error_codes: [700082] } }, "AUTH_REQUIRED"],
    [{ status: 400, body: { error: "interaction_required" } }, "AUTH_REQUIRED"],
    [{ status: 401, body: { error: "invalid_client" } }, "AUTH_REQUIRED"],
    [{ status: 400, body: { error: "unauthorized_client" } }, "AUTH_REQUIRED"],
    [{ status: 429, body: {} }, "QUOTA_EXCEEDED"],
    [{ status: 503, body: {} }, "TRANSIENT"],
    [{ status: 400, body: { error: "temporarily_unavailable" } }, "TRANSIENT"],
    [{ status: 400, body: { error: "invalid_scope" } }, "REJECTED"],
  ])("classifies %j", async (answer, code) => {
    const fake = new FakeGraph();
    fake.tokenError = answer;
    await expect(oauth(fake).refresh(REFRESH)).rejects.toMatchObject({ code });
  });

  it("says when someone must approve the app", async () => {
    for (const body of [
      { error: "consent_required" },
      { error: "invalid_grant", error_codes: [65001] },
      { error: "invalid_client", error_codes: [90094] },
    ]) {
      const fake = new FakeGraph();
      fake.tokenError = { status: 400, body };
      await expect(oauth(fake).refresh(REFRESH)).rejects.toBeInstanceOf(ApprovalRequiredError);
    }
  });

  it("repeats no word of Microsoft's in an error", async () => {
    const fake = new FakeGraph();
    fake.tokenError = {
      status: 400,
      body: { error: "invalid_grant", error_description: "AADSTS secret for me@outlook.example" },
    };
    const failure = await oauth(fake)
      .refresh(REFRESH)
      .catch((e: unknown) => e);
    expect((failure as Error).message).not.toContain("AADSTS");
  });

  it("refuses what cannot be a token before it is sent", async () => {
    const fake = new FakeGraph();
    await expect(oauth(fake).refresh("a b")).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      oauth(fake).refresh("a".repeat(MICROSOFT_TOKEN_BYTES.refresh + 1)),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      oauth(fake).exchangeCode({ code: CODE, verifier: "short", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(fake.calls).toEqual([]);
  });

  it("wants a refresh token from the exchange", async () => {
    const fake = new FakeGraph();
    fake.tokenError = {
      status: 200,
      body: { token_type: "Bearer", expires_in: 3599, access_token: ACCESS },
    };
    await expect(
      oauth(fake).exchangeCode({ code: CODE, verifier: VERIFIER, redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("treats a malformed token answer as passing", async () => {
    const fake = new FakeGraph();
    fake.tokenError = { status: 200, body: { access_token: "x" } };
    await expect(oauth(fake).refresh(REFRESH)).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("reports a network failure with a fixed text", async () => {
    const fake = new FakeGraph();
    fake.failNetwork = 1;
    await expect(oauth(fake).refresh(REFRESH)).rejects.toThrow("Microsoft could not be reached");
  });
});

describe("Graph profile", () => {
  it("prefers mail, and falls back to the sign-in name of a personal account", async () => {
    const fake = new FakeGraph();
    await expect(fetchGraphProfile(ACCESS, { fetch: fake.fetch })).resolves.toEqual({
      email: "me@outlook.example",
    });
    fake.me = { id: "1", mail: "Work@Contoso.Example", userPrincipalName: "w@onmicrosoft.example" };
    await expect(fetchGraphProfile(ACCESS, { fetch: fake.fetch })).resolves.toEqual({
      email: "work@contoso.example",
    });
  });

  it("falls through an empty mail", async () => {
    const fake = new FakeGraph();
    fake.me = { id: "1", mail: "", userPrincipalName: "me@outlook.example" };
    await expect(fetchGraphProfile(ACCESS, { fetch: fake.fetch })).resolves.toEqual({
      email: "me@outlook.example",
    });
  });

  it("refuses an address it cannot hold", async () => {
    const fake = new FakeGraph();
    fake.me = { id: "1", mail: null, userPrincipalName: "live.com#me" };
    await expect(fetchGraphProfile(ACCESS, { fetch: fake.fetch })).rejects.toMatchObject({
      code: "REJECTED",
    });
  });

  it("maps a refused token", async () => {
    const fake = new FakeGraph();
    await expect(fetchGraphProfile("other", { fetch: fake.fetch })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });
});

describe("Microsoft sign-in", () => {
  it("ends with the refresh token and the mailbox from /me", async () => {
    const fake = new FakeGraph();
    await expect(signInWith(fake)).resolves.toEqual({
      status: "signed-in",
      refreshToken: REFRESH,
      email: "me@outlook.example",
    });
  });

  it("redirects to the name Microsoft documents", async () => {
    const fake = new FakeGraph();
    const { opened, openBrowser } = browser(fake);
    await signInWith(fake, { openBrowser });
    const redirect = new URL(opened[0] ?? "").searchParams.get("redirect_uri") ?? "";
    expect(redirect).toMatch(/^http:\/\/localhost:[0-9]+$/u);
  });

  it("says no on the person's no", async () => {
    await expect(signInWith(new FakeGraph(), {}, "deny")).resolves.toEqual({ status: "cancelled" });
  });

  it("says who must approve when the page answers consent_required", async () => {
    await expect(signInWith(new FakeGraph(), {}, "approval")).resolves.toEqual({
      status: "needs-approval",
    });
  });

  it("says who must approve when the token endpoint does", async () => {
    const fake = new FakeGraph();
    fake.tokenError = { status: 400, body: { error: "invalid_grant", error_codes: [90094] } };
    await expect(signInWith(fake)).resolves.toEqual({ status: "needs-approval" });
  });

  it("stores nothing when a permission is missing", async () => {
    const fake = new FakeGraph();
    fake.tokenScope = "User.Read";
    await expect(signInWith(fake)).resolves.toEqual({ status: "scope", reason: "no-rules-scope" });
  });

  it("refuses another mailbox on a re-sign-in", async () => {
    const fake = new FakeGraph();
    await expect(signInWith(fake, { expectEmail: "other@outlook.example" })).resolves.toEqual({
      status: "wrong-account",
    });
  });

  it("refuses a browser error it has no word for", async () => {
    await expect(signInWith(new FakeGraph(), {}, "other-error")).resolves.toEqual({
      status: "failed",
      code: "REJECTED",
    });
  });

  it("gives the slot back when the browser cannot open", async () => {
    const fake = new FakeGraph();
    await expect(
      signInWith(fake, { openBrowser: () => Promise.reject(new Error("no browser")) }),
    ).resolves.toEqual({ status: "browser-failed" });
    await expect(signInWith(fake)).resolves.toMatchObject({ status: "signed-in" });
  });

  it("shares the one slot with every other sign-in", async () => {
    const release = Promise.withResolvers<undefined>();
    const held = oneSignIn(() => release.promise);
    await expect(signInWith(new FakeGraph())).resolves.toEqual({ status: "busy" });
    release.resolve(undefined);
    await held;
  });

  it("stops on an abort", async () => {
    const abort = new AbortController();
    const running = signInWith(new FakeGraph(), {
      signal: abort.signal,
      openBrowser: () => {
        abort.abort();
        return Promise.resolve();
      },
    });
    await expect(running).resolves.toEqual({ status: "aborted" });
  });
});
