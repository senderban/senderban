import { describe, expect, it } from "vitest";
import { parseAddress } from "../../src/address.js";
import {
  GMAIL_ADDRESSES_PER_FILTER,
  compileFromQuery,
  isGmailMirrorable,
} from "../../src/gmail/query.js";

// The alphabet `parseAddress` lets through in a local part (LOCAL_ATOM) plus the dot: the whole space the contract must hold over.
const LOCAL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+/=?^_`{|}~-.";
const DOMAINS = ["example.com", "my-site.example", "a.b.co.uk", "xn--bcher-kva.example"];

/** Small seeded generator (xorshift32): the same cases every run, no new dependency. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/** What Gmail's search box would see: the compiled query must split into exactly `from:(`, quoted terms joined by ` OR `, and `)`. */
function terms(query: string): string[] | null {
  const m = /^from:\(("[^"]+"(?: OR "[^"]+")*)\)$/.exec(query);
  if (m === null) return null;
  const body = m[1] ?? "";
  const out: string[] = [];
  for (const part of body.split(" OR ")) {
    if (!/^"[^"]+"$/.test(part)) return null;
    out.push(part.slice(1, -1));
  }
  return out;
}

// Independent oracle: a positive allowlist of what may stand in an accepted local part, written apart from the code under test.
const SAFE_LOCAL = /^[a-z0-9]([a-z0-9._+-]*[a-z0-9])?$/;
const OPERATOR_OR_BREAKOUT = /["\s(){}*|\\]/;

describe("Gmail query encoding contract (BLOCK-1)", () => {
  it.each([
    "-x@spam.example",
    "+x@spam.example",
    "{a}@spam.example",
    "a*b@spam.example",
    "*@gmail.com",
    "x|y@spam.example",
    "a}or{b@spam.example",
    "x-@spam.example",
    "x.@spam.example",
    ".x@spam.example",
    "x!y@spam.example",
  ])("%s is not written to Gmail", (address) => {
    expect(isGmailMirrorable(address)).toBe(false);
    expect(() => compileFromQuery([address])).toThrow(TypeError);
  });

  it("refuses an address that is not in canonical form", () => {
    expect(isGmailMirrorable("Foo@Example.com")).toBe(false);
    expect(isGmailMirrorable(" foo@example.com")).toBe(false);
    expect(isGmailMirrorable('"a b"@example.com')).toBe(false);
    expect(isGmailMirrorable("foo@example.com OR bar@x.com")).toBe(false);
    expect(isGmailMirrorable('a"@example.com')).toBe(false);
  });

  it.each(["a@example.com", "a.b@example.com", "a+tag@example.com", "a_b-c@example.com", "0@a.co"])(
    "%s is written as one quoted phrase",
    (address) => {
      expect(isGmailMirrorable(address)).toBe(true);
      expect(compileFromQuery([address])).toBe(`from:("${address}")`);
    },
  );

  it("joins several addresses with OR, in the order given", () => {
    expect(compileFromQuery(["a@x.com", "b@y.com"])).toBe('from:("a@x.com" OR "b@y.com")');
  });

  it("property: over the whole LOCAL_ATOM alphabet, an accepted address compiles to exactly one inert quoted term, and every other one throws", () => {
    const next = rng(20261027);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const length = 1 + Math.floor(next() * 12);
      let local = "";
      for (let j = 0; j < length; j += 1) {
        local += LOCAL_ALPHABET[Math.floor(next() * LOCAL_ALPHABET.length)] ?? "a";
      }
      const domain = DOMAINS[Math.floor(next() * DOMAINS.length)] ?? "example.com";
      const parsed = parseAddress(`${local}@${domain}`);
      if (!parsed.ok) continue; // not an address at all: never reaches an adapter
      const address = parsed.value.address;
      if (isGmailMirrorable(address)) {
        accepted += 1;
        const query = compileFromQuery([address]);
        expect(terms(query)).toEqual([address]);
        // Nothing inside the quotes can close them or act as an operator.
        expect(OPERATOR_OR_BREAKOUT.test(address)).toBe(false);
        // Any character outside the allowlist in an accepted address (a widened regex) fails here, not only the named operators.
        expect(SAFE_LOCAL.test(parsed.value.local)).toBe(true);
        // A term never starts with `-` (Gmail's exclude).
        expect(address.startsWith("-")).toBe(false);
      } else {
        refused += 1;
        expect(() => compileFromQuery([address])).toThrow(TypeError);
      }
    }
    // The generator really exercises both sides, so the property is not satisfied by an empty case.
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });

  it("property: a filter of up to the capacity compiles to exactly its addresses, no more", () => {
    const next = rng(7);
    const pool: string[] = [];
    while (pool.length < GMAIL_ADDRESSES_PER_FILTER) {
      let local = "";
      const length = 1 + Math.floor(next() * 10);
      for (let j = 0; j < length; j += 1)
        local += "abcdefghij0123456789._+-"[Math.floor(next() * 24)] ?? "a";
      const parsed = parseAddress(
        `${local}@${DOMAINS[Math.floor(next() * DOMAINS.length)] ?? "example.com"}`,
      );
      if (
        parsed.ok &&
        isGmailMirrorable(parsed.value.address) &&
        !pool.includes(parsed.value.address)
      ) {
        pool.push(parsed.value.address);
      }
    }
    for (const size of [1, 2, 17, GMAIL_ADDRESSES_PER_FILTER]) {
      const chosen = pool.slice(0, size);
      expect(terms(compileFromQuery(chosen))).toEqual(chosen);
    }
  });

  it("refuses an empty list and a list over the capacity", () => {
    expect(() => compileFromQuery([])).toThrow(RangeError);
    const over = Array.from(
      { length: GMAIL_ADDRESSES_PER_FILTER + 1 },
      (_, i) => `u${String(i)}@x.com`,
    );
    expect(() => compileFromQuery(over)).toThrow(RangeError);
  });

  it("the error text never repeats the address", () => {
    let message = "";
    try {
      compileFromQuery(["-secret@spam.example"]);
    } catch (error) {
      message = (error as Error).message;
    }
    // Empty means the call did not throw: the test must fail then, not pass.
    expect(message).not.toBe("");
    expect(message).not.toContain("secret");
  });

  it("a 50-address filter stays far under the measured query wall (14,003 characters accepted)", () => {
    const addresses = Array.from(
      { length: GMAIL_ADDRESSES_PER_FILTER },
      (_, i) => `sender${String(i)}@a-long-domain-name.example.com`,
    );
    expect(compileFromQuery(addresses).length).toBeLessThan(5_000);
  });
});
