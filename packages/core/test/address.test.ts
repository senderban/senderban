import { describe, expect, it } from "vitest";
import { parseAddress } from "../src/address.js";

describe("parseAddress", () => {
  it("normalises case and trims", () => {
    const r = parseAddress("  Foo.Bar+tag@Example.COM ");
    expect(r).toEqual({
      ok: true,
      value: { local: "foo.bar+tag", domain: "example.com", address: "foo.bar+tag@example.com" },
    });
  });

  it("converts an IDN domain to punycode", () => {
    const r = parseAddress("a@bücher.example");
    expect(r.ok && r.value.domain).toBe("xn--bcher-kva.example");
  });

  it.each([
    ["", "empty"],
    ["no-at-sign", "no @"],
    ["a@b@c.com", "two @"],
    ["@example.com", "empty local"],
    ["a@", "empty domain"],
    ['"quoted"@example.com', "quoted local part"],
    ["a b@example.com", "space in local"],
    [".a@example.com", "leading dot"],
    ["a..b@example.com", "double dot"],
    ["a@localhost", "single label"],
    ["a@exa_mple.com", "underscore label"],
    ["a@-example.com", "leading hyphen label"],
    ["a@example.123", "numeric TLD"],
    ["a@[127.0.0.1]", "ip literal"],
    ["Foo <a@example.com>", "display name"],
  ])("rejects %s (%s)", (input) => {
    expect(parseAddress(input).ok).toBe(false);
  });

  it("enforces the RFC 5321 length limits", () => {
    expect(parseAddress(`${"a".repeat(64)}@example.com`).ok).toBe(true);
    expect(parseAddress(`${"a".repeat(65)}@example.com`).ok).toBe(false);
    expect(parseAddress(`a@${"b".repeat(64)}.com`).ok).toBe(false);
    expect(
      parseAddress(`a@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}.com`)
        .ok,
    ).toBe(false);
  });
});
