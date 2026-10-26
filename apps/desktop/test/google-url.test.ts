import { describe, expect, it, vi } from "vitest";
import { buildAuthUrl, newPkce, newState } from "@senderban/core";
import { isGoogleAuthUrl, openGoogleAuthUrl } from "../src/google-url.js";

const real = buildAuthUrl({
  clientId: "123456789012-abc.apps.googleusercontent.com",
  redirectUri: "http://127.0.0.1:51234",
  state: newState(),
  challenge: newPkce().challenge,
});

describe("the URL the browser may be opened on", () => {
  it("accepts the consent URL the sign-in builds", () => {
    expect(isGoogleAuthUrl(real)).toBe(true);
  });

  it.each([
    "http://accounts.google.com/o/oauth2/v2/auth?x=1",
    "https://accounts.google.com.evil.example/o/oauth2/v2/auth?x=1",
    "https://evil.example/o/oauth2/v2/auth?x=1",
    "https://evilgoogle.com/o/oauth2/v2/auth?x=1",
    "https://mail.google.com/o/oauth2/v2/auth?x=1",
    "https://accounts.google.com@evil.example/o/oauth2/v2/auth",
    "https://user:pw@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com:8443/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/other",
    "https://accounts.google.com/o/oauth2/v2/auth#frag",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "ms-msdt:/id",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(isGoogleAuthUrl(url)).toBe(false);
  });

  it("never calls the opener with a refused URL", async () => {
    const open = vi.fn(() => Promise.resolve());
    const guarded = openGoogleAuthUrl(open);
    await expect(guarded("https://evil.example/")).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    await guarded(real);
    expect(open).toHaveBeenCalledWith(real);
  });

  it("opens the parsed form, never the raw string the parser forgave", async () => {
    const open = vi.fn(() => Promise.resolve());
    const guarded = openGoogleAuthUrl(open);
    for (const raw of [` ${real}`, `${real} `, real.replace("/auth?", "/auth\t?"), `${real}\n`]) {
      await guarded(raw);
      expect(open).toHaveBeenLastCalledWith(real);
    }
  });
});
