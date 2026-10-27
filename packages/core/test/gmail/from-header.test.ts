import { describe, expect, it } from "vitest";
import {
  FROM_HEADER_MAX_CHARS,
  FROM_UNPARSABLE,
  parseFromHeaders,
  parseFromValue,
} from "../../src/gmail/from-header.js";

const ok = (address: string) => ({ ok: true, address });
const bad = { ok: false, reason: FROM_UNPARSABLE };

describe("parseFromValue: the one mailbox of a From header", () => {
  const accepted: [string, string, string][] = [
    ["bare address", "x@spam.example", "x@spam.example"],
    ["angle address", "<x@spam.example>", "x@spam.example"],
    ["name and angle", "Spam Inc <X@Spam.Example>", "x@spam.example"],
    ["quoted name", '"Spam, Inc." <x@spam.example>', "x@spam.example"],
    ["display name that is an address", '"boss@co.com" <x@spam.example>', "x@spam.example"],
    ["unquoted name that is an address", "boss@co.com <x@spam.example>", "x@spam.example"],
    ["escaped quote in name", '"a \\" b" <x@spam.example>', "x@spam.example"],
    ["folded line", "Spam Inc\r\n <x@spam.example>", "x@spam.example"],
    ["encoded word name", "=?UTF-8?B?w7zDvA==?= <x@spam.example>", "x@spam.example"],
    ["plus tag kept", "<a+b@spam.example>", "a+b@spam.example"],
    ["punycode domain", "<x@bücher.example>", "x@xn--bcher-kva.example"],
  ];
  it.each(accepted)("%s", (_name, input, address) => {
    expect(parseFromValue(input)).toEqual(ok(address));
  });

  const refused: [string, string][] = [
    ["empty", ""],
    ["blank", "   "],
    ["two mailboxes", "a@x.example, b@y.example"],
    ["two angle mailboxes", "<a@x.example> <b@y.example>"],
    ["group syntax", "Friends: a@x.example, b@y.example;"],
    ["empty group", "undisclosed-recipients:;"],
    ["comment after", "a@x.example (Alice)"],
    ["comment in name", "Alice (work) <a@x.example>"],
    ["text after the bracket", "<a@x.example> b@y.example"],
    ["unclosed bracket", "Alice <a@x.example"],
    [
      "backslash outside quotes (a reader may take it as an escape)",
      String.raw`Alice\<a@x.example>`,
    ],
    ["unopened bracket", "a@x.example>"],
    ["nested open bracket", "<<a@x.example>"],
    ["unbalanced quote", '"Alice <a@x.example>'],
    ["quote inside the brackets", '<"a"@x.example>'],
    ["name with no address", "Alice"],
    ["address with a space", "a b@x.example"],
    ["empty brackets", "Alice <>"],
    ["control character", "<a@x.example>\u0000"],
    ["bare line feed", "<a@x.example>\nBcc: b@y.example"],
    ["zero-width in the domain", "<a@x​.example>"],
    ["no domain", "<a@>"],
    ["colon in a bare value", "a:b@x.example"],
    ["too long", `<${"a".repeat(FROM_HEADER_MAX_CHARS)}@x.example>`],
  ];
  it.each(refused)("refuses: %s", (_name, input) => {
    expect(parseFromValue(input)).toEqual(bad);
  });

  // Each of these would still be read as one address if only the checks that look at the address itself ran: the
  // display name is where a list separator or a control character hides.
  it.each([
    ["a comma in an unquoted name", "Alice, Bob <a@x.example>"],
    ["a semicolon in an unquoted name", "Alice; Bob <a@x.example>"],
    ["a NUL in the name", "Alice\u0000 <a@x.example>"],
    ["a bare line feed in the name", "Alice\nBcc: b@y.example <a@x.example>"],
    ["an unclosed quote after the address", '<a@x.example> Alice"'],
  ])("refuses: %s", (_name, input) => {
    expect(parseFromValue(input)).toEqual(bad);
  });

  it("a comma or semicolon inside a quoted name is part of the name", () => {
    expect(parseFromValue('"Smith; John, Jr." <a@x.example>')).toEqual(ok("a@x.example"));
  });
  it("a value of exactly the limit is still read", () => {
    const name = "n".repeat(FROM_HEADER_MAX_CHARS - "<a@x.example>".length - 1);
    expect(parseFromValue(`${name}<a@x.example>`)).toEqual(ok("a@x.example"));
  });
});

describe("parseFromHeaders: exactly one From header", () => {
  const from = (value: string) => ({ name: "From", value });
  it("reads one header, whatever the name's case", () => {
    expect(parseFromHeaders([{ name: "FROM", value: "<x@spam.example>" }])).toEqual(
      ok("x@spam.example"),
    );
    expect(parseFromHeaders([{ name: "Subject", value: "hi" }, from("<x@spam.example>")])).toEqual(
      ok("x@spam.example"),
    );
  });
  it("refuses none and two", () => {
    expect(parseFromHeaders([])).toEqual(bad);
    expect(parseFromHeaders([{ name: "Subject", value: "x@y.example" }])).toEqual(bad);
    expect(parseFromHeaders([from("<a@x.example>"), from("<b@y.example>")])).toEqual(bad);
    // the same address twice is still two headers: nothing legitimate sends that
    expect(
      parseFromHeaders([from("<a@x.example>"), { name: "from", value: "<a@x.example>" }]),
    ).toEqual(bad);
  });
  it("other headers that look like a sender are not read", () => {
    expect(
      parseFromHeaders([
        { name: "Sender", value: "<s@x.example>" },
        { name: "Reply-To", value: "<r@x.example>" },
        { name: "X-From", value: "<f@x.example>" },
      ]),
    ).toEqual(bad);
  });
  it("the reason is a fixed word, never header text", () => {
    expect(JSON.stringify(parseFromHeaders([from("a@x.example, secret@y.example")]))).not.toContain(
      "secret",
    );
  });
});
