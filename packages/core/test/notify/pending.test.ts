import { describe, expect, it } from "vitest";
import { PendingBlocks, isNotificationId } from "../../src/notify/pending.js";

const block = { accountId: "main", sender: "spam@example.com" };
const ids = (): (() => string) => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

describe("PendingBlocks", () => {
  it("peek answers as consume would and leaves the id its one click", () => {
    const pending = new PendingBlocks();
    const id = pending.add(block);
    expect(pending.peek(id)).toEqual({ status: "ok", block });
    expect(pending.peek(id)).toEqual({ status: "ok", block });
    expect(pending.consume(id)).toEqual({ status: "ok", block });
    expect(pending.peek(id)).toEqual({ status: "duplicate" });
    expect(pending.peek("0f8fad5b-d9cb-469f-a165-70867728950e")).toEqual({ status: "unknown" });
  });

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

describe("PendingBlocks.restore", () => {
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const HOUR = 3_600_000;

  it("takes back a toast announced before this table was made, once", () => {
    const pending = new PendingBlocks({ now: () => 10 * HOUR });
    expect(pending.restore(ID, block, 9 * HOUR)).toBe(true);
    expect(pending.consume(ID)).toEqual({ status: "ok", block });
    expect(pending.consume(ID)).toEqual({ status: "duplicate" });
  });

  it("does not take back an id this table already holds, spent or not", () => {
    const pending = new PendingBlocks({ now: () => 10 * HOUR, newId: () => ID });
    const id = pending.add(block);
    pending.consume(id);
    expect(pending.restore(id, { accountId: "other", sender: "x@example.com" }, 9 * HOUR)).toBe(
      false,
    );
    expect(pending.consume(id)).toEqual({ status: "duplicate" });
  });

  it("does not take back a toast announced after this table was made: that one was evicted, expired or dropped", () => {
    let now = 10 * HOUR;
    const pending = new PendingBlocks({ now: () => now });
    now += 1000;
    expect(pending.restore(ID, block, now)).toBe(false);
    expect(pending.consume(ID)).toEqual({ status: "unknown" });
  });

  it("does not take back a toast older than the TTL", () => {
    const pending = new PendingBlocks({ ttlMs: HOUR, now: () => 10 * HOUR });
    expect(pending.restore(ID, block, 8 * HOUR)).toBe(false);
    expect(pending.restore(ID, block, 10 * HOUR - HOUR + 1)).toBe(true);
  });

  it("lets a restored entry expire on its own issue time, even behind a newer entry", () => {
    let now = 100 * HOUR;
    const pending = new PendingBlocks({ now: () => now });
    pending.add(block);
    // Issued 23 h 59 min before this table was made: one minute of its TTL is left.
    expect(pending.restore(ID, block, now - 24 * HOUR + 60_000)).toBe(true);
    now += 2 * 60_000;
    expect(pending.peek(ID)).toEqual({ status: "unknown" });
    expect(pending.consume(ID)).toEqual({ status: "unknown" });
    expect(pending.size).toBe(1);
  });

  it("refuses an id that is not a lowercase UUID", () => {
    const pending = new PendingBlocks({ now: () => 10 * HOUR });
    expect(pending.restore("not-an-id", block, 9 * HOUR)).toBe(false);
    expect(pending.size).toBe(0);
  });

  it("stays inside the cap: restored entries evict the oldest like added ones", () => {
    const pending = new PendingBlocks({ max: 2, now: () => 10 * HOUR });
    const ids = ["1", "2", "3"].map((n) => `0f8fad5b-d9cb-469f-a165-70867728950${n}`);
    for (const id of ids) pending.restore(id, block, 9 * HOUR);
    expect(pending.size).toBe(2);
    expect(pending.consume(ids[0] ?? "").status).toBe("unknown");
  });
});
