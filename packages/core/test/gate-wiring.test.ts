// What the gate must keep true where it is wired in: deadlines free slots, stale waiters open nothing,
// a disposed engine starts no new provider work, and verify is gated like sync.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApplyResult,
  BlockAdapter,
  Capabilities,
  Drift,
  OpaqueState,
  Plan,
} from "../src/adapter.js";
import type { Blocklist } from "../src/blocklist.js";
import { createGate } from "../src/gate.js";
import { openDatabase } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { SyncEngine } from "../src/sync/engine.js";
import { AccountWatcher, CONNECT_SLOT_MS } from "../src/watcher/watcher.js";
import type { Cursor, CursorStore, MailboxSession } from "../src/watcher/watcher.js";

const idleSession = (onClose: () => void = () => undefined): MailboxSession => ({
  uidValidity: "1",
  uidNext: 1,
  fetchSince: () => Promise.resolve([]),
  onExists: () => undefined,
  onClose: () => undefined,
  close: () => {
    onClose();
    return Promise.resolve();
  },
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

describe("watcher login gate", () => {
  const watchers: AccountWatcher[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await Promise.all(watchers.splice(0).map((w) => w.stop()));
    vi.useRealTimers();
  });

  const make = (
    id: string,
    connect: (signal?: AbortSignal) => Promise<MailboxSession>,
    gate = createGate(1),
  ) => {
    const watcher = new AccountWatcher({
      accountId: id,
      cursors: cursors(),
      gate,
      connect,
      onMessage: () => undefined,
    });
    watchers.push(watcher);
    return watcher;
  };

  it("frees the slot at the deadline and closes a session that arrives late", async () => {
    const gate = createGate(1);
    let closed = 0;
    let finishFirst: (s: MailboxSession) => void = () => undefined;
    const first = make(
      "a",
      () =>
        new Promise<MailboxSession>((resolve) => {
          finishFirst = resolve;
        }),
      gate,
    );
    const secondConnect = vi.fn(() => Promise.resolve(idleSession()));
    const second = make("b", secondConnect, gate);
    first.start();
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondConnect).not.toHaveBeenCalled(); // waits behind the stuck login

    await vi.advanceTimersByTimeAsync(CONNECT_SLOT_MS);
    expect(first.current).toBe("backoff");
    expect(secondConnect).toHaveBeenCalledTimes(1);
    expect(second.current).toBe("watching");

    finishFirst(idleSession(() => (closed += 1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(1); // the late session is not leaked
  });

  // Pre-push performance review W2: freeing the slot must also free the socket, or a provider-wide stall holds 5x the cap.
  it("aborts the login's signal when it passes the slot deadline, and only then", async () => {
    let seen: AbortSignal | undefined;
    const watcher = make("a", (signal) => {
      seen = signal;
      return new Promise<MailboxSession>(() => undefined);
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(CONNECT_SLOT_MS - 1);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.aborted).toBe(true);
  });

  it("opens no login for a waiter that reconnectNow replaced while it was queued", async () => {
    const gate = createGate(1);
    let finishFirst: (s: MailboxSession) => void = () => undefined;
    const first = make(
      "a",
      () =>
        new Promise<MailboxSession>((resolve) => {
          finishFirst = resolve;
        }),
      gate,
    );
    const secondConnect = vi.fn(() => Promise.resolve(idleSession()));
    const second = make("b", secondConnect, gate);
    first.start();
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    second.reconnectNow(); // the first waiter is now stale, a new one queues behind it

    finishFirst(idleSession());
    await vi.advanceTimersByTimeAsync(0);
    expect(secondConnect).toHaveBeenCalledTimes(1);
    expect(second.current).toBe("watching");
  });
});

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

/** Verifies in flight across all adapters of the test. */
const verifies = { running: 0, peak: 0 };

class TestAdapter implements BlockAdapter {
  readonly id = "test";
  planHangs = false;
  applyCalls = 0;
  applyGate: Promise<void> | null = null;
  constructor(private readonly accountId: string) {}
  capabilities(): Capabilities {
    return NONE;
  }
  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    if (this.planHangs) return new Promise<Plan>(() => undefined);
    const have = new Set((state.data as { ids: string[] }).ids);
    const changes = list
      .filter((e) => !have.has(e.id))
      .map((entry) => ({ kind: "create" as const, entry, match: entry.match }));
    return Promise.resolve({ accountId: this.accountId, changes, basedOn: state });
  }
  async apply(plan: Plan): Promise<ApplyResult> {
    this.applyCalls += 1;
    if (this.applyGate !== null) await this.applyGate;
    const ids = new Set((plan.basedOn.data as { ids: string[] }).ids);
    for (const change of plan.changes) ids.add(change.entry.id);
    return {
      applied: plan.changes.length,
      failed: [],
      state: { adapterId: "test", data: { ids: [...ids] } },
    };
  }
  async verify(): Promise<Drift> {
    verifies.running += 1;
    verifies.peak = Math.max(verifies.peak, verifies.running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    verifies.running -= 1;
    return { drifted: false, detail: "", checkedAt: new Date().toISOString(), checks: [] };
  }
}

function setup(accountCount: number, options: ConstructorParameters<typeof SyncEngine>[1] = {}) {
  const store = new Store(openDatabase(":memory:"));
  const engine = new SyncEngine(store, { timeoutMs: 40, maxConcurrent: 1, ...options });
  const adapters: TestAdapter[] = [];
  for (let i = 0; i < accountCount; i += 1) {
    const adapter = new TestAdapter(`acct${String(i)}`);
    adapters.push(adapter);
    engine.addAccount({
      id: `acct${String(i)}`,
      adapter,
      initialState: { adapterId: "test", data: { ids: [] } },
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
  return { engine, adapters };
}

describe("engine gate", () => {
  it("a plan that never answers fails at the timeout and frees the slot for the next account", async () => {
    const { engine, adapters } = setup(2);
    const [stuck, fine] = adapters;
    if (stuck === undefined || fine === undefined) throw new Error("setup");
    stuck.planHangs = true;
    const [first, second] = await engine.syncAll();
    engine.dispose();
    expect(first).toMatchObject({ accountId: "acct0", status: "failed", code: "TRANSIENT" });
    expect(second).toMatchObject({ accountId: "acct1", status: "applied" });
  });

  it("starts no provider round after dispose for syncs still waiting for a slot", async () => {
    const { engine, adapters } = setup(10);
    let release: () => void = () => undefined;
    const first = adapters[0];
    if (first === undefined) throw new Error("setup");
    first.applyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const all = engine.syncAll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.dispose();
    release();
    await all;
    expect(adapters.reduce((sum, a) => sum + a.applyCalls, 0)).toBe(1);
  });

  it("gates verify like sync", async () => {
    verifies.peak = 0;
    const { engine } = setup(3);
    const results = await Promise.all(["acct0", "acct1", "acct2"].map((id) => engine.verify(id)));
    engine.dispose();
    expect(results.every((r) => r.status === "verified")).toBe(true);
    expect(verifies.peak).toBe(1);
  });
});
