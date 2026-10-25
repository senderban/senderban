// B1 harness (performance skill): 50 accounts reconnect at the same moment, as after sleep/resume, and one
// block fans out to 50 accounts. Measures the peak number of logins / provider rounds in flight, with and
// without the gate. No network: fake sessions and a fake adapter with a fixed delay.
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApplyResult,
  BlockAdapter,
  Capabilities,
  Drift,
  OpaqueState,
  Plan,
} from "../../src/adapter.js";
import type { Blocklist } from "../../src/blocklist.js";
import {
  MAX_CONCURRENT_LOGINS,
  MAX_CONCURRENT_SYNCS,
  createGate,
  unlimited,
} from "../../src/gate.js";
import type { Gate } from "../../src/gate.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/store.js";
import { MAX_ACCOUNTS, SyncEngine } from "../../src/sync/engine.js";
import { AccountWatcher } from "../../src/watcher/watcher.js";
import type { Cursor, CursorStore, MailboxSession } from "../../src/watcher/watcher.js";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const LOGIN_MS = 20;
const ROUND_MS = 20;

class Probe {
  inFlight = 0;
  peak = 0;
  started = 0;
  async hold(ms: number): Promise<void> {
    this.started += 1;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await tick(ms);
    this.inFlight -= 1;
  }
}

const idleSession = (): MailboxSession => ({
  uidValidity: "1",
  uidNext: 1,
  fetchSince: () => Promise.resolve([]),
  onExists: () => undefined,
  onClose: () => undefined,
  close: () => Promise.resolve(),
});

function cursors(): CursorStore {
  const map = new Map<string, Cursor>();
  return {
    get: (id) => map.get(id),
    set: (id, cursor) => {
      map.set(id, cursor);
    },
  };
}

const watchers: AccountWatcher[] = [];
afterEach(async () => {
  await Promise.all(watchers.splice(0).map((w) => w.stop()));
});

async function reconnectStorm(gate: Gate): Promise<Probe> {
  const probe = new Probe();
  const store = cursors();
  for (let i = 0; i < MAX_ACCOUNTS; i += 1) {
    const watcher = new AccountWatcher({
      accountId: `acct${String(i)}`,
      cursors: store,
      gate,
      connect: async () => {
        await probe.hold(LOGIN_MS);
        return idleSession();
      },
      onMessage: () => undefined,
    });
    watchers.push(watcher);
    watcher.start();
  }
  const deadline = Date.now() + 5_000;
  while (watchers.some((w) => w.current !== "watching") && Date.now() < deadline) await tick(5);
  return probe;
}

describe("50-account reconnect storm", () => {
  it("baseline without a gate opens every login at once", async () => {
    const probe = await reconnectStorm(unlimited);
    expect(probe.started).toBe(MAX_ACCOUNTS);
    expect(probe.peak).toBe(MAX_ACCOUNTS);
  });

  it("with the login gate never exceeds MAX_CONCURRENT_LOGINS and still connects everyone", async () => {
    const probe = await reconnectStorm(createGate(MAX_CONCURRENT_LOGINS));
    expect(probe.started).toBe(MAX_ACCOUNTS);
    expect(probe.peak).toBeLessThanOrEqual(MAX_CONCURRENT_LOGINS);
    expect(watchers.every((w) => w.current === "watching")).toBe(true);
  });

  it("a stop while a watcher waits for a slot opens no login for it", async () => {
    const probe = new Probe();
    const gate = createGate(1);
    const make = (id: string) =>
      new AccountWatcher({
        accountId: id,
        cursors: cursors(),
        gate,
        connect: async () => {
          await probe.hold(LOGIN_MS);
          return idleSession();
        },
        onMessage: () => undefined,
      });
    const first = make("a");
    const second = make("b");
    watchers.push(first, second);
    first.start();
    second.start();
    await second.stop(); // queued behind `first`
    await tick(LOGIN_MS * 4);
    expect(probe.started).toBe(1);
  });
});

class RoundAdapter implements BlockAdapter {
  readonly id = "round";
  constructor(
    private readonly probe: Probe,
    private readonly accountId: string,
  ) {}
  capabilities(): Capabilities {
    return {
      serverBlock: true,
      retroClean: false,
      watch: false,
      unsubscribe: false,
      quota: false,
      exactAddress: true,
      exactDomain: true,
      subdomains: true,
    };
  }
  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    const have = new Set((state.data as { ids: string[] }).ids);
    const changes = list
      .filter((e) => !have.has(e.id))
      .map((entry) => ({ kind: "create" as const, entry, match: entry.match }));
    return Promise.resolve({ accountId: this.accountId, changes, basedOn: state });
  }
  async apply(plan: Plan): Promise<ApplyResult> {
    await this.probe.hold(ROUND_MS);
    const ids = new Set((plan.basedOn.data as { ids: string[] }).ids);
    for (const change of plan.changes) ids.add(change.entry.id);
    return {
      applied: plan.changes.length,
      failed: [],
      state: { adapterId: "round", data: { ids: [...ids] } },
    };
  }
  verify(): Promise<Drift> {
    return Promise.resolve({
      drifted: false,
      detail: "",
      checkedAt: new Date().toISOString(),
      checks: [],
    });
  }
}

describe("one block fanned out to 50 accounts", () => {
  const run = async (maxConcurrent?: number): Promise<Probe> => {
    const probe = new Probe();
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, {
      timeoutMs: 2_000,
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    });
    for (let i = 0; i < MAX_ACCOUNTS; i += 1) {
      engine.addAccount({
        id: `acct${String(i)}`,
        adapter: new RoundAdapter(probe, `acct${String(i)}`),
        initialState: { adapterId: "round", data: { ids: [] } },
      });
    }
    const added = store.add({
      id: crypto.randomUUID(),
      match: "exactAddress",
      value: "spam@example.com",
      action: "junk",
      createdAt: new Date().toISOString(),
    });
    if (!added.ok) throw new Error("add failed");
    const outcomes = await engine.syncAll();
    engine.dispose();
    expect(outcomes.filter((o) => o.status !== "applied").slice(0, 1)).toEqual([]);
    return probe;
  };

  it("baseline with a gate as wide as the account cap runs all rounds at once", async () => {
    const probe = await run(MAX_ACCOUNTS);
    expect(probe.peak).toBe(MAX_ACCOUNTS);
  });

  it("default engine never exceeds MAX_CONCURRENT_SYNCS rounds and syncs everyone", async () => {
    const probe = await run();
    expect(probe.started).toBe(MAX_ACCOUNTS);
    expect(probe.peak).toBeLessThanOrEqual(MAX_CONCURRENT_SYNCS);
  });
});
