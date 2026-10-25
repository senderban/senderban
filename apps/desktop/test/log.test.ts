import { describe, expect, it } from "vitest";
import { accountTag } from "../src/log.js";

describe("accountTag", () => {
  it("keeps an opaque id readable", () => {
    expect(accountTag("work")).toBe("work");
  });

  it("replaces an id that is an address by a short stable tag with no part of the address", () => {
    const tag = accountTag("alice@example.com");
    expect(tag).toMatch(/^acct-[0-9a-f]{8}$/);
    expect(tag).toBe(accountTag("alice@example.com"));
    expect(tag).not.toBe(accountTag("bob@example.com"));
    expect(tag).not.toContain("alice");
  });
});
