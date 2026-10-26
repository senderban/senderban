import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import { GMAIL_PROFILE_URL, fetchProfile } from "../../src/google/profile.js";
import { ACCESS, FakeGoogle } from "./fake-google.js";

const failure = async (work: Promise<unknown>): Promise<AdapterError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AdapterError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
};

const options = (fake: FakeGoogle) => ({ fetch: fake.fetch, timeoutMs: 500 });
const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

describe("fetchProfile", () => {
  it("asks Google's fixed profile URL with the bearer token and no redirect", async () => {
    const fake = new FakeGoogle();
    await fetchProfile(ACCESS, options(fake));
    const call = fake.calls[0];
    expect(call?.url).toBe(GMAIL_PROFILE_URL);
    expect(call?.method).toBe("GET");
    expect(call?.headers["Authorization"]).toBe(`Bearer ${ACCESS}`);
    expect(call?.redirect).toBe("error");
  });

  it("returns the address in canonical form and the history id as a string", async () => {
    const fake = new FakeGoogle();
    fake.email = "Me@Gmail.COM";
    fake.historyId = "18446744073709551615";
    expect(await fetchProfile(ACCESS, options(fake))).toEqual({
      email: "me@gmail.com",
      historyId: "18446744073709551615",
    });
  });

  it.each([
    ["a number", 1234],
    ["letters", "12ab"],
    ["empty", ""],
    ["21 digits", "1".repeat(21)],
    ["negative", "-1"],
  ])("refuses a history id that is %s", async (_name, historyId) => {
    const fake = new FakeGoogle();
    fake.forced.push(json(200, { emailAddress: "me@gmail.com", historyId }));
    expect((await failure(fetchProfile(ACCESS, options(fake)))).code).toBe("TRANSIENT");
  });

  it.each([
    ["a display name", "Me <me@gmail.com>"],
    ["no @", "megmail.com"],
    ["a space", "me @gmail.com"],
    ["a look-alike domain", "me@ｇmail.com"],
  ])("refuses an address with %s, and does not echo it", async (_name, emailAddress) => {
    const fake = new FakeGoogle();
    fake.forced.push(json(200, { emailAddress, historyId: "1" }));
    const error = await failure(fetchProfile(ACCESS, options(fake)));
    expect(error.code).toBe("REJECTED");
    expect(error.message).not.toContain("gmail");
  });

  it.each([
    ["empty", ""],
    ["a space", "a b"],
    ["a line break", "a\r\nX: y"],
    ["past 2048 characters", "a".repeat(2049)],
  ])(
    "refuses an access token that is %s, before any request (it goes into a header)",
    async (_name, token) => {
      const fake = new FakeGoogle();
      expect((await failure(fetchProfile(token, options(fake)))).code).toBe("REJECTED");
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("maps a 401 to 'sign in again'", async () => {
    const fake = new FakeGoogle();
    expect((await failure(fetchProfile("ya29.wrong", options(fake)))).code).toBe("AUTH_REQUIRED");
  });

  it("tells a 403 rate limit from a 403 missing permission by the reason, not the status", async () => {
    const fake = new FakeGoogle();
    const body = (reason: string) => json(403, { error: { code: 403, errors: [{ reason }] } });
    fake.forced.push(
      body("rateLimitExceeded"),
      body("userRateLimitExceeded"),
      body("insufficientPermissions"),
      json(403, {}),
    );
    expect((await failure(fetchProfile(ACCESS, options(fake)))).code).toBe("QUOTA_EXCEEDED");
    expect((await failure(fetchProfile(ACCESS, options(fake)))).code).toBe("QUOTA_EXCEEDED");
    expect((await failure(fetchProfile(ACCESS, options(fake)))).code).toBe("AUTH_REQUIRED");
    // No reason at all: a missing permission is the safe reading, and it is not retried in a loop.
    expect((await failure(fetchProfile(ACCESS, options(fake)))).code).toBe("AUTH_REQUIRED");
  });

  it.each([
    [429, "QUOTA_EXCEEDED"],
    [500, "TRANSIENT"],
    [503, "TRANSIENT"],
    [404, "REJECTED"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const fake = new FakeGoogle();
    fake.forced.push({ status, body: "" });
    expect((await failure(fetchProfile(ACCESS, options(fake)))).code).toBe(code);
  });

  it("never carries the token, the address or Google's words in an error", async () => {
    const fake = new FakeGoogle();
    fake.forced.push(
      json(403, {
        error: {
          message: `no access for me@gmail.com ${ACCESS}`,
          errors: [{ reason: "forbidden" }],
        },
      }),
    );
    const error = await failure(fetchProfile(ACCESS, options(fake)));
    expect(error.message).not.toContain(ACCESS);
    expect(error.message).not.toContain("me@gmail.com");
  });

  it("gives up on a server that never answers", async () => {
    const fake = new FakeGoogle();
    fake.stall = true;
    expect((await failure(fetchProfile(ACCESS, { fetch: fake.fetch, timeoutMs: 30 }))).code).toBe(
      "TRANSIENT",
    );
  });

  it("tells the log the operation, status and time only", async () => {
    const fake = new FakeGoogle();
    const calls: unknown[] = [];
    await fetchProfile(ACCESS, { ...options(fake), onCall: (c) => calls.push(c) });
    expect(Object.keys(calls[0] as object).sort()).toEqual(["ms", "op", "status"]);
    expect(calls[0]).toMatchObject({ op: "profile", status: 200 });
  });
});
