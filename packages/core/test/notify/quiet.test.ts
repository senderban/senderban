import { describe, expect, it } from "vitest";
import { PendingBlocks } from "../../src/notify/pending.js";
import {
  QUIET_ENTRY_MAX,
  QUIET_MAX,
  QuietEntrySchema,
  QuietFileSchema,
  isQuiet,
  quietTarget,
} from "../../src/notify/quiet.js";

const own = { domains: new Set(["mine.example"]), addresses: new Set(["me@mine.example"]) };

describe("isQuiet", () => {
  const list = new Set(["news@deals.example", "github.example"]);

  it.each([
    ["news@deals.example", true],
    ["other@deals.example", false],
    ["a@github.example", true],
    ["a@notifications.github.example", true],
    ["a@deep.notifications.github.example", true],
    ["a@notgithub.example", false],
    ["a@github.example.attacker.test", false],
  ])("%s -> %s", (sender, expected) => {
    expect(isQuiet(sender, list)).toBe(expected);
  });

  it("is false on an empty list", () => {
    expect(isQuiet("a@example.com", new Set())).toBe(false);
  });
});

describe("QuietEntrySchema", () => {
  it.each(["news@deals.example", "deals.example"])("takes %s", (value) => {
    expect(QuietEntrySchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["an empty value", ""],
    ["a capital", "News@deals.example"],
    ["no local part", "@deals.example"],
    ["a space", "deals example"],
    ["a control character", "deals\n.example"],
    ["an oversize value", `${"a".repeat(QUIET_ENTRY_MAX)}.example`],
  ])("refuses %s", (_name, value) => {
    expect(QuietEntrySchema.safeParse(value).success).toBe(false);
  });
});

describe("QuietFileSchema", () => {
  it("is bounded and strict", () => {
    const entries = Array.from({ length: QUIET_MAX + 1 }, (_, n) => `a${String(n)}.example`);
    expect(QuietFileSchema.safeParse({ version: 1, entries }).success).toBe(false);
    expect(QuietFileSchema.safeParse({ version: 1, entries: [], x: 1 }).success).toBe(false);
    expect(QuietFileSchema.safeParse({ version: 1, entries: entries.slice(1) }).success).toBe(true);
  });
});

describe("quietTarget", () => {
  const announced = (sender: string) => {
    const pending = new PendingBlocks();
    return { pending, id: pending.add({ accountId: "a", sender }) };
  };

  it("takes the address on the sender button", () => {
    const { pending, id } = announced("news@deals.example");
    expect(quietTarget(pending, id, "address", own)).toEqual({
      status: "ok",
      value: "news@deals.example",
    });
  });

  it("takes the domain on the domain button", () => {
    const { pending, id } = announced("news@mail.deals.example");
    expect(quietTarget(pending, id, "domain", own)).toEqual({
      status: "ok",
      value: "mail.deals.example",
    });
  });

  it.each(["a@gmail.com", "a@mine.example"])("refuses the whole domain of %s", (sender) => {
    const { pending, id } = announced(sender);
    expect(quietTarget(pending, id, "domain", own)).toEqual({ status: "not-offered" });
  });

  it("uses each id once and knows no other", () => {
    const { pending, id } = announced("news@deals.example");
    quietTarget(pending, id, "address", own);
    expect(quietTarget(pending, id, "address", own)).toEqual({ status: "duplicate" });
    expect(quietTarget(pending, "0f8fad5b-d9cb-469f-a165-70867728950e", "address", own)).toEqual({
      status: "unknown",
    });
  });
});
