import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import type { OpaqueState } from "../../src/adapter.js";
import type { BlockEntry } from "../../src/blocklist.js";
import {
  MXROUTE_MAX_CHANGES_PER_ROUND,
  MxrouteAdapter,
  initialMxrouteState,
  mxrouteLaneId,
} from "../../src/mxroute/adapter.js";
import { ACCOUNT_ID } from "../../src/sync/engine.js";
import { createMxrouteClient } from "../../src/mxroute/client.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/store.js";
import { SyncEngine } from "../../src/sync/engine.js";
import { unblock } from "../../src/notify/unblock.js";
import { FakeMxroute } from "./fake-mxroute.js";

const KEY = "test-mxroute-key-not-real-0000";
const LANE = "info@example.com.mxroute";

let n = 0;
const entry = (
  match: BlockEntry["match"],
  value: string,
  action: BlockEntry["action"] = "reject",
) => ({
  id: crypto.randomUUID(),
  match,
  value,
  action,
  createdAt: new Date(Date.UTC(2026, 9, 25, 12, 0, n++)).toISOString(),
});

function setup() {
  const fake = new FakeMxroute();
  for (const own of ["@163.com", "*@qq.com", "fatma.sahin@index.com.tr"]) fake.entries.add(own);
  const client = createMxrouteClient({
    server: "mx.example.net",
    username: "exampleuser",
    getKey: () => Promise.resolve(KEY),
    fetch: fake.fetch,
    timeoutMs: 500,
  });
  const adapter = new MxrouteAdapter({ accountId: LANE, client });
  return { fake, adapter };
}

async function sync(adapter: MxrouteAdapter, list: BlockEntry[], state: OpaqueState) {
  const plan = await adapter.plan(list, state);
  return { plan, result: await adapter.apply(plan) };
}

describe("mxrouteLaneId", () => {
  it("is a valid engine lane id next to the account's own, even for the longest account id", () => {
    for (const id of [
      "info@example.com",
      "a",
      "x".repeat(64),
      `${"y".repeat(60)}@z.co`.slice(0, 64),
    ]) {
      const lane = mxrouteLaneId(id);
      expect(ACCOUNT_ID.test(lane)).toBe(true);
      expect(lane).not.toBe(id);
      expect(lane.endsWith(".mxroute")).toBe(true);
    }
    expect(mxrouteLaneId("info@example.com")).toBe("info@example.com.mxroute");
  });
});

describe("MxrouteAdapter plan", () => {
  it("mirrors single addresses only; domain entries stay with Sieve", async () => {
    const { adapter } = setup();
    const list = [
      entry("exactAddress", "spam@example.com"),
      entry("exactDomain", "bulk.example"),
      entry("subdomains", "ads.example"),
    ];
    const plan = await adapter.plan(list, initialMxrouteState("example.com"));
    expect(plan.changes.map((c) => [c.kind, c.entry.value])).toEqual([
      ["create", "spam@example.com"],
    ]);
    expect(plan.accountId).toBe(LANE);
  });

  it("never mirrors an address with a wildcard: `*@gmail.com` would refuse every Gmail sender", async () => {
    const { adapter } = setup();
    const list = [
      entry("exactAddress", "*@gmail.com"),
      entry("exactAddress", "a*b@example.com"),
      entry("exactAddress", "ok@example.com"),
    ];
    const plan = await adapter.plan(list, initialMxrouteState("example.com"));
    expect(plan.changes.map((c) => c.entry.value)).toEqual(["ok@example.com"]);
  });

  it("skips an address the blacklist API cannot take instead of failing the account", async () => {
    const { adapter } = setup();
    const list = [
      entry("exactAddress", "o'brien@example.com"),
      entry("exactAddress", "ok@example.com"),
    ];
    const plan = await adapter.plan(list, initialMxrouteState("example.com"));
    expect(plan.changes.map((c) => c.entry.value)).toEqual(["ok@example.com"]);
  });

  it("is a no-op when nothing changed", async () => {
    const { adapter } = setup();
    const first = entry("exactAddress", "a@example.com");
    const { result } = await sync(adapter, [first], initialMxrouteState("example.com"));
    const again = await adapter.plan([first], result.state);
    expect(again.changes).toEqual([]);
  });

  it("never mirrors an address the person only sent to Junk or Trash", async () => {
    const { adapter } = setup();
    const plan = await adapter.plan(
      [
        entry("exactAddress", "junked@example.com", "junk"),
        entry("exactAddress", "trashed@example.com", "trash"),
        entry("exactAddress", "refused@example.com", "reject"),
      ],
      initialMxrouteState("example.com"),
    );
    expect(plan.changes.map((c) => c.entry.value)).toEqual(["refused@example.com"]);
  });

  it("takes an address off the blacklist when its action stops being reject", async () => {
    const { adapter } = setup();
    const first = entry("exactAddress", "a@example.com", "reject");
    const { result } = await sync(adapter, [first], initialMxrouteState("example.com"));
    const again = await adapter.plan([{ ...first, action: "junk" }], result.state);
    expect(again.changes.map((c) => [c.kind, c.entry.value])).toEqual([
      ["remove", "a@example.com"],
    ]);
  });

  it("refuses a state from another adapter or with a bad domain", async () => {
    const { adapter } = setup();
    await expect(adapter.plan([], { adapterId: "sieve", data: {} })).rejects.toBeInstanceOf(
      AdapterError,
    );
    await expect(
      adapter.plan([], { adapterId: "mxroute", data: { domain: "x", applied: [], extra: 1 } }),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(() => initialMxrouteState("not a domain")).toThrow();
  });
});

describe("MxrouteAdapter apply", () => {
  it("adds the address to the blacklist and never touches the person's own entries", async () => {
    const { fake, adapter } = setup();
    const a = entry("exactAddress", "spam@example.com");
    const { result } = await sync(adapter, [a], initialMxrouteState("example.com"));
    expect(result).toMatchObject({ applied: 1, failed: [] });
    expect(fake.entries.has("spam@example.com")).toBe(true);

    await sync(adapter, [], result.state);
    expect(fake.entries.has("spam@example.com")).toBe(false);
    expect([...fake.entries].sort()).toEqual(["*@qq.com", "@163.com", "fatma.sahin@index.com.tr"]);
  });

  it("is safe to run again after an interrupted round (409 and 404 are fine)", async () => {
    const { fake, adapter } = setup();
    const a = entry("exactAddress", "spam@example.com");
    fake.entries.add("spam@example.com"); // a round that died after the POST, before the state was saved
    const { result } = await sync(adapter, [a], initialMxrouteState("example.com"));
    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("plans at most MXROUTE_MAX_CHANGES_PER_ROUND and says how many are left for later rounds", async () => {
    const { fake, adapter } = setup();
    const many = Array.from({ length: MXROUTE_MAX_CHANGES_PER_ROUND + 5 }, (_, i) =>
      entry("exactAddress", `u${String(i)}@example.com`),
    );
    const first = await sync(adapter, many, initialMxrouteState("example.com"));
    // The journal keeps the plan of every round: it holds this round's changes, not the whole backlog.
    expect(first.plan.changes).toHaveLength(MXROUTE_MAX_CHANGES_PER_ROUND);
    expect(first.plan.deferred).toBe(5);
    expect(first.result).toMatchObject({ applied: MXROUTE_MAX_CHANGES_PER_ROUND, failed: [] });

    const second = await sync(adapter, many, first.result.state);
    expect(second.plan.deferred).toBeUndefined();
    expect(second.result).toMatchObject({ applied: 5, failed: [] });
    expect(fake.entries.size).toBe(3 + many.length);
  });

  it("sends removals before additions", async () => {
    const { fake, adapter } = setup();
    const old = entry("exactAddress", "old@example.com");
    const { result } = await sync(adapter, [old], initialMxrouteState("example.com"));
    fake.calls.length = 0;
    await sync(adapter, [entry("exactAddress", "new@example.com")], result.state);
    // The extra GET reads the blacklist back to confirm the removal.
    expect(fake.calls.map((c) => c.method)).toEqual(["DELETE", "POST", "GET"]);
  });

  it("throws when the very first request fails, so nothing is recorded", async () => {
    const { fake, adapter } = setup();
    fake.forced.push(401);
    const plan = await adapter.plan(
      [entry("exactAddress", "a@example.com")],
      initialMxrouteState("example.com"),
    );
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("keeps the progress made and defers the rest when MXroute asks to slow down", async () => {
    const { fake, adapter } = setup();
    const list = ["a", "b", "c"].map((u) => entry("exactAddress", `${u}@example.com`));
    const plan = await adapter.plan(list, initialMxrouteState("example.com"));
    fake.forced.push(201, 429);
    const result = await adapter.apply(plan);
    expect(result).toMatchObject({ applied: 1, failed: [], deferred: 2 });
    const data = result.state.data as { applied: { value: string }[] };
    expect(data.applied.map((e) => e.value)).toEqual(["a@example.com"]);
  });

  it("keeps the progress made and reports the rest as failed when a later request fails", async () => {
    const { fake, adapter } = setup();
    const list = [
      entry("exactAddress", "a@example.com"),
      entry("exactAddress", "b@example.com"),
      entry("exactAddress", "c@example.com"),
    ];
    const plan = await adapter.plan(list, initialMxrouteState("example.com"));
    fake.forced.push(201, 500);
    const result = await adapter.apply(plan);
    expect(result.applied).toBe(1);
    expect(result.failed.map((f) => f.error.code)).toEqual(["TRANSIENT", "TRANSIENT"]);
    expect(result.deferred).toBeUndefined();
    const data = result.state.data as { applied: { value: string }[] };
    expect(data.applied.map((e) => e.value)).toEqual(["a@example.com"]);
  });

  it("sends nothing once its signal has aborted", async () => {
    const { fake, adapter } = setup();
    const plan = await adapter.plan(
      [entry("exactAddress", "a@example.com")],
      initialMxrouteState("example.com"),
    );
    const controller = new AbortController();
    controller.abort(new AdapterError("TRANSIENT", "provider did not answer"));
    await expect(adapter.apply(plan, controller.signal)).rejects.toMatchObject({
      code: "TRANSIENT",
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("MxrouteAdapter round limits and refusals", () => {
  it("stops starting changes after its time budget and keeps the progress made", async () => {
    const { fake } = setup();
    let t = -20_000;
    const client = createMxrouteClient({
      server: "s",
      username: "u",
      getKey: () => Promise.resolve(KEY),
      fetch: fake.fetch,
    });
    const slow = new MxrouteAdapter({
      accountId: LANE,
      client,
      roundBudgetMs: 30_000,
      now: () => (t += 20_000),
    });
    const list = ["a", "b", "c", "d"].map((u) => entry("exactAddress", `${u}@example.com`));
    const { result } = await sync(slow, list, initialMxrouteState("example.com"));
    expect(result.applied).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.deferred).toBe(2);
    const data = result.state.data as { applied: { value: string }[] };
    expect(data.applied.map((e) => e.value)).toEqual(["a@example.com", "b@example.com"]);
    // The next round carries on where this one stopped.
    const next = await slow.plan(list, result.state);
    expect(next.changes.map((c) => c.entry.value)).toEqual(["c@example.com", "d@example.com"]);
  });

  it("sets aside an address MXroute refuses for good and carries on with the others", async () => {
    const { fake, adapter } = setup();
    const list = ["a", "b", "c"].map((u) => entry("exactAddress", `${u}@example.com`));
    fake.forced.push(400);
    const { result } = await sync(adapter, list, initialMxrouteState("example.com"));
    expect(result.applied).toBe(2);
    expect(result.failed.map((f) => f.error.code)).toEqual(["REJECTED"]);
    const data = result.state.data as { rejected: string[] };
    expect(data.rejected).toEqual(["a@example.com"]);
    expect(fake.entries.has("b@example.com") && fake.entries.has("c@example.com")).toBe(true);
    // It is not planned again, so one refused address cannot keep the lane retrying.
    const again = await adapter.plan(list, result.state);
    expect(again.changes).toEqual([]);
  });

  it("takes back what it added when switched off, and sends nothing when it added nothing", async () => {
    const { fake, adapter } = setup();
    const a = entry("exactAddress", "a@example.com");
    const { result } = await sync(adapter, [a], initialMxrouteState("example.com"));
    expect(fake.entries.has("a@example.com")).toBe(true);

    const client = createMxrouteClient({
      server: "s",
      username: "u",
      getKey: () => Promise.resolve(KEY),
      fetch: fake.fetch,
    });
    const off = new MxrouteAdapter({ accountId: LANE, client, mirror: false });
    const drained = await sync(off, [a], result.state);
    expect(drained.plan.changes.map((c) => c.kind)).toEqual(["remove"]);
    expect(fake.entries.has("a@example.com")).toBe(false);

    fake.calls.length = 0;
    const idle = await off.plan([a], drained.result.state);
    expect(idle.changes).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("treats an address that was already on the blacklist as its own and removes it on Unblock", async () => {
    const { fake, adapter } = setup();
    fake.entries.add("mine@example.com");
    const e = entry("exactAddress", "mine@example.com");
    const { result } = await sync(adapter, [e], initialMxrouteState("example.com"));
    await sync(adapter, [], result.state);
    expect(fake.entries.has("mine@example.com")).toBe(false);
  });
});

describe("MxrouteAdapter confirmation", () => {
  it("keeps an entry it could not see go away, so the next round removes it again", async () => {
    const { fake, adapter } = setup();
    const a = entry("exactAddress", "a@example.com");
    const { result } = await sync(adapter, [a], initialMxrouteState("example.com"));
    fake.forced.push(404); // DELETE answers "not found" but the entry is still listed
    const gone = await sync(adapter, [], result.state);
    expect(gone.result.applied).toBe(0);
    expect(gone.result.failed.map((f) => f.error.code)).toEqual(["TRANSIENT"]);
    const data = gone.result.state.data as { applied: { value: string }[] };
    expect(data.applied.map((e) => e.value)).toEqual(["a@example.com"]);

    const again = await sync(adapter, [], gone.result.state);
    expect(again.result.failed).toEqual([]);
    expect(fake.entries.has("a@example.com")).toBe(false);
  });

  it("fails the round, and records nothing as refused, when every address was refused", async () => {
    const { fake, adapter } = setup();
    const list = ["a", "b"].map((u) => entry("exactAddress", `${u}@example.com`));
    fake.forced.push(400, 400);
    const plan = await adapter.plan(list, initialMxrouteState("example.com"));
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "REJECTED" });
  });
});

describe("MxrouteAdapter verify", () => {
  it("asks MXroute nothing when nothing of ours is on the blacklist", async () => {
    const { fake, adapter } = setup();
    const drift = await adapter.verify(initialMxrouteState("example.com"));
    expect(drift.drifted).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("reads the blacklist back and reports an entry someone removed", async () => {
    const { fake, adapter } = setup();
    const { result } = await sync(
      adapter,
      [entry("exactAddress", "a@example.com")],
      initialMxrouteState("example.com"),
    );
    expect((await adapter.verify(result.state)).drifted).toBe(false);
    fake.entries.delete("a@example.com");
    const drift = await adapter.verify(result.state);
    expect(drift.drifted).toBe(true);
    expect(drift.detail).toContain("missing");
  });
});

describe("MXroute lane inside the real engine", () => {
  it("blocks an address at the door, reads it back, and unblock removes only that entry", async () => {
    const { fake, adapter } = setup();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 1_000 });
    engine.addAccount({ id: LANE, adapter, initialState: initialMxrouteState("example.com") });

    const added = store.add(entry("exactAddress", "spam@example.com"));
    if (!added.ok) throw new Error("add failed");
    store.add(entry("subdomains", "bulk.example"));
    expect(await engine.sync(LANE)).toMatchObject({ status: "applied", applied: 1 });
    expect(fake.entries.has("spam@example.com")).toBe(true);
    expect(fake.entries.has("bulk.example")).toBe(false);
    expect(await engine.verify(LANE)).toEqual({ accountId: LANE, status: "verified" });

    const result = await unblock({ store, engine, accountIds: [LANE] }, added.entry.id);
    expect(result).toMatchObject({ status: "unblocked", accounts: [{ confirmed: true }] });
    expect(fake.entries.has("spam@example.com")).toBe(false);
    expect(fake.entries.size).toBe(3);
    engine.dispose();
    store.close();
  });

  it("sends a backlog bigger than one round by itself, a round at a time", async () => {
    const { fake, adapter } = setup();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, {
      debounceMs: 5,
      timeoutMs: 1_000,
      retry: { baseMs: 10, maxMs: 40 },
      random: () => 0,
    });
    engine.addAccount({ id: LANE, adapter, initialState: initialMxrouteState("example.com") });
    const total = MXROUTE_MAX_CHANGES_PER_ROUND + 5;
    for (let i = 0; i < total; i++)
      store.add(entry("exactAddress", `bulk${String(i)}@example.com`));

    expect(await engine.sync(LANE)).toMatchObject({
      status: "applied",
      applied: MXROUTE_MAX_CHANGES_PER_ROUND,
      deferred: 5,
    });
    for (let waited = 0; fake.entries.size < 3 + total && waited < 1_000; waited += 10) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fake.entries.size).toBe(3 + total);
    engine.dispose();
    store.close();
  });

  it("does not retry a refused key, and reports it as such", async () => {
    const { fake, adapter } = setup();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, {
      debounceMs: 5,
      timeoutMs: 1_000,
      retry: { baseMs: 10, maxMs: 20 },
      random: () => 0,
    });
    engine.addAccount({ id: LANE, adapter, initialState: initialMxrouteState("example.com") });
    store.add(entry("exactAddress", "spam@example.com"));
    fake.forced.push(401);
    expect(await engine.sync(LANE)).toMatchObject({ status: "failed", code: "AUTH_REQUIRED" });
    const calls = fake.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.calls.length).toBe(calls);
    engine.dispose();
    store.close();
  });
});
