import { describe, expect, it } from "vitest";
import type { ApplyResult, OpaqueState, Plan } from "../../src/adapter.js";
import type { BlockEntry } from "../../src/blocklist.js";
import {
  GMAIL_CLEANUP_ENTRY_ID,
  GMAIL_MAX_REWRITES_PER_ROUND,
  GmailAdapter,
  gmailLaneId,
  gmailStateHoldsFilters,
  gmailUnsupported,
  initialGmailState,
} from "../../src/gmail/adapter.js";
import { createGmailClient } from "../../src/gmail/client.js";
import { GMAIL_ADDRESSES_PER_FILTER, compileFromQuery } from "../../src/gmail/query.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/store.js";
import { ACCOUNT_ID, SyncEngine } from "../../src/sync/engine.js";
import { unblock } from "../../src/notify/unblock.js";
import { FakeGmail, UNITS } from "./fake-gmail.js";

const LANE = "info@example.com.gmail";

let n = 0;
const entry = (
  value: string,
  action: BlockEntry["action"] = "trash",
  match: BlockEntry["match"] = "exactAddress",
): BlockEntry => ({
  id: crypto.randomUUID(),
  match,
  value,
  action,
  createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0, n++)).toISOString(),
});
const addrs = (count: number, prefix = "u"): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i)}@spam.example`);
const listOf = (values: string[]): BlockEntry[] => values.map((v) => entry(v));
const held = (value: string) => ({ id: crypto.randomUUID(), value });
const stateWith = (over: Record<string, unknown>): OpaqueState => ({
  adapterId: "gmail",
  data: { filters: [], stale: [], intent: [], refused: [], ...over },
});

interface Rec {
  id: string;
  entries: { value: string }[];
}
const recordsOf = (state: OpaqueState, key: "filters" | "stale" = "filters"): Rec[] =>
  (state.data as Record<"filters" | "stale", Rec[]>)[key];
const intentOf = (state: OpaqueState): unknown[] => (state.data as { intent: unknown[] }).intent;
const refusedOf = (state: OpaqueState): string[] =>
  (state.data as { refused: { value: string }[] }).refused.map((r) => r.value);
const valuesOf = (rec: Rec | undefined): string[] => rec?.entries.map((e) => e.value) ?? [];

const savedOf = new WeakMap<GmailAdapter, OpaqueState[]>();

function setup(
  over: {
    now?: () => number;
    checkpoint?: (state: OpaqueState) => void;
    sleep?: () => void;
    roundDeadlineMs?: number;
    uninstallDeadlineMs?: number;
  } = {},
) {
  const fake = new FakeGmail();
  const sleeps: number[] = [];
  const saved: OpaqueState[] = [];
  const client = createGmailClient({
    getAccessToken: () => Promise.resolve(fake.token),
    fetch: fake.fetch,
    timeoutMs: 500,
  });
  const adapter = new GmailAdapter({
    accountId: LANE,
    client,
    checkpoint: (state) => {
      saved.push(state);
      over.checkpoint?.(state);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      over.sleep?.();
      return Promise.resolve();
    },
    ...(over.now === undefined ? {} : { now: over.now }),
    ...(over.roundDeadlineMs === undefined ? {} : { roundDeadlineMs: over.roundDeadlineMs }),
    ...(over.uninstallDeadlineMs === undefined
      ? {}
      : { uninstallDeadlineMs: over.uninstallDeadlineMs }),
  });
  savedOf.set(adapter, saved);
  return { fake, adapter, sleeps, saved };
}

async function round(
  adapter: GmailAdapter,
  list: BlockEntry[],
  state: OpaqueState,
): Promise<{ plan: Plan; result: ApplyResult }> {
  const plan = await adapter.plan(list, state);
  const result = await adapter.apply(plan);
  // Nothing the adapter saves or returns may be a state it would refuse to read back.
  for (const snapshot of [...(savedOf.get(adapter) ?? []), result.state]) {
    await adapter.plan([], snapshot);
  }
  return { plan, result };
}

/** Rounds until the plan is empty: a backlog goes out a round at a time. */
async function settle(adapter: GmailAdapter, list: BlockEntry[], state: OpaqueState) {
  let current = state;
  for (let i = 0; i < 20; i += 1) {
    const { plan, result } = await round(adapter, list, current);
    if (plan.changes.length === 0) return current;
    current = result.state;
  }
  throw new Error("did not settle");
}

describe("gmailLaneId", () => {
  it("is a valid engine lane id next to the account's own, even for the longest account id", () => {
    for (const id of ["info@example.com", "a", "x".repeat(64)]) {
      const lane = gmailLaneId(id);
      expect(ACCOUNT_ID.test(lane)).toBe(true);
      expect(lane).not.toBe(id);
      expect(lane.endsWith(".gmail")).toBe(true);
    }
  });
});

describe("plan", () => {
  it("mirrors single addresses blocked with Trash that the query contract allows, and nothing else", async () => {
    const { adapter } = setup();
    const list = [
      entry("a@spam.example"),
      entry("b@spam.example", "junk"),
      entry("c@spam.example", "reject"),
      entry("spam.example", "trash", "exactDomain"),
      entry("bulk.example", "trash", "subdomains"),
      entry("-x@spam.example"),
      entry("a*b@spam.example"),
    ];
    const plan = await adapter.plan(list, initialGmailState());
    expect(plan.changes.map((c) => [c.kind, c.entry.value])).toEqual([
      ["create", "a@spam.example"],
    ]);
    expect(gmailUnsupported(list).map((e) => e.value)).toEqual([
      "-x@spam.example",
      "a*b@spam.example",
    ]);
  });

  it("declares exact addresses only", () => {
    const { adapter } = setup();
    expect(adapter.capabilities()).toMatchObject({
      serverBlock: true,
      exactAddress: true,
      exactDomain: false,
      subdomains: false,
    });
  });

  it("accepts a well-formed state (the control for the refusals below)", async () => {
    const { adapter } = setup();
    const state = stateWith({ filters: [{ id: "f1", entries: [held("a@spam.example")] }] });
    await expect(adapter.plan([entry("a@spam.example")], state)).resolves.toMatchObject({
      changes: [],
    });
  });

  it.each([
    [
      "another adapter's state",
      { adapterId: "mxroute", data: stateWith({}).data },
      "another adapter",
    ],
    ["an unknown key", stateWith({ extra: 1 }), "validation"],
    ["a missing key", { adapterId: "gmail", data: { filters: [], stale: [] } }, "validation"],
    [
      "an address the query contract refuses",
      stateWith({ filters: [{ id: "f1", entries: [held("-x@spam.example")] }] }),
      "validation",
    ],
    [
      "the same address in two filters",
      stateWith({
        filters: [
          { id: "f1", entries: [held("a@spam.example")] },
          { id: "f2", entries: [held("a@spam.example")] },
        ],
      }),
      "validation",
    ],
    [
      "a filter id used twice",
      stateWith({
        filters: [{ id: "f1", entries: [held("a@spam.example")] }],
        stale: [{ id: "f1", entries: [held("b@spam.example")] }],
      }),
      "validation",
    ],
    [
      "an entry that is not an id and an address",
      stateWith({ filters: [{ id: "f1", entries: [{ value: "a@spam.example" }] }] }),
      "validation",
    ],
  ])("refuses %s", async (_name, state, why) => {
    const { adapter } = setup();
    await expect(adapter.plan([], state)).rejects.toThrow(why);
  });

  it("keeps about 75 bytes of state per block, not a whole entry", async () => {
    const { adapter } = setup();
    const { result } = await round(adapter, listOf(addrs(500)), initialGmailState());
    const state = await settle(adapter, listOf(addrs(500)), result.state);
    expect(JSON.stringify(state.data).length / 500).toBeLessThan(110);
  });
});

describe("apply", () => {
  it("writes one filter for a few addresses: one list, one create, no delete", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const { result } = await round(adapter, list, initialGmailState());
    expect(result).toMatchObject({ applied: 3, failed: [] });
    expect(fake.filters.size).toBe(1);
    const [only] = [...fake.filters.values()];
    expect(only?.criteria).toEqual({ query: compileFromQuery(addrs(3)) });
    expect(only?.action).toEqual({ addLabelIds: ["TRASH"] });
    expect(fake.units).toBe(UNITS.list + UNITS.create);
    expect(valuesOf(recordsOf(result.state)[0])).toEqual(addrs(3));
    expect(recordsOf(result.state)[0]?.id).toBe(only?.id);
    expect(intentOf(result.state)).toEqual([]);
  });

  it("an added address is one create and one delete, and never touches a filter that is not ours", async () => {
    const { fake, adapter } = setup();
    const foreign = fake.addForeign({ from: "boss@work.example" }, { forward: "x@y.example" });
    const first = await round(adapter, listOf(addrs(3)), initialGmailState());
    const oldId = recordsOf(first.result.state)[0]?.id;
    fake.calls.length = 0;
    fake.units = 0;
    const second = await round(adapter, listOf(addrs(4)), first.result.state);
    expect(second.result.applied).toBe(1);
    expect(fake.filters.size).toBe(2);
    expect(fake.filters.get(foreign)).toEqual({
      id: foreign,
      criteria: { from: "boss@work.example" },
      action: { forward: "x@y.example" },
    });
    expect(fake.filters.has(oldId ?? "")).toBe(false);
    expect(fake.units).toBe(UNITS.list + UNITS.create + UNITS.delete);
    const deletes = fake.callsTo("DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url.endsWith(`/${oldId ?? ""}`)).toBe(true);
    expect(fake.callsTo("POST")).toHaveLength(1);
  });

  it("ten added addresses to one filter are still one create and one delete", async () => {
    const { fake, adapter } = setup();
    const first = await round(adapter, listOf(addrs(3)), initialGmailState());
    fake.calls.length = 0;
    await round(adapter, listOf(addrs(13)), first.result.state);
    expect(fake.callsTo("POST")).toHaveLength(1);
    expect(fake.callsTo("DELETE")).toHaveLength(1);
  });

  it("append-only: addresses never move between filters, and one added address rewrites one filter", async () => {
    const { fake, adapter } = setup();
    let state = (await round(adapter, listOf(addrs(120)), initialGmailState())).result.state;
    expect(recordsOf(state).map((r) => r.entries.length)).toEqual([
      GMAIL_ADDRESSES_PER_FILTER,
      GMAIL_ADDRESSES_PER_FILTER,
      20,
    ]);
    const [idA, idB, idC] = recordsOf(state).map((r) => r.id);

    fake.calls.length = 0;
    state = (await round(adapter, listOf(addrs(121)), state)).result.state;
    expect(recordsOf(state).map((r) => r.id)).toEqual([
      idA,
      idB,
      expect.not.stringMatching(idC ?? "") as string,
    ]);
    expect(fake.callsTo("POST")).toHaveLength(1);
    expect(fake.callsTo("DELETE")).toHaveLength(1);

    state = (await round(adapter, listOf(addrs(152)), state)).result.state;
    const after = recordsOf(state);
    expect(after.map((r) => r.entries.length)).toEqual([50, 50, 50, 2]);
    expect(after[0]?.id).toBe(idA);
    expect(after[1]?.id).toBe(idB);
    expect(valuesOf(after[0])).toEqual(addrs(120).slice(0, 50));
    expect(valuesOf(after[1])).toEqual(addrs(120).slice(50, 100));
    expect(fake.filters.size).toBe(4);
  });

  it("a backlog goes out a round at a time: at most the capped number of filters per round, the rest deferred", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(600));
    const plan = await adapter.plan(list, initialGmailState());
    expect(plan.changes).toHaveLength(GMAIL_MAX_REWRITES_PER_ROUND * GMAIL_ADDRESSES_PER_FILTER);
    expect(plan.deferred).toBe(100);
    const result = await adapter.apply(plan);
    expect(result.applied).toBe(500);
    expect(fake.filters.size).toBe(10);
    const state = await settle(adapter, list, result.state);
    expect(recordsOf(state)).toHaveLength(12);
    expect(fake.filters.size).toBe(12);
  });

  it("an Unblock rewrites the filter without the address, and the last address deletes the filter without a create", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    let state = (await round(adapter, list, initialGmailState())).result.state;
    fake.calls.length = 0;
    const second = await round(adapter, [list[0] as BlockEntry, list[2] as BlockEntry], state);
    state = second.result.state;
    expect(second.result.applied).toBe(1);
    expect(valuesOf(recordsOf(state)[0])).toEqual([addrs(3)[0], addrs(3)[2]]);
    expect([...fake.filters.values()][0]?.criteria).toEqual({
      query: compileFromQuery([addrs(3)[0] as string, addrs(3)[2] as string]),
    });

    fake.calls.length = 0;
    const last = await round(adapter, [], state);
    expect(last.result.applied).toBe(2);
    expect(fake.callsTo("POST")).toHaveLength(0);
    expect(fake.filters.size).toBe(0);
    expect(recordsOf(last.result.state)).toEqual([]);
  });

  it("never writes an address that is already in a filter, whatever the plan says", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const first = await round(adapter, list, initialGmailState());
    // A plan made from an older state, applied after the state moved on.
    const old = await adapter.plan(list, initialGmailState());
    fake.calls.length = 0;
    const result = await adapter.apply({ ...old, basedOn: first.result.state });
    expect(result.applied).toBe(0);
    expect(fake.callsTo("POST")).toHaveLength(0);
    expect(fake.callsTo("DELETE")).toHaveLength(0);
    expect(valuesOf(recordsOf(result.state)[0])).toEqual(addrs(3));
  });

  it("removals are rewritten before additions", async () => {
    const { fake, adapter } = setup();
    // Filter A is full, filter B holds 5.
    const a = addrs(50, "a");
    const b = addrs(5, "b");
    const state = (await round(adapter, listOf([...a, ...b]), initialGmailState())).result.state;
    const [idA, idB] = recordsOf(state).map((r) => r.id);
    fake.calls.length = 0;
    // Take one address off A, put two new ones on: the first fills A's free place, the second goes to B.
    const next = listOf([...a.slice(1), ...b, "n1@spam.example", "n2@spam.example"]);
    await round(adapter, next, state);
    const deletes = fake.callsTo("DELETE").map((c) => c.url);
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.endsWith(`/${idA ?? ""}`)).toBe(true);
    expect(deletes[1]?.endsWith(`/${idB ?? ""}`)).toBe(true);
  });

  it("only deletes filters whose id it recorded, an identical one of the person's included", async () => {
    const { fake, adapter } = setup();
    const first = await round(adapter, listOf(addrs(3)), initialGmailState());
    // The person's own filter, written after ours, with the same content as a rewrite will have.
    await round(adapter, [], first.result.state);
    const mine = fake.addForeign(
      { query: compileFromQuery(["z@spam.example"]) },
      { addLabelIds: ["TRASH"] },
    );
    const second = await round(adapter, listOf(["z@spam.example"]), initialGmailState());
    expect(second.result.failed.map((f) => f.error.code)).toEqual(["REMOTE_CHANGED"]);
    await round(adapter, [], second.result.state);
    expect(fake.filters.has(mine)).toBe(true);
    for (const call of fake.callsTo("DELETE")) expect(call.url.endsWith(`/${mine}`)).toBe(false);
  });
});

describe("failures", () => {
  it("a delete that fails after the new filter was created keeps the new one and deletes the old one next round", async () => {
    const { fake, adapter, sleeps } = setup();
    const first = await round(adapter, listOf(addrs(3)), initialGmailState());
    const oldId = recordsOf(first.result.state)[0]?.id;
    fake.forcedFor.set("DELETE", [503, 503, 503]);
    const second = await round(adapter, listOf(addrs(4)), first.result.state);
    expect(second.result).toMatchObject({ applied: 1, failed: [] });
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(recordsOf(second.result.state)).toHaveLength(1);
    expect(valuesOf(recordsOf(second.result.state)[0])).toEqual(addrs(4));
    expect(recordsOf(second.result.state, "stale").map((r) => r.id)).toEqual([oldId]);
    expect(fake.filters.size).toBe(2);

    // Nothing else is planned, but a round must still run to delete the stale one.
    const plan = await adapter.plan(listOf(addrs(4)), second.result.state);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.entry.id).toBe(GMAIL_CLEANUP_ENTRY_ID);
    expect(plan.changes[0]?.entry.value).toBe("cleanup@senderban.invalid");
    const third = await adapter.apply(plan);
    expect(recordsOf(third.state, "stale")).toEqual([]);
    expect(fake.filters.size).toBe(1);
    expect((await adapter.plan(listOf(addrs(4)), third.state)).changes).toEqual([]);
  });

  it("an Unblock whose old filter cannot be deleted yet is reported, not claimed done", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const first = await round(adapter, list, initialGmailState());
    fake.forcedFor.set("DELETE", [500, 500, 500]);
    const second = await round(adapter, list.slice(0, 2), first.result.state);
    expect(second.result.applied).toBe(0);
    expect(second.result.failed).toHaveLength(1);
    expect(second.result.failed[0]?.error.code).toBe("TRANSIENT");
    expect(second.result.failed[0]?.entryId).toBe(list[2]?.id);
  });

  it("a create whose answer was lost is found by reading the list: no duplicate, no second create", async () => {
    const { fake, adapter, sleeps } = setup();
    fake.createThenFail = [503];
    const { result } = await round(adapter, listOf(addrs(3)), initialGmailState());
    expect(result).toMatchObject({ applied: 3, failed: [] });
    expect(fake.filters.size).toBe(1);
    expect(fake.callsTo("POST")).toHaveLength(1);
    expect(sleeps).toEqual([1_000]);
    expect(recordsOf(result.state)[0]?.id).toBe([...fake.filters.keys()][0]);
  });

  it("an answer lost on the LAST attempt is found too", async () => {
    const { fake, adapter, sleeps } = setup();
    fake.forcedFor.set("POST", [503, 503, "pass"]);
    fake.createThenFail = [503];
    const { result } = await round(adapter, listOf(addrs(3)), initialGmailState());
    expect(result).toMatchObject({ applied: 3, failed: [] });
    expect(fake.filters.size).toBe(1);
    expect(fake.callsTo("POST")).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(recordsOf(result.state)[0]?.id).toBe([...fake.filters.keys()][0]);
  });

  it("a create that keeps answering 5xx is tried three times, then fails the round with the filter list unchanged", async () => {
    const { fake, adapter, sleeps } = setup();
    fake.forcedFor.set("POST", [503, 503, 503]);
    const plan = await adapter.plan(listOf(addrs(3)), initialGmailState());
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(fake.callsTo("POST")).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(fake.filters.size).toBe(0);
  });

  it("a filter written between the round's list and its create is adopted, not reported as the person's", async () => {
    const { fake, adapter } = setup();
    let written = "";
    fake.beforeCreate = () => {
      fake.beforeCreate = null;
      written = fake.addForeign({ query: compileFromQuery(addrs(2)) }, { addLabelIds: ["TRASH"] });
    };
    const { result } = await round(adapter, listOf(addrs(2)), initialGmailState());
    expect(result).toMatchObject({ applied: 2, failed: [] });
    expect(recordsOf(result.state)[0]?.id).toBe(written);
    expect(fake.filters.size).toBe(1);
  });

  it("an identical filter the person had is never adopted, edited or deleted, and does not hold the backlog back", async () => {
    const { fake, adapter } = setup();
    const foreign = fake.addForeign(
      { query: compileFromQuery(addrs(2)) },
      { addLabelIds: ["TRASH"] },
    );
    const list = listOf(addrs(2));
    const { result } = await round(adapter, list, initialGmailState());
    // Decided from the first list, before anything is saved or sent: no create, so no intent that could adopt it later.
    expect(fake.callsTo("POST")).toHaveLength(0);
    expect(savedOf.get(adapter)?.every((s) => intentOf(s).length === 0)).toBe(true);
    expect((result.state.data as { refused: { by: string }[] }).refused.map((r) => r.by)).toEqual([
      foreign,
      foreign,
    ]);
    expect(result.applied).toBe(0);
    expect(result.failed.map((f) => [f.entryId, f.error.code])).toEqual(
      list.map((e) => [e.id, "REMOTE_CHANGED"]),
    );
    expect(recordsOf(result.state)).toEqual([]);
    expect(refusedOf(result.state)).toEqual(addrs(2));
    expect(fake.filters.has(foreign)).toBe(true);
    expect(fake.callsTo("DELETE")).toHaveLength(0);
    // Those addresses are covered, so the next plan has nothing to do for them and the rest of a backlog goes ahead.
    const again = await adapter.plan(list, result.state);
    expect(again.changes.map((c) => c.entry.id)).toEqual([GMAIL_CLEANUP_ENTRY_ID]);
    const more = [...list, ...listOf(addrs(3, "later"))];
    const next = await round(adapter, more, result.state);
    expect(next.result).toMatchObject({ applied: 3, failed: [] });
  });

  it.each([
    ["other content", (q: string) => ({ query: q.replace("u0@", "zz@") })],
    ["an extra key the person added", (q: string) => ({ query: q, hasAttachment: true })],
  ])(
    "a filter of ours that now has %s is forgotten: never edited or deleted, and put back in a new filter",
    async (_n, mutate) => {
      const { fake, adapter } = setup();
      const list = listOf(addrs(3));
      const first = await round(adapter, list, initialGmailState());
      const record = recordsOf(first.result.state)[0] as Rec;
      const changed = fake.filters.get(record.id);
      if (changed === undefined) throw new Error("missing");
      changed.criteria = mutate(compileFromQuery(addrs(3)));
      const before = JSON.stringify(changed);
      fake.calls.length = 0;
      const second = await round(adapter, list.slice(1), first.result.state);
      expect(second.result.failed).toEqual([]);
      expect(second.result.deferred).toBe(3);
      expect(recordsOf(second.result.state)).toEqual([]);
      expect(fake.callsTo("POST")).toHaveLength(0);
      expect(fake.callsTo("DELETE")).toHaveLength(0);

      const state = await settle(adapter, list.slice(1), second.result.state);
      expect(valuesOf(recordsOf(state)[0])).toEqual(addrs(3).slice(1));
      expect(JSON.stringify(fake.filters.get(record.id))).toBe(before);
      expect(fake.filters.size).toBe(2);
    },
  );

  it("a filter someone deleted in Gmail is put back by the follow-up round, with everything the plan knows", async () => {
    const { fake, adapter } = setup();
    const first = await round(adapter, listOf(addrs(3)), initialGmailState());
    fake.filters.clear();
    const list = listOf([...addrs(3), "new@spam.example"]);
    const second = await round(adapter, list, first.result.state);
    expect(second.result.failed).toEqual([]);
    expect(second.result.deferred).toBe(3);
    expect(valuesOf(recordsOf(second.result.state)[0])).toEqual(["new@spam.example"]);
    const state = await settle(adapter, list, second.result.state);
    expect(
      recordsOf(state)
        .flatMap((r) => valuesOf(r))
        .sort(),
    ).toEqual([...addrs(3), "new@spam.example"].sort());
  });

  it("a lost filter whose Unblock is waiting is not put back", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const first = await round(adapter, list, initialGmailState());
    fake.filters.clear();
    const second = await round(adapter, list.slice(0, 2), first.result.state);
    const state = await settle(adapter, list.slice(0, 2), second.result.state);
    expect(
      recordsOf(state)
        .flatMap((r) => valuesOf(r))
        .sort(),
    ).toEqual(addrs(3).slice(0, 2).sort());
  });

  it("Google asking to slow down mid-round reports the rest as failed (TRANSIENT), so the engine backs off", async () => {
    const { fake, adapter } = setup();
    fake.forcedFor.set("POST", ["pass", 429]);
    const list = listOf(addrs(150));
    const { result } = await round(adapter, list, initialGmailState());
    expect(result.applied).toBe(50);
    expect(result.failed).toHaveLength(100);
    expect(result.failed.every((f) => f.error.code === "TRANSIENT")).toBe(true);
    expect(result.deferred).toBeUndefined();
    expect(recordsOf(result.state)).toHaveLength(1);
  });

  it("a rate limit before anything is written fails every change of the plan (TRANSIENT) instead of throwing a permanent error", async () => {
    const { fake, adapter } = setup();
    const plan = await adapter.plan(listOf(addrs(3)), initialGmailState());
    fake.forcedFor.set("GET", [429]);
    const before = await adapter.apply(plan);
    expect(before.applied).toBe(0);
    expect(before.failed.map((f) => f.error.code)).toEqual(["TRANSIENT", "TRANSIENT", "TRANSIENT"]);
    expect(fake.callsTo("POST")).toHaveLength(0);

    fake.forcedFor.set("POST", [429]);
    const first = await adapter.apply(plan);
    expect(first.applied).toBe(0);
    expect(first.failed).toHaveLength(3);
    // The create itself was refused, but the intent stays: the next round settles it either way.
    expect(intentOf(first.state)).toHaveLength(1);

    fake.forcedFor.set("GET", [401]);
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("stops starting new filters once the round's time is used up, and defers the rest", async () => {
    let t = 0;
    const { adapter } = setup({ now: () => (t += 25_000) });
    const { result } = await round(adapter, listOf(addrs(150)), initialGmailState());
    expect(result.applied).toBe(50);
    expect(result.deferred).toBe(100);
    expect(result.failed).toEqual([]);
  });

  it("a signal that is already aborted sends no write", async () => {
    const { fake, adapter } = setup();
    const plan = await adapter.plan(listOf(addrs(3)), initialGmailState());
    await expect(adapter.apply(plan, AbortSignal.abort())).rejects.toMatchObject({
      code: "TRANSIENT",
    });
    expect(fake.callsTo("POST")).toHaveLength(0);
    expect(fake.filters.size).toBe(0);
  });
});

describe("a round that dies in the middle (the engine drops it at 60 s)", () => {
  it("saves the intent before the create, so the filter Gmail made is taken in by the next round", async () => {
    const saved: OpaqueState[] = [];
    const abort = new AbortController();
    const { fake, adapter } = setup({
      checkpoint: (s) => {
        saved.push(s);
      },
      // The engine gives up while the adapter waits to retry a create whose answer was lost.
      sleep: () => {
        abort.abort(new Error("engine timeout"));
      },
    });
    fake.createThenFail = [503];
    const list = listOf(addrs(3));
    const plan = await adapter.plan(list, initialGmailState());
    await expect(adapter.apply(plan, abort.signal)).rejects.toThrow();
    expect(fake.filters.size).toBe(1);

    // What the app has is the last thing saved, not what `apply` would have returned.
    const last = saved.at(-1) as OpaqueState;
    expect(intentOf(last)).toHaveLength(1);
    expect(recordsOf(last)).toEqual([]);

    const resumed = await adapter.plan(list, last);
    expect(resumed.changes).toHaveLength(1);
    expect(resumed.changes[0]?.entry.id).toBe(GMAIL_CLEANUP_ENTRY_ID);
    fake.calls.length = 0;
    const result = await adapter.apply(resumed);
    expect(result.failed).toEqual([]);
    expect(fake.callsTo("POST")).toHaveLength(0);
    expect(fake.filters.size).toBe(1);
    expect(intentOf(result.state)).toEqual([]);
    expect(valuesOf(recordsOf(result.state)[0])).toEqual(addrs(3));
    expect(recordsOf(result.state)[0]?.id).toBe([...fake.filters.keys()][0]);
    expect((await adapter.plan(list, result.state)).changes).toEqual([]);
  });

  it("an intent whose create never landed is dropped with a follow-up, and the next round writes the filter", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(2));
    const state = stateWith({ intent: [{ entries: addrs(2).map(held), replaces: null }] });
    const plan = await adapter.plan(list, state);
    // The addresses of an unconfirmed create are not added a second time while it is unsettled.
    expect(plan.changes.map((c) => c.entry.id)).toEqual([GMAIL_CLEANUP_ENTRY_ID]);
    const result = await adapter.apply(plan);
    expect(intentOf(result.state)).toEqual([]);
    expect(result.deferred).toBe(2);
    expect(fake.filters.size).toBe(0);
    const settled = await settle(adapter, list, result.state);
    expect(fake.filters.size).toBe(1);
    expect(recordsOf(settled).flatMap((r) => valuesOf(r))).toEqual(addrs(2));
  });

  it("an intent for a rewrite takes the new filter in and leaves the old one to be deleted", async () => {
    const { fake, adapter } = setup();
    const first = await round(adapter, listOf(addrs(3)), initialGmailState());
    const old = recordsOf(first.result.state)[0] as Rec;
    // A round that created the 4-address version and died before it saved anything else.
    const made = fake.addForeign({ query: compileFromQuery(addrs(4)) }, { addLabelIds: ["TRASH"] });
    const entries = [
      ...(old.entries as { id: string; value: string }[]),
      held(addrs(4)[3] as string),
    ];
    const state = stateWith({
      filters: [{ id: old.id, entries: old.entries }],
      intent: [{ entries, replaces: old.id }],
    });
    const result = await adapter.apply(await adapter.plan(listOf(addrs(4)), state));
    expect(result.failed).toEqual([]);
    expect(recordsOf(result.state).map((r) => r.id)).toEqual([made]);
    expect(recordsOf(result.state, "stale")).toEqual([]);
    expect(fake.filters.has(old.id)).toBe(false);
    expect(fake.filters.has(made)).toBe(true);
  });

  it("verify does not call it verified while a write is unconfirmed", async () => {
    const { adapter } = setup();
    const drift = await adapter.verify(
      stateWith({ intent: [{ entries: [held("a@spam.example")], replaces: null }] }),
    );
    expect(drift.drifted).toBe(true);
    expect(drift.checks.find((c) => c.name === "pending-writes")?.ok).toBe(false);
  });
});

describe("what the second review found", () => {
  it("a recovery read that is rate limited after a lost create keeps the intent, and the next round takes the filter in", async () => {
    const { fake, adapter } = setup();
    fake.createThenFail = [503];
    fake.forcedFor.set("GET", ["pass", 429]);
    const list = listOf(addrs(3));
    const first = await round(adapter, list, initialGmailState());
    expect(first.result.applied).toBe(0);
    expect(intentOf(first.result.state)).toHaveLength(1);
    expect(fake.filters.size).toBe(1);

    const second = await round(adapter, list, first.result.state);
    expect(second.result.failed).toEqual([]);
    expect(refusedOf(second.result.state)).toEqual([]);
    expect(recordsOf(second.result.state)[0]?.id).toBe([...fake.filters.keys()][0]);
    const settled = await settle(adapter, list, second.result.state);
    expect(fake.filters.size).toBe(1);
    expect(valuesOf(recordsOf(settled)[0])).toEqual(addrs(3));
  });

  it("a recovery read that answers 401 keeps the intent too", async () => {
    const { fake, adapter, saved } = setup();
    fake.createThenFail = [503];
    fake.forcedFor.set("GET", ["pass", 401]);
    const list = listOf(addrs(3));
    const plan = await adapter.plan(list, initialGmailState());
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const last = saved.at(-1) as OpaqueState;
    expect(intentOf(last)).toHaveLength(1);
    const resumed = await round(adapter, list, last);
    expect(resumed.result.failed).toEqual([]);
    expect(recordsOf(resumed.result.state)[0]?.id).toBe([...fake.filters.keys()][0]);
  });

  it("an Unblock that meets a rate limit is not confirmed, and the filter goes on the next try", async () => {
    const { fake, adapter } = setup();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 1_000 });
    engine.addAccount({ id: LANE, adapter, initialState: initialGmailState() });
    const added = store.add(entry("spam@example.com"));
    if (!added.ok) throw new Error("add failed");
    await engine.sync(LANE);
    expect(fake.filters.size).toBe(1);

    fake.forcedFor.set("GET", [429]);
    const first = await unblock({ store, engine, accountIds: [LANE] }, added.entry.id);
    expect(first).toMatchObject({ status: "unblocked", accounts: [{ confirmed: false }] });
    expect(fake.filters.size).toBe(1);
    expect(await engine.sync(LANE)).toMatchObject({ status: "applied" });
    expect(fake.filters.size).toBe(0);
    engine.dispose();
    store.close();
  });

  it("a filter taken in from an intent is compared with the list again, so an Unblock that came meanwhile is not lost", async () => {
    const { fake, adapter } = setup();
    // The create of a, b, c landed in a round that died; then the person unblocked a.
    fake.addForeign({ query: compileFromQuery(addrs(3)) }, { addLabelIds: ["TRASH"] });
    const state = stateWith({ intent: [{ entries: addrs(3).map(held), replaces: null }] });
    const list = listOf(addrs(3).slice(1));
    const { result } = await round(adapter, list, state);
    expect(valuesOf(recordsOf(result.state)[0])).toEqual(addrs(3));
    expect(result.deferred).toBeGreaterThan(0);
    const settled = await settle(adapter, list, result.state);
    expect(valuesOf(recordsOf(settled)[0])).toEqual(addrs(3).slice(1));
    expect(fake.filters.size).toBe(1);
    expect([...fake.filters.values()][0]?.criteria).toEqual({
      query: compileFromQuery(addrs(3).slice(1)),
    });
  });

  it("'exists' with nothing new in the list is not decided either way: the round fails and the intent stays", async () => {
    const { fake, adapter, saved } = setup();
    fake.forcedFor.set("POST", [
      {
        status: 400,
        body: {
          error: { message: "Filter already exists", errors: [{ reason: "failedPrecondition" }] },
        },
      },
    ]);
    const plan = await adapter.plan(listOf(addrs(2)), initialGmailState());
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    const last = saved.at(-1) as OpaqueState;
    expect(intentOf(last)).toHaveLength(1);
    expect(refusedOf(last)).toEqual([]);
  });

  it("a refusal ends with the filter behind it: the address is put back by the next rounds", async () => {
    const { fake, adapter } = setup();
    const foreign = fake.addForeign(
      { query: compileFromQuery(addrs(2)) },
      { addLabelIds: ["TRASH"] },
    );
    const list = listOf(addrs(2));
    const first = await round(adapter, list, initialGmailState());
    expect(refusedOf(first.result.state)).toEqual(addrs(2));

    // While the person's filter is there, a round only looks (one list) and keeps the refusal.
    const same = await round(adapter, list, first.result.state);
    expect(same.plan.changes.map((c) => c.entry.id)).toEqual([GMAIL_CLEANUP_ENTRY_ID]);
    expect(same.result.deferred).toBeUndefined();
    expect(refusedOf(same.result.state)).toEqual(addrs(2));

    fake.filters.delete(foreign);
    const gone = await round(adapter, list, same.result.state);
    expect(refusedOf(gone.result.state)).toEqual([]);
    expect(gone.result.deferred).toBe(2);
    const settled = await settle(adapter, list, gone.result.state);
    expect(valuesOf(recordsOf(settled)[0])).toEqual(addrs(2));
    expect(fake.filters.size).toBe(1);
  });

  it("verify reports an address whose covering filter is gone", async () => {
    const { adapter } = setup();
    const drift = await adapter.verify(
      stateWith({ refused: [{ value: "a@spam.example", by: "gone-filter" }] }),
    );
    expect(drift.drifted).toBe(true);
    expect(drift.checks.find((c) => c.name === "refused-addresses")?.ok).toBe(false);
  });

  it("a create is never sent when the intent cannot be saved first", async () => {
    const { fake, adapter } = setup({
      checkpoint: () => {
        throw new Error("disk full");
      },
    });
    const plan = await adapter.plan(listOf(addrs(2)), initialGmailState());
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(fake.callsTo("POST")).toHaveLength(0);
    expect(fake.filters.size).toBe(0);
  });

  it("a stale filter Gmail refuses to delete does not hold up the other writes, and the Unblocks that depend on it are reported", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const first = await round(adapter, list, initialGmailState());
    fake.forcedFor.set("DELETE", [503, 503, 503]);
    const second = await round(adapter, [...list, entry("n@spam.example")], first.result.state);
    expect(recordsOf(second.result.state, "stale")).toHaveLength(1);

    fake.forcedFor.set("DELETE", [400]);
    const next = [...list.slice(1), entry("n@spam.example"), entry("m@spam.example")];
    const third = await round(adapter, next, second.result.state);
    expect(third.result.failed.map((f) => [f.entryId, f.error.code])).toEqual([
      [list[0]?.id, "TRANSIENT"],
    ]);
    expect(third.result.applied).toBeGreaterThan(0);
    expect(recordsOf(third.result.state, "stale")).toHaveLength(1);
    expect(
      recordsOf(third.result.state)
        .flatMap((r) => valuesOf(r))
        .sort(),
    ).toEqual([...addrs(3).slice(1), "m@spam.example", "n@spam.example"].sort());
  });

  it("a round that outlives its deadline is cut off, the next one starts from what was saved", async () => {
    const { fake, adapter } = setup({ roundDeadlineMs: 40 });
    fake.holdFromCall = 1; // the first list answers, every later call hangs
    const plan = await adapter.plan(listOf(addrs(3)), initialGmailState());
    const began = Date.now();
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    // The client's own limit is 500 ms: only the round's 40 ms can end it this fast.
    expect(Date.now() - began).toBeLessThan(300);
    expect(fake.filters.size).toBe(0);
  });

  it("uninstall stops at its own deadline and returns what it did not delete", async () => {
    const { fake, adapter } = setup({ uninstallDeadlineMs: 40 });
    const state = (await round(adapter, listOf(addrs(120)), initialGmailState())).result.state;
    expect(recordsOf(state)).toHaveLength(3);
    fake.holdFromCall = fake.calls.length + 1; // the list answers, every delete hangs
    const began = Date.now();
    const left = await adapter.uninstall(state);
    expect(Date.now() - began).toBeLessThan(300);
    expect(recordsOf(left)).toHaveLength(3);
    expect(fake.filters.size).toBe(3);
  });
});

describe("verify and uninstall", () => {
  it("reads every filter back and says when one is missing, changed, or still to delete", async () => {
    const { fake, adapter } = setup();
    expect((await adapter.verify(initialGmailState())).drifted).toBe(false);
    const state = (await round(adapter, listOf(addrs(120)), initialGmailState())).result.state;
    const clean = await adapter.verify(state);
    expect(clean).toMatchObject({ drifted: false, detail: "Gmail filters in place" });
    expect(clean.checks[0]?.detail).toBe("3 of 3 exactly as written");

    const [a, b] = recordsOf(state);
    fake.filters.delete(a?.id ?? "");
    const remote = fake.filters.get(b?.id ?? "");
    if (remote !== undefined) remote.action = { addLabelIds: ["TRASH", "STARRED"] };
    const drift = await adapter.verify(state);
    expect(drift.drifted).toBe(true);
    expect(drift.detail).toBe(
      "1 missing, 1 changed, 0 left to delete, 0 writes not confirmed, 0 addresses no longer covered",
    );
  });

  it("uninstall deletes only what still reads as written and leaves everything else alone", async () => {
    const { fake, adapter } = setup();
    const foreign = fake.addForeign({ from: "boss@work.example" }, {});
    const state = (await round(adapter, listOf(addrs(120)), initialGmailState())).result.state;
    const [a, b] = recordsOf(state);
    const changed = fake.filters.get(b?.id ?? "");
    if (changed !== undefined) changed.criteria = { query: "from:(me)" };
    const left = await adapter.uninstall(state);
    expect(recordsOf(left)).toEqual([]);
    expect(fake.filters.has(a?.id ?? "")).toBe(false);
    expect(fake.filters.has(b?.id ?? "")).toBe(true);
    expect(fake.filters.has(foreign)).toBe(true);
  });

  it("uninstall also removes a filter whose create was never confirmed", async () => {
    const { fake, adapter } = setup();
    const made = fake.addForeign({ query: compileFromQuery(addrs(2)) }, { addLabelIds: ["TRASH"] });
    const left = await adapter.uninstall(
      stateWith({ intent: [{ entries: addrs(2).map(held), replaces: null }] }),
    );
    expect(recordsOf(left)).toEqual([]);
    expect(fake.filters.has(made)).toBe(false);
  });

  it("uninstall returns what it could not delete, so the caller does not forget the account yet", async () => {
    const { fake, adapter } = setup();
    const state = (await round(adapter, listOf(addrs(3)), initialGmailState())).result.state;
    fake.forcedFor.set("DELETE", [500, 500, 500]);
    const left = await adapter.uninstall(state);
    expect(recordsOf(left)).toHaveLength(1);
    expect(fake.filters.size).toBe(1);
    expect(recordsOf(await adapter.uninstall(left))).toEqual([]);
    expect(fake.filters.size).toBe(0);
  });
});

describe("Gmail lane inside the real engine", () => {
  it("blocks an address, reads it back, and unblock removes it again", async () => {
    const { fake, adapter } = setup();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 1_000 });
    engine.addAccount({ id: LANE, adapter, initialState: initialGmailState() });

    const added = store.add(entry("spam@example.com"));
    if (!added.ok) throw new Error("add failed");
    store.add(entry("bulk.example", "trash", "subdomains"));
    expect(await engine.sync(LANE)).toMatchObject({ status: "applied", applied: 1 });
    expect(fake.filters.size).toBe(1);
    expect(await engine.verify(LANE)).toEqual({ accountId: LANE, status: "verified" });
    expect(await engine.sync(LANE)).toMatchObject({ status: "unchanged" });

    const result = await unblock({ store, engine, accountIds: [LANE] }, added.entry.id);
    expect(result).toMatchObject({ status: "unblocked", accounts: [{ confirmed: true }] });
    expect(fake.filters.size).toBe(0);
    engine.dispose();
    store.close();
  });

  it("a delete that failed is finished by a later sync, though nothing new was blocked", async () => {
    const { fake, adapter } = setup();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 1_000 });
    engine.addAccount({ id: LANE, adapter, initialState: initialGmailState() });
    store.add(entry("a@spam.example"));
    await engine.sync(LANE);
    fake.forcedFor.set("DELETE", [503, 503, 503]);
    store.add(entry("b@spam.example"));
    await engine.sync(LANE);
    expect(fake.filters.size).toBe(2);
    expect(await engine.sync(LANE)).toMatchObject({ status: "applied" });
    expect(fake.filters.size).toBe(1);
    expect(await engine.sync(LANE)).toMatchObject({ status: "unchanged" });
    engine.dispose();
    store.close();
  });

  it("with the checkpoint bound to the store, the state is saved step by step and ends where the round does", async () => {
    const store = new Store(openDatabase(":memory:"));
    const saves: number[] = [];
    const { fake, adapter } = setup({
      checkpoint: (s) => {
        saves.push(intentOf(s).length);
        store.setState(LANE, s);
      },
    });
    const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 1_000 });
    engine.addAccount({ id: LANE, adapter, initialState: initialGmailState() });
    store.add(entry("a@spam.example"));
    expect(await engine.sync(LANE)).toMatchObject({ status: "applied", applied: 1 });
    // Intent first (1 pending), then the filter recorded (0 pending).
    expect(saves).toEqual([1, 0]);
    const stored = store.getState(LANE);
    expect(stored === undefined ? [] : recordsOf(stored).map((r) => r.id)).toEqual([
      [...fake.filters.keys()][0],
    ]);
    engine.dispose();
    store.close();
  });
});

describe("suspend: the removal of an account must not race a round", () => {
  it("while suspended plan and apply answer TRANSIENT, never 'nothing to do', and nothing is sent; resume ends it", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const wanted = await adapter.plan(list, initialGmailState());
    expect(wanted.changes).toHaveLength(3);
    expect(await adapter.suspend()).toBe(true);
    // The engine reads an empty plan as a clean round (an Unblock would be shown as confirmed): a pause is a failure.
    await expect(adapter.plan(list, initialGmailState())).rejects.toMatchObject({
      code: "TRANSIENT",
    });
    await expect(adapter.apply(wanted)).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(fake.calls).toHaveLength(0);
    adapter.resume();
    expect((await adapter.apply(wanted)).applied).toBe(3);
  });

  it("waits for the round that is running, and no write starts after it", async () => {
    const { fake, adapter } = setup();
    const plan = await adapter.plan(listOf(addrs(3)), initialGmailState());
    let release: () => void = () => undefined;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = adapter.apply(plan);
    let suspended: boolean | null = null;
    const waiting = adapter.suspend().then((idle) => {
      suspended = idle;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(suspended).toBeNull();
    release();
    await running;
    await waiting;
    expect(suspended).toBe(true);
    const before = fake.calls.length;
    await expect(adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(fake.calls).toHaveLength(before);
  });

  it("gives up waiting for a round that does not end, and says so", async () => {
    const { fake, adapter } = setup();
    const plan = await adapter.plan(listOf(addrs(3)), initialGmailState());
    let release: () => void = () => undefined;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = adapter.apply(plan);
    expect(await adapter.suspend(30)).toBe(false);
    release();
    await running;
  });

  it("uninstall still works while suspended, and leaves nothing for the next round to write over", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const placed = await round(adapter, list, initialGmailState());
    expect(fake.filters.size).toBe(1);
    await adapter.suspend();
    const left = await adapter.uninstall(placed.result.state);
    expect(gmailStateHoldsFilters(left)).toBe(false);
    expect(fake.filters.size).toBe(0);
    await expect(adapter.plan(list, left)).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("retire: a clean 'nothing to do' for good, and no write", async () => {
    const { fake, adapter } = setup();
    const list = listOf(addrs(3));
    const wanted = await adapter.plan(list, initialGmailState());
    adapter.retire();
    expect((await adapter.plan(list, initialGmailState())).changes).toEqual([]);
    await expect(adapter.apply(wanted)).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("gmailStateHoldsFilters", () => {
  it("is true for a filter, one left to delete, an unconfirmed create, another adapter's state and a state it cannot read", () => {
    expect(gmailStateHoldsFilters(initialGmailState())).toBe(false);
    expect(
      gmailStateHoldsFilters(stateWith({ refused: [{ value: "a@spam.example", by: "x" }] })),
    ).toBe(false);
    const rec = { id: "abc", entries: [held("a@spam.example")] };
    expect(gmailStateHoldsFilters(stateWith({ filters: [rec] }))).toBe(true);
    expect(gmailStateHoldsFilters(stateWith({ stale: [rec] }))).toBe(true);
    expect(
      gmailStateHoldsFilters(
        stateWith({ intent: [{ entries: [held("a@spam.example")], replaces: null }] }),
      ),
    ).toBe(true);
    expect(gmailStateHoldsFilters({ adapterId: "sieve", data: {} })).toBe(true);
    expect(gmailStateHoldsFilters({ adapterId: "gmail", data: { nonsense: 1 } })).toBe(true);
  });
});

describe("the person's own addresses", () => {
  function withExclude(own: Set<string>) {
    const fake = new FakeGmail();
    const client = createGmailClient({
      getAccessToken: () => Promise.resolve(fake.token),
      fetch: fake.fetch,
      timeoutMs: 500,
    });
    const adapter = new GmailAdapter({
      accountId: LANE,
      client,
      checkpoint: () => undefined,
      sleep: () => Promise.resolve(),
      exclude: (address) => own.has(address),
    });
    return { fake, adapter };
  }

  it("never become a filter: a forged own address that was blocked would send the person's own mail to Trash", async () => {
    const { fake, adapter } = withExclude(new Set(["me@gmail.com"]));
    const list = listOf(["me@gmail.com", "spam@spam.example"]);
    const plan = await adapter.plan(list, initialGmailState());
    expect(plan.changes.map((c) => c.entry.value)).toEqual(["spam@spam.example"]);
    const result = await adapter.apply(plan);
    expect(result.applied).toBe(1);
    const query = [...fake.filters.values()][0]?.criteria["query"] as string;
    expect(query).toContain("spam@spam.example");
    expect(query).not.toContain("me@gmail.com");
  });

  it("are taken out of a filter they are already in, as an Unblock would", async () => {
    const own = new Set<string>();
    const { fake, adapter } = withExclude(own);
    const list = listOf(["me@gmail.com", "spam@spam.example"]);
    const first = await round(adapter, list, initialGmailState());
    expect(valuesOf(recordsOf(first.result.state)[0]).sort()).toEqual([
      "me@gmail.com",
      "spam@spam.example",
    ]);
    // A Gmail account for me@gmail.com is signed in later: the address is now the person's own.
    own.add("me@gmail.com");
    const second = await round(adapter, list, first.result.state);
    expect(valuesOf(recordsOf(second.result.state)[0])).toEqual(["spam@spam.example"]);
    expect([...fake.filters.values()]).toHaveLength(1);
  });
});

describe("a plan that had nothing to do", () => {
  it("is answered again without a new look only for the same list over the same state; any change is seen", async () => {
    const own = new Set<string>();
    const fake = new FakeGmail();
    const client = createGmailClient({
      getAccessToken: () => Promise.resolve(fake.token),
      fetch: fake.fetch,
      timeoutMs: 500,
    });
    const adapter = new GmailAdapter({
      accountId: LANE,
      client,
      checkpoint: () => undefined,
      sleep: () => Promise.resolve(),
      exclude: (address) => own.has(address),
    });
    const list = listOf(addrs(3));
    const placed = await round(adapter, list, initialGmailState());
    const state = placed.result.state;
    expect((await adapter.plan(list, state)).changes).toEqual([]);
    expect((await adapter.plan(list, state)).changes).toEqual([]);
    // A new address: seen.
    const more = [...list, entry("new@spam.example")];
    expect((await adapter.plan(more, state)).changes.map((c) => c.entry.value)).toEqual([
      "new@spam.example",
    ]);
    // An address that left the list: seen.
    expect((await adapter.plan(list.slice(1), state)).changes.map((c) => c.kind)).toEqual([
      "remove",
    ]);
    // A Junk entry next to the same Trash ones: still nothing to do.
    expect((await adapter.plan([...list, entry("j@spam.example", "junk")], state)).changes).toEqual(
      [],
    );
    // The same list over another state: seen.
    expect((await adapter.plan(list, initialGmailState())).changes).toHaveLength(3);
    // An address that became the person's own: seen, though neither the list nor the state moved.
    expect((await adapter.plan(list, state)).changes).toEqual([]);
    own.add(addrs(3)[0] ?? "");
    expect((await adapter.plan(list, state)).changes.map((c) => c.kind)).toEqual(["remove"]);
  });
});

describe("an Unblock of an address that an identical filter of someone else's holds", () => {
  it("is not shown as done: it fails once, with a fixed word, and the refusal ends with the report", async () => {
    const { fake, adapter } = setup();
    const foreign = fake.addForeign(
      { query: compileFromQuery(addrs(2)) },
      { addLabelIds: ["TRASH"] },
    );
    const list = listOf(addrs(2));
    const first = await round(adapter, list, initialGmailState());
    expect(refusedOf(first.result.state)).toEqual(addrs(2));
    // The person unblocks the first address.
    const rest = list.slice(1);
    const { plan, result } = await round(adapter, rest, first.result.state);
    const gone = plan.changes.filter((c) => c.kind === "remove");
    expect(gone.map((c) => c.entry.id)).toEqual([list[0]?.id]);
    expect(result.failed.map((f) => [f.entryId, f.error.code])).toEqual([
      [list[0]?.id, "REMOTE_CHANGED"],
    ]);
    expect(result.failed[0]?.error.message).toBe(
      "a Gmail filter that Senderban did not write still trashes this sender",
    );
    // Said once: the refusal of that address is gone, the other stays, and the foreign filter is untouched.
    expect(refusedOf(result.state)).toEqual([addrs(2)[1]]);
    expect(fake.filters.has(foreign)).toBe(true);
    expect(fake.callsTo("DELETE")).toHaveLength(0);
  });

  it("a state written before the refusal carried an id is still read (the field is optional)", async () => {
    const { adapter } = setup();
    const state = stateWith({ refused: [{ value: "a@spam.example", by: "foreign-1" }] });
    const plan = await adapter.plan([], state);
    expect(plan.changes.map((c) => c.entry.id)).toEqual([GMAIL_CLEANUP_ENTRY_ID]);
  });
});
