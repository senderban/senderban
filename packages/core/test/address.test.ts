import { describe, expect, it } from "vitest";
import { mailboxKey, parseAddress } from "../src/address.js";

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

  // Red-team KC-1: each of these used to canonicalise to a clean ASCII sender.
  it.each([
    ["noreply@\u{1D41B}\u{1D41A}\u{1D427}\u{1D424}.com", "math-bold letters"],
    ["noreply@ｂａｎｋ.com", "full-width letters"],
    ["noreply@ﬁnance.com", "fi ligature"],
    ["noreply@bank。com", "ideographic full stop"],
    ["noreply@Kelly.com", "Kelvin sign in the domain"],
    ["Kelly@bank.com", "Kelvin sign in the local part"],
    ["noreply@ba­nk.com", "soft hyphen"],
    ["noreply@ba​nk.com", "zero-width space"],
    ["noreply@ba‮nk.com", "bidi override"],
  ])("rejects look-alike or invisible characters: %s (%s)", (input) => {
    expect(parseAddress(input).ok).toBe(false);
  });

  // Red-team KC-4: control characters are rejected, not folded into the next token.
  it.each([
    ["a@x.com\r\nb", "CR LF then text"],
    ["a@x\t.com", "tab inside the domain"],
    ["a@x.com\u0000", "NUL"],
    ["a\u0085@x.com", "NEL"],
  ])("rejects control characters: %j (%s)", (input) => {
    expect(parseAddress(input).ok).toBe(false);
  });

  it.each([
    ["noreply@\u0451\u3002bank.com", "ideographic dot hides a fold behind a label boundary"],
    ["noreply@xn--e1a\uFF0Ebank.com", "full-width dot after a punycode label"],
  ])("rejects a fold hidden behind a dot variant: %s (%s)", (input) => {
    expect(parseAddress(input).ok).toBe(false);
  });

  // Pre-push security review BLOCK-1: domainToASCII percent-decodes after the guards, so a plain-ASCII
  // `%62ank.com` read as the real `bank.com` and the popup offered to block it.
  it.each([
    ["noreply@%62ank.com", "percent-encoded letter"],
    ["noreply@ba%6Ek.com", "percent-encoded letter, middle"],
    ["noreply@bank%2Ecom", "percent-encoded dot makes a label boundary"],
    ["noreply@evil%2Ebank.com", "percent-encoded dot, subdomain"],
    ["noreply@%F0%9D%90%9Bank.com", "percent-encoded math-bold letter"],
    ["noreply@ba%C2%ADnk.com", "percent-encoded soft hyphen"],
    ["noreply@ba%E2%80%8Bnk.com", "percent-encoded zero-width space"],
    ["noreply@bank%E3%80%82com", "percent-encoded ideographic dot"],
    ["x@%67mail.com", "percent-encoded freemail domain"],
    ["noreply@ba_nk.com", "underscore"],
    ["noreply@bank.com:25", "port"],
    ["noreply@bank.com/x", "path"],
  ])("rejects a domain that only turns into a clean one by decoding: %s (%s)", (input) => {
    expect(parseAddress(input).ok).toBe(false);
  });

  it("keeps every accepted ASCII domain exactly as written, lowercased", () => {
    for (const domain of ["Bank.COM", "a-b.example.org", "xn--bcher-kva.example", "1a.example"]) {
      const r = parseAddress(`a@${domain}`);
      expect(r.ok && r.value.domain).toBe(domain.toLowerCase());
    }
  });

  it("accepts punycode input as it is, in any case, and rejects a trailing dot", () => {
    const r = parseAddress("a@XN--BCHER-KVA.example");
    expect(r.ok && r.value.domain).toBe("xn--bcher-kva.example");
    expect(parseAddress("a@example.com.").ok).toBe(false);
  });

  it("keeps a real IDN as visible punycode, including a Cyrillic look-alike", () => {
    const r = parseAddress("noreply@bаnk.com");
    expect(r.ok && r.value.domain).toBe("xn--bnk-6cd.com");
  });

  it("still trims whitespace around the address", () => {
    expect(parseAddress("\r\n a@example.com \t").ok).toBe(true);
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

describe("mailboxKey", () => {
  it.each([
    ["me@gmail.com", "me@gmail.com"],
    ["m.e@gmail.com", "me@gmail.com"],
    ["m.e.@gmail.com", "me@gmail.com"],
    ["me+news@gmail.com", "me@gmail.com"],
    ["m.e+a+b@gmail.com", "me@gmail.com"],
    ["me@googlemail.com", "me@gmail.com"],
    ["m.e+x@googlemail.com", "me@gmail.com"],
  ])("reads %s as the Gmail mailbox %s", (address, key) => {
    expect(mailboxKey(address)).toBe(key);
  });

  it.each([
    "m.e@example.com",
    "me+news@example.com",
    "me@mail.gmail.com",
    "me@gmail.com.example.com",
    "me@notgmail.com",
  ])("leaves %s alone: dots and tags count outside Gmail's own domains", (address) => {
    expect(mailboxKey(address)).toBe(address);
  });

  it("never turns an address into an empty local part", () => {
    expect(mailboxKey("+tag@gmail.com")).toBe("+tag@gmail.com");
    expect(mailboxKey("...@gmail.com")).toBe("...@gmail.com");
  });

  it("keeps different mailboxes apart", () => {
    expect(mailboxKey("me@gmail.com")).not.toBe(mailboxKey("you@gmail.com"));
    expect(mailboxKey("me2@gmail.com")).not.toBe(mailboxKey("me@gmail.com"));
  });
});
