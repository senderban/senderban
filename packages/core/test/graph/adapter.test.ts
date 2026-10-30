import { describe, expect, it } from "vitest";
import type { ApplyResult, OpaqueState } from "../../src/adapter.js";
import type { BlockEntry } from "../../src/blocklist.js";
import {
  GRAPH_CLEANUP_ENTRY_ID,
  GRAPH_MAX_WRITES_PER_ROUND,
  GRAPH_MIN_STRINGS_PER_RULE,
  GRAPH_STRINGS_PER_RULE,
  GraphAdapter,
  graphLaneId,
  graphEditedRules,
  graphMatchReaches,
  graphStateHoldsDeletable,
  graphStateHoldsRules,
  initialGraphState,
} from "../../src/graph/adapter.js";
import { GraphBudgets } from "../../src/graph/budget.js";
import { GRAPH_RULE_NAME, createGraphClient } from "../../src/graph/client.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/store.js";
import { ACCOUNT_ID, SyncEngine } from "../../src/sync/engine.js";
import { unblock } from "../../src/notify/unblock.js";
import { ACCESS, FakeGraph, JUNK_ID } from "./fake-graph.js";

const LANE = "ms-12345678.graph";

let n = 0;
const entry = (
  value: string,
  action: BlockEntry["action"] = "junk",
  match: BlockEntry["match"] = "exactAddress",
): BlockEntry => ({
  id: crypto.randomUUID(),
  match,
  value,
  action,
  createdAt: new Date(Date.UTC(2026, 9, 31, 12, 0, n++)).toISOString(),
});
const addrs = (count: number, prefix = "u"): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i)}@spam.example`);
const listOf = (values: string[], action: BlockEntry["action"] = "junk"): BlockEntry[] =>
  values.map((v) => entry(v, action));

interface Rig {
  readonly fake: FakeGraph;
  readonly adapter: GraphAdapter;
  readonly saved: OpaqueState[];
}

function rig(
  options: Partial<ConstructorParameters<typeof GraphAdapter>[0]> = {},
  clock: { now: number } = { now: 0 },
): Rig {
  const fake = new FakeGraph();
  const saved: OpaqueState[] = [];
  const adapter = new GraphAdapter({
    accountId: LANE,
    client: createGraphClient({
      getAccessToken: () => Promise.resolve(ACCESS),
      fetch: fake.fetch,
      now: () => clock.now,
    }),
    checkpoint: (state) => {
      saved.push(state);
    },
    sleep: () => Promise.resolve(),
    ...options,
  });
  return { fake, adapter, saved };
}

/** Plans and applies until nothing is left, as the engine would; a state saved mid-round stands in for one the engine dropped. */
async function settle(
  { adapter }: Rig,
  list: BlockEntry[],
  state: OpaqueState,
): Promise<{ state: OpaqueState; rounds: ApplyResult[] }> {
  const rounds: ApplyResult[] = [];
  let current = state;
  for (let i = 0; i < 40; i += 1) {
    const plan = await adapter.plan(list, current);
    if (plan.changes.length === 0) return { state: current, rounds };
    const result = await adapter.apply(plan);
    rounds.push(result);
    current = result.state;
    // A round that only looked (an edited rule stays): the engine does not ask again by itself.
    if (
      plan.changes.every((c) => c.entry.id === GRAPH_CLEANUP_ENTRY_ID) &&
      result.deferred === undefined
    ) {
      return { state: current, rounds };
    }
  }
  throw new Error("did not settle");
}

const stateRules = (state: OpaqueState): { id: string; entries: { value: string }[] }[] =>
  (state.data as { rules: { id: string; entries: { value: string }[] }[] }).rules;
const intentOf = (state: OpaqueState): unknown[] => (state.data as { intent: unknown[] }).intent;
const capacityOf = (state: OpaqueState): number => (state.data as { capacity: number }).capacity;
const editedOf = (state: OpaqueState): { id: string; entries: { value: string }[] }[] =>
  (state.data as { edited: { id: string; entries: { value: string }[] }[] }).edited;

describe("graph lane id", () => {
  it("always fits the engine's id", () => {
    const long = "a".repeat(64);
    expect(ACCOUNT_ID.test(graphLaneId(long))).toBe(true);
    expect(graphLaneId("ms-1")).toBe("ms-1.graph");
  });
});

describe("GraphAdapter writes", () => {
  it("puts a junk block in one rule that moves to the Junk folder and stops, with our name", async () => {
    const r = rig();
    const { state } = await settle(r, listOf(["a@spam.example"]), initialGraphState());
    const [rule] = [...r.fake.rules.values()];
    expect(GRAPH_RULE_NAME.test(rule?.displayName ?? "")).toBe(true);
    expect(rule?.isEnabled).toBe(true);
    expect(rule?.conditions).toEqual({
      fromAddresses: [{ emailAddress: { address: "a@spam.example" } }],
    });
    expect(rule?.actions).toEqual({ moveToFolder: JUNK_ID, stopProcessingRules: true });
    expect(stateRules(state)).toHaveLength(1);
    expect((state.data as { junkFolderId: string }).junkFolderId).toBe(JUNK_ID);
  });

  it("carries out Trash as delete (Deleted Items) and never as a permanent delete", async () => {
    const r = rig();
    await settle(r, listOf(["a@spam.example"], "trash"), initialGraphState());
    const [rule] = [...r.fake.rules.values()];
    expect(rule?.actions).toEqual({ delete: true, stopProcessingRules: true });
    expect(JSON.stringify(rule)).not.toContain("permanentDelete");
    // No Junk rule, no need to read the folder.
    expect(r.fake.calls.some((c) => c.url.includes("junkemail"))).toBe(false);
  });

  it("carries out reject as Junk: only MXroute refuses at the door", async () => {
    const r = rig();
    await settle(r, listOf(["a@spam.example"], "reject"), initialGraphState());
    expect([...r.fake.rules.values()][0]?.actions.moveToFolder).toBe(JUNK_ID);
  });

  it("keeps addresses and domains in separate rules, per action", async () => {
    const r = rig();
    await settle(
      r,
      [
        entry("a@spam.example", "junk"),
        entry("b@spam.example", "trash"),
        entry("whole.example", "junk", "exactDomain"),
      ],
      initialGraphState(),
    );
    const shapes = [...r.fake.rules.values()].map((rule) => Object.keys(rule.conditions));
    expect(shapes).toHaveLength(3);
    for (const keys of shapes) expect(keys).toHaveLength(1);
  });

  it("writes a domain as a substring, and subdomains with a second one", async () => {
    const r = rig();
    await settle(
      r,
      [entry("whole.example", "junk", "exactDomain"), entry("sub.example", "junk", "subdomains")],
      initialGraphState(),
    );
    expect(r.fake.allStrings()).toEqual(["@WHOLE.EXAMPLE", "@SUB.EXAMPLE", ".SUB.EXAMPLE"]);
    expect(r.adapter.capabilities().exactDomain).toBe(false);
    expect(r.adapter.capabilities().subdomains).toBe(false);
    expect(r.adapter.capabilities().exactAddress).toBe(true);
  });

  it("reads back a rule the server stored in capitals and renumbered as ours: no second write", async () => {
    const r = rig();
    const list = [entry("whole.example", "junk", "exactDomain")];
    const first = await settle(r, list, initialGraphState());
    const writes = r.fake.writes();
    const second = await settle(r, [...list, entry("x@spam.example")], first.state);
    expect(stateRules(second.state)).toHaveLength(2);
    expect(r.fake.writes()).toBe(writes + 1);
  });

  it("adds to the rule with room by one PATCH, without touching the others", async () => {
    const r = rig();
    const list = listOf(["a@spam.example"]);
    const { state } = await settle(r, list, initialGraphState());
    r.fake.calls.length = 0;
    const next = await settle(r, [...list, entry("b@spam.example")], state);
    const methods = r.fake.calls.map((c) => c.method);
    expect(methods).toEqual(["GET", "PATCH"]);
    expect(stateRules(next.state)).toHaveLength(1);
    expect(r.fake.allStrings().sort()).toEqual(["a@spam.example", "b@spam.example"]);
  });

  it("takes one out by PATCH, and deletes the rule with its last entry", async () => {
    const r = rig();
    const [a, b] = listOf(["a@spam.example", "b@spam.example"]) as [BlockEntry, BlockEntry];
    const { state } = await settle(r, [a, b], initialGraphState());
    const one = await settle(r, [b], state);
    expect(r.fake.allStrings()).toEqual(["b@spam.example"]);
    const none = await settle(r, [], one.state);
    expect(r.fake.rules.size).toBe(0);
    expect(stateRules(none.state)).toEqual([]);
    expect(graphStateHoldsRules(none.state)).toBe(false);
  });

  it("moves an entry whose action changed to a rule of that action", async () => {
    const r = rig();
    const before = listOf(["a@spam.example", "b@spam.example"], "junk");
    const { state } = await settle(r, before, initialGraphState());
    const after = [before[0] as BlockEntry, entry("b@spam.example", "trash")];
    await settle(r, after, state);
    const rules = [...r.fake.rules.values()];
    expect(rules).toHaveLength(2);
    const trash = rules.find((x) => x.actions.delete === true);
    expect(trash === undefined ? [] : r.fake.stringsOf(trash)).toEqual(["b@spam.example"]);
  });

  it("splits a long list over rules of the capacity and takes a backlog over several rounds", async () => {
    const r = rig();
    const count = GRAPH_STRINGS_PER_RULE * (GRAPH_MAX_WRITES_PER_ROUND + 1) + 1;
    const { state, rounds } = await settle(r, listOf(addrs(count)), initialGraphState());
    expect(rounds).toHaveLength(2);
    expect(r.fake.rules.size).toBe(GRAPH_MAX_WRITES_PER_ROUND + 2);
    expect(new Set(r.fake.allStrings()).size).toBe(count);
    expect(stateRules(state).flatMap((x) => x.entries)).toHaveLength(count);
  });

  it("answers an unchanged list without a request, even at the size limit", async () => {
    const r = rig();
    const list = listOf(addrs(300));
    const { state } = await settle(r, list, initialGraphState());
    r.fake.calls.length = 0;
    const plan = await r.adapter.plan(list, state);
    expect(plan.changes).toEqual([]);
    expect(r.fake.calls).toEqual([]);
  });

  it("makes one list and one write per block, at most, and holds one request at a time", async () => {
    const r = rig();
    const list = listOf(["a@spam.example"]);
    const { state } = await settle(r, list, initialGraphState());
    r.fake.calls.length = 0;
    await settle(r, [...list, entry("b@spam.example")], state);
    expect(r.fake.calls).toHaveLength(2);
  });
});

describe("GraphAdapter: what Outlook refuses", () => {
  it("halves the capacity when a rule is refused, keeps it, and gets the list through", async () => {
    const r = rig();
    r.fake.maxStrings = 30;
    const count = 80;
    const { state } = await settle(r, listOf(addrs(count)), initialGraphState());
    expect(capacityOf(state)).toBe(25);
    expect(new Set(r.fake.allStrings()).size).toBe(count);
    expect([...r.fake.rules.values()].every((x) => r.fake.stringsOf(x).length <= 25)).toBe(true);
  });

  it("stops halving at the floor and reports the refusal instead of looping", async () => {
    const r = rig();
    r.fake.maxStrings = 2;
    let state = initialGraphState();
    const list = listOf(addrs(GRAPH_STRINGS_PER_RULE));
    let last: ApplyResult | undefined;
    for (let i = 0; i < 6; i += 1) {
      const plan = await r.adapter.plan(list, state);
      last = await r.adapter.apply(plan);
      state = last.state;
    }
    expect(capacityOf(state)).toBe(GRAPH_MIN_STRINGS_PER_RULE);
    expect(last?.applied).toBe(0);
    expect(last?.failed[0]?.error.code).toBe("REJECTED");
    expect(intentOf(state)).toEqual([]);
  });

  it("does not halve for a rule that is already small: the refusal is about something else", async () => {
    const r = rig();
    r.fake.forced.set("POST", [400]);
    const plan = await r.adapter.plan(listOf(["a@spam.example"]), initialGraphState());
    const result = await r.adapter.apply(plan);
    expect(capacityOf(result.state)).toBe(GRAPH_STRINGS_PER_RULE);
    expect(result.failed[0]?.error.code).toBe("REJECTED");
  });

  it("does not halve for a rule that shrinks, whatever Outlook says", async () => {
    const r = rig();
    const list = listOf(addrs(GRAPH_STRINGS_PER_RULE));
    const { state } = await settle(r, list, initialGraphState());
    r.fake.forced.set("PATCH", [400]);
    const plan = await r.adapter.plan(list.slice(1), state);
    const result = await r.adapter.apply(plan);
    expect(capacityOf(result.state)).toBe(GRAPH_STRINGS_PER_RULE);
    expect(result.failed).toHaveLength(1);
  });

  it("reads the Junk folder again after a new rule was refused", async () => {
    const r = rig();
    const { state } = await settle(r, listOf(["a@spam.example"]), initialGraphState());
    r.fake.rules.clear();
    r.fake.forced.set("POST", [400]);
    r.fake.calls.length = 0;
    const list = listOf(["b@spam.example"]);
    const first = await r.adapter.apply(await r.adapter.plan(list, state));
    expect((first.state.data as { junkFolderId: string | null }).junkFolderId).toBeNull();
    await settle(r, list, first.state);
    expect(r.fake.calls.filter((c) => c.url.includes("junkemail"))).toHaveLength(1);
  });

  it("reports a mailbox with no room as failed, keeps the capacity, and leaves no intent", async () => {
    const r = rig();
    r.fake.maxRules = 0;
    const plan = await r.adapter.plan(listOf(["a@spam.example"]), initialGraphState());
    const result = await r.adapter.apply(plan);
    expect(result.applied).toBe(0);
    expect(result.failed[0]?.error.message).toContain("no room");
    expect(capacityOf(result.state)).toBe(GRAPH_STRINGS_PER_RULE);
    expect(intentOf(result.state)).toEqual([]);
  });

  it("reports 429 as failed (TRANSIENT), so the engine backs off and an Unblock is not shown as done", async () => {
    const r = rig();
    r.fake.forced.set("GET", [{ status: 429, headers: { "retry-after": "10" } }]);
    const list = listOf(["a@spam.example"]);
    const plan = await r.adapter.plan(list, initialGraphState());
    const result = await r.adapter.apply(plan);
    expect(result.applied).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error.code).toBe("TRANSIENT");
  });

  it("throws a refused sign-in, so the engine stops asking", async () => {
    const r = rig();
    r.fake.forced.set("GET", [401]);
    const plan = await r.adapter.plan(listOf(["a@spam.example"]), initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("throws a refused permission on the Junk folder with the approval text", async () => {
    const r = rig();
    r.fake.junkId = null;
    const plan = await r.adapter.plan(listOf(["a@spam.example"]), initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toThrow("your organization may have to approve");
  });
});

describe("GraphAdapter: answers that never came back", () => {
  it("never sends a create again: the next round finds it by its name", async () => {
    const r = rig();
    r.fake.createThenFail = [500];
    const list = listOf(["a@spam.example"]);
    const plan = await r.adapter.plan(list, initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(r.fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const saved = r.saved.at(-1) as OpaqueState;
    expect(intentOf(saved)).toHaveLength(1);
    expect(graphStateHoldsRules(saved)).toBe(true);

    const { state } = await settle(r, list, saved);
    expect(r.fake.rules.size).toBe(1);
    expect(stateRules(state)).toHaveLength(1);
    expect(intentOf(state)).toEqual([]);
  });

  it("drops an intent nothing came of, and writes the entry again", async () => {
    const r = rig();
    r.fake.forced.set("POST", [500]);
    const list = listOf(["a@spam.example"]);
    const plan = await r.adapter.plan(list, initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    const saved = r.saved.at(-1) as OpaqueState;
    expect(r.fake.rules.size).toBe(0);
    const { state } = await settle(r, list, saved);
    expect(r.fake.rules.size).toBe(1);
    expect(stateRules(state)).toHaveLength(1);
  });

  it("saves the intent before the create goes out, or sends nothing", async () => {
    const r = rig({
      checkpoint: () => {
        throw new Error("disk full");
      },
    });
    const plan = await r.adapter.plan(listOf(["a@spam.example"]), initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toThrow("could not be saved");
    expect(r.fake.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("retries a PATCH after a 5xx, which is safe: the same body writes the same rule", async () => {
    const r = rig();
    const list = listOf(["a@spam.example"]);
    const { state } = await settle(r, list, initialGraphState());
    r.fake.forced.set("PATCH", [500]);
    r.fake.calls.length = 0;
    const next = await settle(r, [...list, entry("b@spam.example")], state);
    expect(r.fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    expect(stateRules(next.state)[0]?.entries).toHaveLength(2);
  });

  it("keeps the intent of a PATCH whose 503 silenced the client: its outcome is unknown", async () => {
    const clock = { now: 0 };
    const r = rig({}, clock);
    const list = listOf(["a@spam.example"]);
    const { state } = await settle(r, list, initialGraphState());
    r.fake.updateThenFail = [503];
    const longer = [...list, entry("b@spam.example")];
    const plan = await r.adapter.plan(longer, state);
    await expect(r.adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(r.fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    const saved = r.saved.at(-1) as OpaqueState;
    expect(intentOf(saved)).toHaveLength(1);
    clock.now = 60_000;
    const after = await settle(r, longer, saved);
    expect(stateRules(after.state)[0]?.entries).toHaveLength(2);
  });

  it("settles a PATCH that landed while its answer was lost", async () => {
    const r = rig();
    const list = listOf(["a@spam.example"]);
    const { state } = await settle(r, list, initialGraphState());
    r.fake.updateThenFail = [500, 500, 500];
    const longer = [...list, entry("b@spam.example")];
    const plan = await r.adapter.plan(longer, state);
    await expect(r.adapter.apply(plan)).rejects.toMatchObject({ code: "TRANSIENT" });
    const saved = r.saved.at(-1) as OpaqueState;
    expect(intentOf(saved)).toHaveLength(1);
    const after = await settle(r, longer, saved);
    expect(stateRules(after.state)[0]?.entries).toHaveLength(2);
    expect(r.fake.rules.size).toBe(1);
  });

  it("deletes a rule and forgets it even when the DELETE was refused as already gone", async () => {
    const r = rig();
    const list = listOf(["a@spam.example"]);
    const { state } = await settle(r, list, initialGraphState());
    r.fake.forced.set("DELETE", [404]);
    const after = await settle(r, [], state);
    expect(stateRules(after.state)).toEqual([]);
  });
});

describe("GraphAdapter: rules that are not ours any more", () => {
  const setUp = async () => {
    const r = rig();
    const list = listOf(["a@spam.example"]);
    const { state } = await settle(r, list, initialGraphState());
    const [rule] = [...r.fake.rules.values()];
    if (rule === undefined) throw new Error("no rule");
    return { r, list, state, rule };
  };

  it.each([
    ["renamed", (rule: { displayName: string }) => (rule.displayName = "My rule")],
    ["read-only", (rule: { isReadOnly: boolean }) => (rule.isReadOnly = true)],
    [
      "given another condition",
      (rule: { conditions: Record<string, unknown> }) => (rule.conditions.subjectContains = ["x"]),
    ],
    [
      "given an exception",
      (rule: { exceptions?: Record<string, unknown> }) =>
        (rule.exceptions = { subjectContains: ["x"] }),
    ],
    [
      "given another action",
      (rule: { actions: Record<string, unknown> }) =>
        (rule.actions.forwardTo = [{ emailAddress: { address: "x@spam.example" } }]),
    ],
    ["switched off", (rule: { isEnabled: boolean }) => (rule.isEnabled = false)],
  ])(
    "leaves a rule that was %s alone, keeps it, and writes what is new elsewhere",
    async (_name, edit) => {
      const { r, list, state, rule } = await setUp();
      edit(rule);
      const before = JSON.stringify(rule);
      r.fake.calls.length = 0;
      const longer = [...list, entry("b@spam.example")];
      const { state: end } = await settle(r, longer, state);
      expect(JSON.stringify(r.fake.rules.get(rule.id))).toBe(before);
      expect(r.fake.calls.some((c) => c.method === "PATCH" || c.method === "DELETE")).toBe(false);
      expect(editedOf(end).map((x) => x.id)).toEqual([rule.id]);
      // The entry it holds is covered: a second rule would undo the exception the person just made.
      expect(stateRules(end).flatMap((x) => x.entries.map((e) => e.value))).toEqual([
        "b@spam.example",
      ]);
    },
  );

  it("says so when an Unblock meets an edited rule, instead of reading as done, and says it once", async () => {
    const { r, state, rule } = await setUp();
    rule.exceptions = { subjectContains: ["invoice"] };
    const first = await r.adapter.apply(await r.adapter.plan([], state));
    expect(first.applied).toBe(0);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]?.error.code).toBe("REMOTE_CHANGED");
    expect(first.failed[0]?.error.message).toContain("remove it there");
    expect(r.fake.rules.has(rule.id)).toBe(true);
    const second = await r.adapter.apply(await r.adapter.plan([], first.state));
    expect(second.failed).toEqual([]);
  });

  it("still sees an edited rule when the person deletes it, and writes what is wanted", async () => {
    const { r, list, state, rule } = await setUp();
    rule.exceptions = { subjectContains: ["invoice"] };
    const { state: kept } = await settle(r, list, state).catch(() => ({ state }));
    r.fake.rules.delete(rule.id);
    const first = await r.adapter.apply(await r.adapter.plan(list, kept));
    const { state: end } = await settle(r, list, first.state);
    expect(editedOf(end)).toEqual([]);
    expect(r.fake.allStrings()).toEqual(["a@spam.example"]);
  });

  it("takes a rule back when it reads as written again", async () => {
    const { r, list, state, rule } = await setUp();
    rule.isEnabled = false;
    const off = await r.adapter.apply(await r.adapter.plan(list, state));
    expect(editedOf(off.state)).toHaveLength(1);
    rule.isEnabled = true;
    const on = await r.adapter.apply(await r.adapter.plan(list, off.state));
    expect(editedOf(on.state)).toEqual([]);
    expect(stateRules(on.state)).toHaveLength(1);
  });

  it("uninstall leaves an edited rule, says it stays, and does not hold the account", async () => {
    const { r, state, rule } = await setUp();
    rule.exceptions = { subjectContains: ["invoice"] };
    const left = await r.adapter.uninstall(state);
    expect(r.fake.rules.has(rule.id)).toBe(true);
    expect(graphStateHoldsRules(left)).toBe(true);
    expect(graphStateHoldsDeletable(left)).toBe(false);
  });

  it("uninstall does not take a rule it cannot read for one that is gone", async () => {
    const { r, state, rule } = await setUp();
    r.fake.forced.set("GET", [{ status: 200, body: { value: [{ id: rule.id, displayName: 5 }] } }]);
    const left = await r.adapter.uninstall(state);
    expect(graphStateHoldsRules(left)).toBe(true);
    expect(graphStateHoldsDeletable(left)).toBe(false);
    expect(graphEditedRules(left)).toBe(1);
  });

  it("stops at the first rule Outlook stores otherwise, and tracks it", async () => {
    const r = rig();
    r.fake.storeExtraAction = true;
    const list = listOf(["a@spam.example"]);
    const plan = await r.adapter.plan(list, initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toThrow("differently than written");
    const saved = r.saved.at(-1) as OpaqueState;
    expect(editedOf(saved)).toHaveLength(1);
    r.fake.calls.length = 0;
    await settle(r, list, saved);
    expect(r.fake.calls.some((c) => c.method === "POST")).toBe(false);
    expect(r.fake.rules.size).toBe(1);
  });

  it("does not take a rule it cannot read for one that is gone", async () => {
    const { r, list, state, rule } = await setUp();
    r.fake.forced.set("GET", [{ status: 200, body: { value: [{ id: rule.id, displayName: 5 }] } }]);
    r.fake.calls.length = 0;
    const result = await r.adapter.apply(
      await r.adapter.plan([...list, entry("whole.example", "trash", "exactDomain")], state),
    );
    expect(stateRules(result.state).map((x) => x.id)).toContain(rule.id);
  });

  it("does not count a PATCH that found the rule gone as written", async () => {
    const { r, list, state, rule } = await setUp();
    const longer = [...list, entry("b@spam.example")];
    const plan = await r.adapter.plan(longer, state);
    r.fake.forced.set("PATCH", [404]);
    const result = await r.adapter.apply(plan);
    expect(result.applied).toBe(0);
    expect(result.deferred).toBeGreaterThan(0);
    expect(stateRules(result.state).map((x) => x.id)).not.toContain(rule.id);
  });

  it("puts back a rule that was deleted in Outlook", async () => {
    const { r, list, state, rule } = await setUp();
    r.fake.rules.delete(rule.id);
    const longer = [...list, entry("b@spam.example")];
    const { state: end } = await settle(r, longer, state);
    expect(stateRules(end).flatMap((x) => x.entries)).toHaveLength(2);
    expect(r.fake.allStrings().sort()).toEqual(["a@spam.example", "b@spam.example"]);
  });

  it("never touches a rule of the person's own", async () => {
    const r = rig();
    r.fake.rules.set("mine", {
      id: "mine",
      displayName: "Newsletters",
      sequence: 1,
      isEnabled: true,
      hasError: false,
      isReadOnly: false,
      conditions: { senderContains: ["NEWS"] },
      actions: { moveToFolder: "folder" },
    });
    const before = JSON.stringify(r.fake.rules.get("mine"));
    const { state } = await settle(r, listOf(["a@spam.example"]), initialGraphState());
    const after = await settle(r, [], state);
    expect(stateRules(after.state)).toEqual([]);
    expect(JSON.stringify(r.fake.rules.get("mine"))).toBe(before);
    await r.adapter.uninstall(after.state);
    expect(JSON.stringify(r.fake.rules.get("mine"))).toBe(before);
  });

  it("reports a rule the person switched off at the read-back", async () => {
    const { r, state, rule } = await setUp();
    rule.isEnabled = false;
    const drift = await r.adapter.verify(state);
    expect(drift.drifted).toBe(true);
    expect(drift.detail).toContain("1 changed");
    expect(r.fake.rules.has(rule.id)).toBe(true);
  });

  it("reports a rule in error", async () => {
    const { r, state, rule } = await setUp();
    rule.hasError = true;
    expect((await r.adapter.verify(state)).detail).toContain("1 in error");
  });
});

describe("graphMatchReaches: a text match against the person's own mail", () => {
  // Built at run time: the look-alikes are public names by nature, and the point of the test.
  const dot = (...labels: string[]) => labels.join(".");
  const LOOK_ALIKE = dot("contoso", "co");
  const own = {
    domains: new Set([`${LOOK_ALIKE}m`]),
    addresses: new Set(["me@fabrikam.example"]),
  };
  const domain = (value: string, match: "subdomains" | "exactDomain" = "subdomains") => ({
    match,
    value,
  });

  it.each([
    LOOK_ALIKE,
    "fabrikam.exam",
    dot("gmail", "co"),
    dot("hotmail", "co"),
    dot("yahoo", "co"),
    dot("hotmail", "f"),
  ])("refuses %s", (value) => {
    expect(graphMatchReaches(domain(value), own)).toBe(true);
    expect(graphMatchReaches(domain(value, "exactDomain"), own)).toBe(true);
  });

  it.each(["spam.example", dot("not" + LOOK_ALIKE), dot(LOOK_ALIKE, "uk")])(
    "lets %s through",
    (value) => {
      expect(graphMatchReaches(domain(value), own)).toBe(false);
    },
  );

  it("leaves a single address alone", () => {
    expect(graphMatchReaches({ match: "exactAddress", value: `a@${LOOK_ALIKE}` }, own)).toBe(false);
  });

  it("keeps such a domain out of the rules, and takes it out of a rule that holds it", async () => {
    const reaches = (e: { match: BlockEntry["match"]; value: string }) => graphMatchReaches(e, own);
    const r = rig({ reaches });
    const refused = entry(LOOK_ALIKE, "junk", "subdomains");
    const fine = entry("spam.example", "junk", "subdomains");
    await settle(r, [refused, fine], initialGraphState());
    expect(r.fake.allStrings().sort()).toEqual([".SPAM.EXAMPLE", "@SPAM.EXAMPLE"]);

    const open = rig();
    const { state } = await settle(open, [refused], initialGraphState());
    const closed = new GraphAdapter({
      accountId: LANE,
      client: createGraphClient({
        getAccessToken: () => Promise.resolve(ACCESS),
        fetch: open.fake.fetch,
      }),
      checkpoint: () => undefined,
      reaches,
    });
    await closed.apply(await closed.plan([refused], state));
    expect(open.fake.rules.size).toBe(0);
  });
});

describe("GraphAdapter.verify", () => {
  it("says nothing is drifted when each rule reads as written", async () => {
    const r = rig();
    const { state } = await settle(
      r,
      [entry("a@spam.example"), entry("whole.example", "trash", "exactDomain")],
      initialGraphState(),
    );
    const drift = await r.adapter.verify(state);
    expect(drift.drifted).toBe(false);
    expect(drift.checks.every((c) => c.ok)).toBe(true);
  });

  it("makes no request for an empty state", async () => {
    const r = rig();
    await r.adapter.verify(initialGraphState());
    expect(r.fake.calls).toEqual([]);
  });

  it("counts a rule that is gone", async () => {
    const r = rig();
    const { state } = await settle(r, listOf(["a@spam.example"]), initialGraphState());
    r.fake.rules.clear();
    expect((await r.adapter.verify(state)).detail).toContain("1 missing");
  });
});

describe("GraphAdapter lifecycle", () => {
  it("uninstall deletes what is ours and returns an empty state", async () => {
    const r = rig();
    const { state } = await settle(r, listOf(addrs(150)), initialGraphState());
    expect(r.fake.rules.size).toBe(2);
    const left = await r.adapter.uninstall(state);
    expect(r.fake.rules.size).toBe(0);
    expect(graphStateHoldsRules(left)).toBe(false);
  });

  it("uninstall returns what it could not delete, so the caller keeps the account", async () => {
    const r = rig();
    const { state } = await settle(r, listOf(["a@spam.example"]), initialGraphState());
    r.fake.forced.set("DELETE", [403]);
    const left = await r.adapter.uninstall(state);
    expect(graphStateHoldsRules(left)).toBe(true);
  });

  it("uninstall finds a create whose answer was lost, and deletes it too", async () => {
    const r = rig();
    r.fake.createThenFail = [500];
    const plan = await r.adapter.plan(listOf(["a@spam.example"]), initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toBeDefined();
    const left = await r.adapter.uninstall(r.saved.at(-1) as OpaqueState);
    expect(r.fake.rules.size).toBe(0);
    expect(graphStateHoldsRules(left)).toBe(false);
  });

  it("while suspended answers TRANSIENT, never nothing to do; resume ends it", async () => {
    const r = rig();
    await expect(r.adapter.suspend()).resolves.toBe(true);
    await expect(r.adapter.plan([], initialGraphState())).rejects.toMatchObject({
      code: "TRANSIENT",
    });
    await expect(
      r.adapter.apply({ accountId: LANE, changes: [], basedOn: initialGraphState() }),
    ).rejects.toMatchObject({ code: "TRANSIENT" });
    r.adapter.resume();
    await expect(r.adapter.plan([], initialGraphState())).resolves.toBeDefined();
  });

  it("a retired lane has nothing to do", async () => {
    const r = rig();
    r.adapter.retire();
    const plan = await r.adapter.plan(listOf(["a@spam.example"]), initialGraphState());
    expect(plan.changes).toEqual([]);
  });

  it("refuses a state from another adapter or one that fails its schema", async () => {
    const r = rig();
    await expect(r.adapter.plan([], { adapterId: "gmail", data: {} })).rejects.toMatchObject({
      code: "REJECTED",
    });
    await expect(
      r.adapter.plan([], { adapterId: "graph", data: { rules: "x" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(graphStateHoldsRules({ adapterId: "graph", data: {} })).toBe(true);
  });

  it("marks a round that has only an intent to settle", async () => {
    const r = rig();
    r.fake.createThenFail = [500];
    const list = listOf(["a@spam.example"]);
    const plan = await r.adapter.plan(list, initialGraphState());
    await expect(r.adapter.apply(plan)).rejects.toBeDefined();
    const next = await r.adapter.plan(list, r.saved.at(-1) as OpaqueState);
    expect(next.changes.map((c) => c.entry.id)).toEqual([GRAPH_CLEANUP_ENTRY_ID]);
  });
});

describe("GraphAdapter under the engine", () => {
  it("blocks and unblocks through the store, the journal and the read-back", async () => {
    const r = rig();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, { debounceMs: 0 });
    engine.addAccount({
      id: LANE,
      adapter: r.adapter,
      initialState: initialGraphState(),
      background: true,
    });
    const added = entry("a@spam.example");
    expect(store.add(added).ok).toBe(true);
    expect(await engine.sync(LANE)).toMatchObject({ status: "applied", applied: 1 });
    expect(await engine.verify(LANE)).toMatchObject({ status: "verified" });
    const result = await unblock({ store, engine, accountIds: [LANE] }, added.id);
    expect(result.status).toBe("unblocked");
    expect(r.fake.rules.size).toBe(0);
    engine.dispose();
    store.close();
  });
});

describe("GraphBudgets in front of the client", () => {
  it("stops a runaway lane before a request leaves", async () => {
    const r = rig();
    const budgets = new GraphBudgets({
      limits: { perMinute: 1, perAccountDay: 100, allAccountsDay: 100 },
      now: () => 0,
    });
    const events: unknown[] = [];
    const client = budgets.wrap(
      createGraphClient({ getAccessToken: () => Promise.resolve(ACCESS), fetch: r.fake.fetch }),
      {
        key: LANE,
        account: "acct-1",
        log: (e) => {
          events.push(e);
        },
      },
    );
    await client.list();
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(r.fake.calls).toHaveLength(1);
    expect(events).toEqual([
      {
        event: "graph-budget",
        account: "acct-1",
        op: "list",
        limit: "minute",
        used: 1,
        cap: 1,
      },
    ]);
  });
});
