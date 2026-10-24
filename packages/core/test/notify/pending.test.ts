import { describe, expect, it } from "vitest";
import { PendingBlocks, activationTag } from "../../src/notify/pending.js";

const block = { accountId: "main", sender: "spam@example.com" };
const ids = (): (() => string) => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

describe("PendingBlocks", () => {
  it("hands a block out once; the second activation of the same click is a duplicate", () => {
    const pending = new PendingBlocks({ newId: ids() });
    const id = pending.add(block);
    expect(pending.consume(id)).toEqual({ status: "ok", block });
    expect(pending.consume(id)).toEqual({ status: "duplicate" });
    expect(pending.consume(id)).toEqual({ status: "duplicate" });
  });

  it("reports an id it never issued as unknown", () => {
    const pending = new PendingBlocks({ newId: ids() });
    expect(pending.consume("00000000-0000-4000-8000-0000000000ff")).toEqual({ status: "unknown" });
  });

  it("forgets an entry after the TTL, spent or not", () => {
    let now = 1_000;
    const pending = new PendingBlocks({ ttlMs: 100, now: () => now, newId: ids() });
    const fresh = pending.add(block);
    const spent = pending.add(block);
    pending.consume(spent);
    now += 101;
    expect(pending.consume(fresh)).toEqual({ status: "unknown" });
    expect(pending.consume(spent)).toEqual({ status: "unknown" });
    expect(pending.size).toBe(0);
  });

  it("keeps newer entries when older ones expire", () => {
    let now = 0;
    const pending = new PendingBlocks({ ttlMs: 100, now: () => now, newId: ids() });
    const old = pending.add(block);
    now = 60;
    const young = pending.add(block);
    now = 120;
    expect(pending.consume(old).status).toBe("unknown");
    expect(pending.consume(young).status).toBe("ok");
  });

  it("evicts the oldest entry beyond max", () => {
    const pending = new PendingBlocks({ max: 3, newId: ids() });
    const first = pending.add(block);
    const rest = [pending.add(block), pending.add(block), pending.add(block)];
    expect(pending.size).toBe(3);
    expect(pending.consume(first).status).toBe("unknown");
    expect(pending.consume(rest[2] as string).status).toBe("ok");
  });

  it("refuses an id that is not a lowercase UUID", () => {
    const pending = new PendingBlocks({ newId: () => "tag=1&x" });
    expect(() => pending.add(block)).toThrow();
  });
});

describe("activationTag", () => {
  const tag = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("reads the tag Windows returns for a button", () => {
    expect(activationTag(`type=action&action=0&tag=${tag}`)).toBe(tag);
  });

  it("rejects anything that is not exactly a lowercase UUID", () => {
    for (const raw of [
      "",
      "type=action&action=0",
      "tag=",
      "tag=spike-A-native",
      `tag=${tag.toUpperCase()}`,
      `tag=${tag}x`,
      "tag=%00",
      `tag=${"a".repeat(600)}`,
    ]) {
      expect(activationTag(raw)).toBeNull();
    }
  });
});
