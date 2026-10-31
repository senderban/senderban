import { describe, expect, it } from "vitest";
import type { BlockAction, BlockEntry } from "../../src/blocklist.js";
import { compileRules } from "../../src/imap-clean/rules.js";

let n = 0;
const entry = (
  match: BlockEntry["match"],
  value: string,
  action: BlockAction = "junk",
): BlockEntry => {
  n += 1;
  return {
    id: `0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d${String(n).padStart(4, "0")}`,
    match,
    value,
    action,
    createdAt: "2026-10-31T00:00:00.000Z",
  };
};

describe("compileRules", () => {
  it("matches one address exactly, not its neighbours", () => {
    const rules = compileRules([entry("exactAddress", "a@blocked.example")]);
    expect(rules.targetFor("a@blocked.example")).toBe("junk");
    expect(rules.targetFor("b@blocked.example")).toBeNull();
    expect(rules.targetFor("a@sub.blocked.example")).toBeNull();
  });

  it("keeps a domain rule to that domain", () => {
    const rules = compileRules([entry("exactDomain", "blocked.example")]);
    expect(rules.targetFor("x@blocked.example")).toBe("junk");
    expect(rules.targetFor("x@sub.blocked.example")).toBeNull();
  });

  it("takes subdomains under a subdomain rule, and no look-alike", () => {
    const rules = compileRules([entry("subdomains", "blocked.example")]);
    expect(rules.targetFor("x@blocked.example")).toBe("junk");
    expect(rules.targetFor("x@a.b.blocked.example")).toBe("junk");
    expect(rules.targetFor("x@notblocked.example")).toBeNull();
    expect(rules.targetFor("x@blocked.example.test")).toBeNull();
  });

  it("files reject as Junk: IMAP cannot refuse at the door", () => {
    const rules = compileRules([entry("exactAddress", "a@blocked.example", "reject")]);
    expect(rules.targetFor("a@blocked.example")).toBe("junk");
  });

  it("lets Junk win wherever two rules meet, as on Sieve", () => {
    const rules = compileRules([
      entry("exactAddress", "a@blocked.example", "trash"),
      entry("subdomains", "blocked.example", "junk"),
      entry("exactAddress", "b@trash.example", "trash"),
    ]);
    expect(rules.targetFor("a@blocked.example")).toBe("junk");
    expect(rules.targetFor("b@trash.example")).toBe("trash");
  });

  it("keeps a broader Trash rule behind a nearer one of the same kind", () => {
    const rules = compileRules([
      entry("subdomains", "blocked.example", "trash"),
      entry("subdomains", "a.blocked.example", "junk"),
    ]);
    expect(rules.targetFor("x@b.a.blocked.example")).toBe("junk");
    expect(rules.targetFor("x@c.blocked.example")).toBe("trash");
  });

  it("holds nothing for an empty list", () => {
    expect(compileRules([]).targetFor("a@blocked.example")).toBeNull();
    expect(compileRules([]).size).toBe(0);
  });
});
