import { afterEach, describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import type {
  ApplyResult,
  BlockAdapter,
  Capabilities,
  Drift,
  OpaqueState,
  Plan,
} from "../../src/adapter.js";
import type { Blocklist } from "../../src/blocklist.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/store.js";
import { MAX_ACCOUNTS, SyncEngine } from "../../src/sync/engine.js";
import type { SyncOutcome } from "../../src/sync/engine.js";

const NONE: Capabilities = {
  serverBlock: true,
  retroClean: false,
  watch: false,
  unsubscribe: false,
  quota: false,
  exactAddress: true,
  exactDomain: true,
  subdomains: true,
};

/** Remote = set of entry ids. Idempotent like the real adapters: re-applying a written plan is a no-op. */
class FakeAdapter implements BlockAdapter {
  readonly id = "fake";
  remote = new Set<string>();
  applyCalls = 0;
  failWith: Error | null = null;
  hang = false;
  gate: Promise<void> | null = null;
  driftedOnVerify = false;

  constructor(private readonly accountId: string) {}

  capabilities(): Capabilities {
    return NONE;
  }

  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    const have = new Set((state.data as { ids: string[] }).ids);
    const want = new Map(list.map((e) => [e.id, e]));
    const changes: Plan["changes"][number][] = [];
    for (const id of have) {
      if (!want.has(id)) {
        changes.push({
          kind: "remove",
          entry: {
            id,
            match: "exactAddress",
            value: "x@example.com",
            action: "junk",
            createdAt: "",
          },
          match: "exactAddress",
        });
      }
    }
    for (const [id, entry] of want) {
      if (!have.has(id)) changes.push({ kind: "create", entry, match: entry.match });
    }
    return Promise.resolve({ accountId: this.accountId, changes, basedOn: state });
  }

  async apply(plan: Plan): Promise<ApplyResult> {
    this.applyCalls++;
    if (this.hang) return new Promise<ApplyResult>(() => undefined);
    if (this.gate !== null) await this.gate;
    if (this.failWith !== null) throw this.failWith;
    const ids = new Set((plan.basedOn.data as { ids: string[] }).ids);
    for (const c of plan.changes) {
      if (c.kind === "create") ids.add(c.entry.id);
      else ids.delete(c.entry.id);
    }
    this.remote = ids;
    return {
      applied: plan.changes.length,
      failed: [],
      state: { adapterId: "fake", data: { ids: [...ids] } },
    };
  }

  verify(): Promise<Drift> {
    return Promise.resolve({
      drifted: this.driftedOnVerify,
      detail: "",
      checkedAt: new Date().toISOString(),
      checks: [],
    });
  }
}

const empty: OpaqueState = { adapterId: "fake", data: { ids: [] } };
let n = 0;
const addr = () => ({
  id: crypto.randomUUID(),
  match: "exactAddress",
  value: `u${String(n++)}@example.com`,
  action: "junk",
  createdAt: new Date(Date.UTC(2026, 9, 24, 12, 0, n)).toISOString(),
});

function setup(options: ConstructorParameters<typeof SyncEngine>[1] = {}) {
  const store = new Store(openDatabase(":memory:"));
  const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 100, ...options });
  const adapters = new Map<string, FakeAdapter>();
  const add = (id: string): FakeAdapter => {
    const adapter = new FakeAdapter(id);
    adapters.set(id, adapter);
    engine.addAccount({ id, adapter, initialState: empty });
    return adapter;
  };
  return { store, engine, add };
}

const engines: SyncEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});
const track = <T extends { engine: SyncEngine }>(s: T): T => {
  engines.push(s.engine);
  return s;
};

describe("SyncEngine.sync", () => {
  it("reports unchanged without touching the journal when nothing differs", async () => {
    const { store, engine, add } = track(setup());
    const a = add("acct");
    expect(await engine.sync("acct")).toEqual({ accountId: "acct", status: "unchanged" });
    expect(a.applyCalls).toBe(0);
    expect(store.journal("acct")).toEqual([]);
  });

  it("applies the list, stores the new state and closes the journal", async () => {
    const { store, engine, add } = track(setup());
    const a = add("acct");
    const first = store.add(addr());
    if (!first.ok) throw new Error("add failed");

    expect(await engine.sync("acct")).toMatchObject({ status: "applied", applied: 1 });
    expect([...a.remote]).toEqual([first.entry.id]);
    expect(store.journal("acct")[0]?.status).toBe("applied");

    store.remove(first.entry.id);
    expect(await engine.sync("acct")).toMatchObject({ status: "applied", applied: 1 });
    expect(a.remote.size).toBe(0);
    expect(await engine.sync("acct")).toMatchObject({ status: "unchanged" });
  });

  it("turns a provider error into a failed outcome and an interrupted journal row", async () => {
    const { store, engine, add } = track(setup());
    const a = add("acct");
    store.add(addr());
    a.failWith = new AdapterError("AUTH_REQUIRED", "password rejected");

    expect(await engine.sync("acct")).toEqual({
      accountId: "acct",
      status: "failed",
      code: "AUTH_REQUIRED",
      message: "password rejected",
    });
    expect(store.journal("acct")[0]?.status).toBe("interrupted");
    expect(store.getState("acct")).toBeUndefined();

    a.failWith = null; // the next sync is not blocked by the failed one
    expect(await engine.sync("acct")).toMatchObject({ status: "applied" });
  });

  it("gives up on a provider that never answers", async () => {
    const { store, engine, add } = track(setup({ timeoutMs: 30 }));
    const a = add("acct");
    store.add(addr());
    a.hang = true;
    expect(await engine.sync("acct")).toMatchObject({ status: "failed", code: "TRANSIENT" });
    expect(store.journal("acct")[0]?.status).toBe("interrupted");
  });

  it("one failing account does not delay or fail another", async () => {
    const { store, engine, add } = track(setup({ timeoutMs: 1_000 }));
    const slow = add("slow");
    add("fast");
    store.add(addr());
    slow.hang = true;

    const started = Date.now();
    const fast = await engine.sync("fast");
    expect(fast.status).toBe("applied");
    expect(Date.now() - started).toBeLessThan(500);
    void engine.sync("slow"); // left hanging on purpose
  });

  it("coalesces edits made while a sync runs into exactly one follow-up", async () => {
    const { store, engine, add } = track(setup());
    const a = add("acct");
    let release: () => void = () => undefined;
    a.gate = new Promise<void>((r) => {
      release = r;
    });
    store.add(addr());

    const first = engine.sync("acct");
    store.add(addr());
    const second = engine.sync("acct");
    const third = engine.sync("acct");
    expect(third).toBe(second);
    a.gate = null;
    release();

    expect((await first).status).toBe("applied");
    expect((await second).status).toBe("applied");
    expect(a.applyCalls).toBe(2);
    expect(a.remote.size).toBe(2);
  });

  it("rejects an unknown account instead of throwing", async () => {
    const { engine } = track(setup());
    expect(await engine.sync("nope")).toMatchObject({ status: "failed", code: "UNKNOWN" });
  });
});

describe("SyncEngine.requestSync", () => {
  it("collapses a burst of edits into one sync", async () => {
    const outcomes: SyncOutcome[] = [];
    const { store, engine, add } = track(
      setup({
        onOutcome: (o) => {
          outcomes.push(o);
        },
      }),
    );
    const a = add("acct");
    for (let i = 0; i < 5; i++) {
      store.add(addr());
      engine.requestSync("acct");
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(a.applyCalls).toBe(1);
    expect(a.remote.size).toBe(5);
    expect(outcomes).toHaveLength(1);
  });

  it("dispose cancels a pending debounce", async () => {
    const { store, engine, add } = track(setup());
    const a = add("acct");
    store.add(addr());
    engine.requestSync("acct");
    engine.dispose();
    await new Promise((r) => setTimeout(r, 40));
    expect(a.applyCalls).toBe(0);
  });
});

describe("SyncEngine.recover", () => {
  it("re-syncs and verifies an account whose process died mid-sync", async () => {
    const { store, engine, add } = track(setup());
    const a = add("acct");
    const first = store.add(addr());
    if (!first.ok) throw new Error("add failed");
    // Crash: journal row written, provider written, completeSync never ran.
    store.beginSync(await a.plan(store.list(), empty));
    a.remote = new Set([first.entry.id]);

    const reports = await engine.recover();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      accountId: "acct",
      interrupted: 1,
      outcome: { status: "applied" },
      drift: { drifted: false },
    });
    expect(store.getState("acct")).toEqual({ adapterId: "fake", data: { ids: [first.entry.id] } });
    expect(await engine.recover()).toEqual([]);
  });

  it("reports an interrupted row for an account that is no longer registered", async () => {
    const { store, engine } = track(setup());
    store.beginSync({ accountId: "gone", changes: [], basedOn: empty });
    expect(await engine.recover()).toEqual([{ accountId: "gone", interrupted: 1 }]);
  });

  it("keeps the failure when the repair sync fails", async () => {
    const { store, engine, add } = track(setup());
    const a = add("acct");
    store.add(addr());
    store.beginSync(await a.plan(store.list(), empty));
    a.failWith = new AdapterError("TRANSIENT", "offline");
    const [report] = await engine.recover();
    expect(report?.outcome).toMatchObject({ status: "failed", code: "TRANSIENT" });
    expect(report?.drift).toBeUndefined();
  });
});

describe("SyncEngine.addAccount", () => {
  it("validates ids and caps the account count", () => {
    const { engine, add } = track(setup());
    add("ok.account@example.com");
    expect(() => {
      add("bad id with spaces");
    }).toThrow(/invalid/);
    expect(() => {
      add("ok.account@example.com");
    }).toThrow(/already/);
    for (let i = 1; i < MAX_ACCOUNTS; i++) add(`a${String(i)}`);
    expect(() => {
      add("one-too-many");
    }).toThrow(/at most/);
    expect(engine).toBeDefined();
  });
});

describe("SyncEngine.verify", () => {
  it("reports verified, drifted and failed without throwing", async () => {
    const s = track(setup());
    const adapter = s.add("a");
    expect(await s.engine.verify("a")).toEqual({ accountId: "a", status: "verified" });
    adapter.driftedOnVerify = true;
    expect((await s.engine.verify("a")).status).toBe("drifted");
    expect((await s.engine.verify("nope")).status).toBe("failed");
  });
});

describe("SyncEngine retry after a failed sync", () => {
  const fast = { retry: { baseMs: 10, maxMs: 40 }, random: () => 0 } as const;

  it("applies the change on its own once a transient failure has passed", async () => {
    const { store, engine, add } = track(setup(fast));
    const a = add("acct");
    store.add(addr());
    a.failWith = new AdapterError("TRANSIENT", "offline");
    expect(await engine.sync("acct")).toMatchObject({ status: "failed", code: "TRANSIENT" });
    expect(a.remote.size).toBe(0);

    a.failWith = null;
    await new Promise((r) => setTimeout(r, 60));
    expect(a.remote.size).toBe(1);
  });

  it("stops retrying once a sync has succeeded", async () => {
    const { store, engine, add } = track(setup(fast));
    const a = add("acct");
    store.add(addr());
    a.failWith = new AdapterError("TRANSIENT", "offline");
    await engine.sync("acct");
    a.failWith = null;
    await new Promise((r) => setTimeout(r, 60));
    const calls = a.applyCalls;
    await new Promise((r) => setTimeout(r, 80));
    expect(a.applyCalls).toBe(calls);
  });

  it("does not retry a failure that retrying cannot fix (wrong password)", async () => {
    const { store, engine, add } = track(setup(fast));
    const a = add("acct");
    store.add(addr());
    a.failWith = new AdapterError("AUTH_REQUIRED", "password rejected");
    await engine.sync("acct");
    const calls = a.applyCalls;
    a.failWith = null;
    await new Promise((r) => setTimeout(r, 80));
    expect(a.applyCalls).toBe(calls);
  });

  it("backs off between attempts instead of retrying in a tight loop", async () => {
    const { store, engine, add } = track(
      setup({ retry: { baseMs: 20, maxMs: 1_000 }, random: () => 1 }),
    );
    const a = add("acct");
    store.add(addr());
    a.failWith = new AdapterError("TRANSIENT", "offline");
    await engine.sync("acct");
    await new Promise((r) => setTimeout(r, 150));
    // delays 20, 40, 80...: at most 3 retries fit in 150 ms, plus the first attempt
    expect(a.applyCalls).toBeLessThanOrEqual(4);
    expect(a.applyCalls).toBeGreaterThanOrEqual(2);
  });

  it("dispose cancels a pending retry", async () => {
    const { store, engine, add } = track(setup(fast));
    const a = add("acct");
    store.add(addr());
    a.failWith = new AdapterError("TRANSIENT", "offline");
    await engine.sync("acct");
    engine.dispose();
    a.failWith = null;
    await new Promise((r) => setTimeout(r, 80));
    expect(a.remote.size).toBe(0);
  });
});
