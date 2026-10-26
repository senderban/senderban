import { describe, expect, it } from "vitest";
import { signIn } from "../../src/google/sign-in.js";
import type { SignInOptions, SignInResult } from "../../src/google/sign-in.js";
import {
  GMAIL_FILTERS_SCOPE,
  GMAIL_METADATA_SCOPE,
  GOOGLE_AUTH_URL,
  createOAuthClient,
} from "../../src/google/oauth.js";
import { CODE, FakeGoogle, REFRESH } from "./fake-google.js";

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";

/**
 * The person's browser, played by the test: it reads the URL the app opened, registers the PKCE challenge with the
 * fake Google (as Google does when it sees the authorization request) and then follows the redirect back to the
 * app's loopback port, with the code and the state from the URL.
 */
function browser(
  fake: FakeGoogle,
  then: "approve" | "deny" | "ignore" | "wrong-state" = "approve",
) {
  const opened: string[] = [];
  const openBrowser = (url: string): Promise<void> => {
    opened.push(url);
    const params = new URL(url).searchParams;
    fake.challenge = params.get("code_challenge") ?? "";
    const redirect = params.get("redirect_uri") ?? "";
    const state = params.get("state") ?? "";
    const query =
      then === "approve"
        ? `code=${encodeURIComponent(CODE)}&state=${state}`
        : then === "deny"
          ? `error=access_denied&state=${state}`
          : then === "wrong-state"
            ? `code=${encodeURIComponent(CODE)}&state=not-the-state`
            : null;
    if (query !== null) {
      // After this call returns, like a browser that was opened and then redirected.
      setTimeout(() => {
        void fetch(`${redirect}/?${query}`).catch(() => undefined);
      }, 5);
    }
    return Promise.resolve();
  };
  return { opened, openBrowser };
}

function options(fake: FakeGoogle, extra: Partial<SignInOptions> = {}): SignInOptions {
  return {
    clientId: CLIENT_ID,
    oauth: createOAuthClient({ clientId: CLIENT_ID, fetch: fake.fetch, timeoutMs: 500 }),
    openBrowser: browser(fake).openBrowser,
    profile: { fetch: fake.fetch, timeoutMs: 500 },
    timeoutMs: 2000,
    ...extra,
  };
}

describe("signIn", () => {
  it("signs in: opens Google's fixed URL, takes the code from the loopback, returns token and mailbox", async () => {
    const fake = new FakeGoogle();
    const b = browser(fake);
    const result = await signIn(options(fake, { openBrowser: b.openBrowser }));
    expect(result).toEqual({
      status: "signed-in",
      refreshToken: REFRESH,
      email: "me@gmail.com",
      historyId: "1234567",
    });
    expect(b.opened).toHaveLength(1);
    expect(b.opened[0]?.startsWith(`${GOOGLE_AUTH_URL}?`)).toBe(true);
    const params = new URL(b.opened[0] ?? "").searchParams;
    expect(params.get("scope")).toBe(`${GMAIL_FILTERS_SCOPE} ${GMAIL_METADATA_SCOPE}`);
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // The exchange used the redirect URI of the listener and a verifier that pairs with the challenge.
    expect(fake.calls[0]?.form["redirect_uri"]).toBe(params.get("redirect_uri"));
  });

  it("keeps the preselected account hint out of the trust decision: the profile decides", async () => {
    const fake = new FakeGoogle();
    fake.email = "someone.else@gmail.com";
    const b = browser(fake);
    const result = await signIn(
      options(fake, { openBrowser: b.openBrowser, expectEmail: "me@gmail.com" }),
    );
    expect(new URL(b.opened[0] ?? "").searchParams.get("login_hint")).toBe("me@gmail.com");
    expect(result).toEqual({ status: "wrong-account" });
  });

  it("accepts a re-sign-in whose mailbox is Gmail's other spelling of the bound one", async () => {
    const fake = new FakeGoogle();
    fake.email = "m.e@gmail.com";
    const result = await signIn(options(fake, { expectEmail: "me@googlemail.com" }));
    expect(result).toMatchObject({ status: "signed-in", email: "m.e@gmail.com" });
  });

  it("never revokes a token it refuses (revoking would take away the grants of an account already set up)", async () => {
    const fake = new FakeGoogle();
    fake.email = "someone.else@gmail.com";
    await signIn(options(fake, { expectEmail: "me@gmail.com" }));
    fake.scope = GMAIL_METADATA_SCOPE;
    await signIn(options(fake));
    expect(fake.calls.some((c) => c.url.endsWith("/revoke"))).toBe(false);
  });

  it.each([
    ["only the metadata scope", GMAIL_METADATA_SCOPE, "no-filter-scope"],
    ["only the filter scope", GMAIL_FILTERS_SCOPE, "no-metadata-scope"],
    [
      "a wider scope too",
      `${GMAIL_FILTERS_SCOPE} ${GMAIL_METADATA_SCOPE} https://mail.google.com/`,
      "extra-scope",
    ],
  ])("refuses a grant with %s and does not ask for the profile", async (_name, scope, reason) => {
    const fake = new FakeGoogle();
    fake.scope = scope;
    expect(await signIn(options(fake))).toEqual({ status: "scope", reason });
    expect(fake.calls.some((c) => c.url.includes("/profile"))).toBe(false);
  });

  it("reports the person's refusal as cancelled", async () => {
    const fake = new FakeGoogle();
    const result = await signIn(options(fake, { openBrowser: browser(fake, "deny").openBrowser }));
    expect(result).toEqual({ status: "cancelled" });
    expect(fake.calls).toHaveLength(0);
  });

  it("is not finished by a redirect that carries the wrong state; it waits and times out", async () => {
    const fake = new FakeGoogle();
    const result = await signIn(
      options(fake, { openBrowser: browser(fake, "wrong-state").openBrowser, timeoutMs: 150 }),
    );
    expect(result).toEqual({ status: "timeout" });
    expect(fake.calls).toHaveLength(0);
  });

  it("times out when the person never comes back", async () => {
    const fake = new FakeGoogle();
    const result = await signIn(
      options(fake, { openBrowser: browser(fake, "ignore").openBrowser, timeoutMs: 60 }),
    );
    expect(result).toEqual({ status: "timeout" });
  });

  it("stops when aborted", async () => {
    const fake = new FakeGoogle();
    const controller = new AbortController();
    const pending = signIn(
      options(fake, {
        openBrowser: browser(fake, "ignore").openBrowser,
        signal: controller.signal,
      }),
    );
    setTimeout(() => {
      controller.abort();
    }, 20);
    expect(await pending).toEqual({ status: "aborted" });
  });

  it("allows one sign-in at a time: a second call while one is open is 'busy' and opens no second tab", async () => {
    const fake = new FakeGoogle();
    const first = browser(fake, "ignore");
    const second = browser(fake);
    const pending = signIn(options(fake, { openBrowser: first.openBrowser, timeoutMs: 100 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(await signIn(options(fake, { openBrowser: second.openBrowser }))).toEqual({
      status: "busy",
    });
    expect(second.opened).toHaveLength(0);
    expect(await pending).toEqual({ status: "timeout" });
    // The slot is free again afterwards.
    expect(await signIn(options(fake))).toMatchObject({ status: "signed-in" });
  });

  it("reports a browser that cannot be opened, and frees the slot and closes the port", async () => {
    const fake = new FakeGoogle();
    let redirect = "";
    const result = await signIn(
      options(fake, {
        openBrowser: (url) => {
          redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
          return Promise.reject(new Error("no default browser"));
        },
      }),
    );
    expect(result).toEqual({ status: "browser-failed" });
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // The listener is gone: nothing answers on that port any more.
    await expect(fetch(`${redirect}/?code=x&state=y`)).rejects.toThrow();
    expect(await signIn(options(fake))).toMatchObject({ status: "signed-in" });
  });

  it("does not keep the slot when openBrowser never returns: it gives up on it, then the next sign-in works", async () => {
    const fake = new FakeGoogle();
    const hung = options(fake, {
      openBrowser: () => new Promise<void>(() => undefined),
      openBrowserTimeoutMs: 30,
    });
    expect(await signIn(hung)).toEqual({ status: "browser-failed" });
    expect(await signIn(options(fake))).toMatchObject({ status: "signed-in" });
  });

  it("does not keep the slot when openBrowser never returns and the caller aborts", async () => {
    const fake = new FakeGoogle();
    const controller = new AbortController();
    const pending = signIn(
      options(fake, {
        openBrowser: () => new Promise<void>(() => undefined),
        signal: controller.signal,
      }),
    );
    setTimeout(() => {
      controller.abort();
    }, 30);
    expect(await pending).toEqual({ status: "aborted" });
    expect(await signIn(options(fake))).toMatchObject({ status: "signed-in" });
  });

  it("does not crash on an openBrowser that fails after the sign-in has stopped waiting for it", async () => {
    const fake = new FakeGoogle();
    let fail: (error: Error) => void = () => undefined;
    const result = await signIn(
      options(fake, {
        openBrowser: () =>
          new Promise<void>((_, reject) => {
            fail = reject;
          }),
        openBrowserTimeoutMs: 20,
      }),
    );
    expect(result).toEqual({ status: "browser-failed" });
    fail(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 20));
  });

  it("reports an abort during the code exchange as 'aborted', not as a Google outage", async () => {
    const fake = new FakeGoogle();
    const controller = new AbortController();
    const b = browser(fake);
    const pending = signIn(
      options(fake, {
        openBrowser: (url) => {
          // After the redirect has been delivered, Google stops answering.
          setTimeout(() => {
            fake.stall = true;
          }, 1);
          return b.openBrowser(url);
        },
        signal: controller.signal,
        timeoutMs: 5000,
      }),
    );
    setTimeout(() => {
      controller.abort();
    }, 150);
    expect(await pending).toEqual({ status: "aborted" });
  });

  it("carries a code exchange that Google refuses as 'sign in again', without the code or the response", async () => {
    const fake = new FakeGoogle();
    const b = browser(fake);
    const open = (url: string) => {
      void b.openBrowser(url);
      // A challenge that does not pair with the verifier: Google answers invalid_grant.
      fake.challenge = "not-the-challenge";
      return Promise.resolve();
    };
    const result = await signIn(options(fake, { openBrowser: open }));
    expect(result).toEqual({ status: "failed", code: "AUTH_REQUIRED" });
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it("passes on the time limit of a refresh token when Google sets one", async () => {
    const fake = new FakeGoogle();
    fake.forced.push({
      status: 200,
      body: JSON.stringify({
        access_token: "ya29.the-access-token",
        expires_in: 3599,
        refresh_token: REFRESH,
        refresh_token_expires_in: 604_800,
        scope: fake.scope,
        token_type: "Bearer",
      }),
    });
    expect(await signIn(options(fake))).toMatchObject({
      status: "signed-in",
      refreshTokenExpiresInSeconds: 604_800,
    });
  });

  it("carries a Google outage after the code as a transient failure", async () => {
    const fake = new FakeGoogle();
    fake.forced.push({ status: 503, body: "" });
    expect(await signIn(options(fake))).toEqual({ status: "failed", code: "TRANSIENT" });
  });

  it("is typed so that a result never carries a token unless it signed in", async () => {
    const fake = new FakeGoogle();
    fake.scope = GMAIL_METADATA_SCOPE;
    const result: SignInResult = await signIn(options(fake));
    expect(JSON.stringify(result)).not.toContain(REFRESH);
    expect(JSON.stringify(result)).not.toContain("ya29");
  });
});
