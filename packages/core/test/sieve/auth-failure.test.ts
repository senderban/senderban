import { describe, expect, it } from "vitest";
import { willRetry } from "../../src/sync/engine.js";
import { parseResponse } from "../../src/sieve/codec.js";
import { authFailure } from "../../src/sieve/managesieve.js";

function reply(text: string) {
  const parsed = parseResponse(Buffer.from(text, "utf8"));
  if (parsed === null) throw new Error("test reply did not parse");
  return parsed.response;
}

describe("authFailure", () => {
  it("keeps a plain refusal permanent: a wrong password is never retried", () => {
    const error = authFailure(reply('NO "Authentication failed."\r\n'));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(willRetry(error.code)).toBe(false);
  });

  it("keeps AUTH-TOO-WEAK permanent (RFC 5804 s2.1)", () => {
    expect(authFailure(reply('NO (AUTH-TOO-WEAK) "no"\r\n')).code).toBe("AUTH_REQUIRED");
  });

  it("treats TRYLATER on AUTHENTICATE as a throttle, which is retried", () => {
    const error = authFailure(reply('NO (TRYLATER) "Too many login attempts"\r\n'));
    expect(error.code).toBe("TRANSIENT");
    expect(willRetry(error.code)).toBe(true);
  });

  it("treats a lower-case trylater the same way", () => {
    expect(authFailure(reply('no (trylater) "slow down"\r\n')).code).toBe("TRANSIENT");
  });

  it("does not copy the server's words into the error", () => {
    const error = authFailure(reply('NO (TRYLATER) "secret-host-detail"\r\n'));
    expect(error.message).not.toContain("secret-host-detail");
  });

  it("treats BYE as transient", () => {
    expect(authFailure(reply('BYE "Server shutting down"\r\n')).code).toBe("TRANSIENT");
  });
});
