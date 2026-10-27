import { describe, expect, it } from "vitest";
import { PendingBlocks, isNotificationId } from "../../src/notify/pending.js";

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

  it("drops every announcement of one account and leaves the others", () => {
    const pending = new PendingBlocks({ newId: ids() });
    const gone = pending.add({ accountId: "removed", sender: "a@example.com" });
    const goneSpent = pending.add({ accountId: "removed", sender: "b@example.com" });
    pending.consume(goneSpent);
    const kept = pending.add({ accountId: "main", sender: "c@example.com" });
    pending.dropAccount("removed");
    expect(pending.size).toBe(1);
    expect(pending.consume(gone)).toEqual({ status: "unknown" });
    expect(pending.consume(goneSpent)).toEqual({ status: "unknown" });
    expect(pending.consume(kept).status).toBe("ok");
    pending.dropAccount("never-there");
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

describe("isNotificationId", () => {
  const id = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("accepts a lowercase UUID", () => {
    expect(isNotificationId(id)).toBe(true);
  });

  it("rejects anything that is not exactly a lowercase UUID", () => {
    for (const raw of [
      "",
      "tag=",
      "spike-A-native",
      id.toUpperCase(),
      `${id}x`,
      "\u0000",
      "a".repeat(600),
      null,
      42,
      { id },
    ]) {
      expect(isNotificationId(raw)).toBe(false);
    }
  });
});
