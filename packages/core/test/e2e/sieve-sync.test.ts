import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unblock } from "../../src/notify/unblock.js";
import { SieveAdapter, initialSieveState } from "../../src/sieve/adapter.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/store.js";
import { SyncEngine } from "../../src/sync/engine.js";
import { FakeSieveServer } from "../sieve/fake-server.js";

/** Real SieveAdapter + real Store (SQLite) + real SyncEngine; only the ManageSieve server is fake. */

const ACCOUNT = "contact@example.com";
let n = 0;
const entry = (match: string, value: string) => ({
  id: crypto.randomUUID(),
  match,
  value,
  action: "junk",
  createdAt: new Date(Date.UTC(2026, 9, 24, 12, 0, n++)).toISOString(),
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "senderban-e2e-"));
  dirs.push(dir);
  return join(dir, "senderban.db");
};

function boot(server: FakeSieveServer, file = ":memory:") {
  const store = new Store(openDatabase(file));
  const adapter = new SieveAdapter({
    accountId: ACCOUNT,
    connect: () => Promise.resolve(server.session()),
  });
  const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 1_000 });
  engine.addAccount({ id: ACCOUNT, adapter, initialState: initialSieveState() });
  return { store, adapter, engine };
}

describe("Sieve + Store + SyncEngine", () => {
  it("installs, updates and removes rules from the stored list, and verifies clean", async () => {
    const server = new FakeSieveServer();
    const { store, adapter, engine } = boot(server);
    const address = store.add(entry("exactAddress", "Spammer@Example.com"));
    store.add(entry("subdomains", "bulk.example"));
    if (!address.ok) throw new Error("add failed");

    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "applied", applied: 2 });
    const rules = server.scripts.get("senderban-rules") ?? "";
    expect(rules).toContain("spammer@example.com");
    expect(rules).toContain("*.bulk.example");
    expect(server.active).toBe("senderban-main");

    const state = store.getState(ACCOUNT);
    if (state === undefined) throw new Error("state was not stored");
    expect((await adapter.verify(state)).drifted).toBe(false);
    expect(await engine.sync(ACCOUNT)).toEqual({ accountId: ACCOUNT, status: "unchanged" });

    store.remove(address.entry.id);
    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "applied", applied: 1 });
    expect(server.scripts.get("senderban-rules")).not.toContain("spammer@example.com");
    expect(store.journal(ACCOUNT).map((r) => r.status)).toEqual(["applied", "applied"]);
  });

  it("unblock removes the rule from the provider, reads it back clean and leaves the other rules", async () => {
    const server = new FakeSieveServer();
    const { store, engine } = boot(server);
    const spammer = store.add(entry("exactAddress", "spammer@example.com"));
    store.add(entry("subdomains", "bulk.example"));
    if (!spammer.ok) throw new Error("add failed");
    await engine.sync(ACCOUNT);

    const result = await unblock({ store, engine, accountIds: [ACCOUNT] }, spammer.entry.id);
    expect(result).toEqual({
      status: "unblocked",
      accounts: [{ accountId: ACCOUNT, confirmed: true, detail: "read back from the provider" }],
    });
    const rules = server.scripts.get("senderban-rules") ?? "";
    expect(rules).not.toContain("spammer@example.com");
    expect(rules).toContain("*.bulk.example");
    expect(store.list().map((e) => e.value)).toEqual(["bulk.example"]);

    // the same click again finds nothing and does not sync
    expect(await unblock({ store, engine, accountIds: [ACCOUNT] }, spammer.entry.id)).toEqual({
      status: "unknown",
    });
  });

  it("a connection drop halfway leaves the remote half-written, and the next sync finishes it", async () => {
    const server = new FakeSieveServer();
    const { store, engine } = boot(server);
    store.add(entry("exactAddress", "a@example.com"));
    server.failSetActiveOnce = true; // rules script is put, then activating main fails

    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "failed", code: "TRANSIENT" });
    expect(server.scripts.has("senderban-rules")).toBe(true);
    expect(server.active).toBeNull();
    expect(store.journal(ACCOUNT)[0]?.status).toBe("interrupted");
    expect(store.getState(ACCOUNT)).toBeUndefined();

    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "applied" });
    expect(server.active).toBe("senderban-main");
    expect(store.journal(ACCOUNT)[0]?.status).toBe("applied");
  });

  it("recovers after the process dies between the provider write and completeSync", async () => {
    const server = new FakeSieveServer();
    const file = tempFile();

    // Process 1: intent journaled, provider written, then it dies before completeSync.
    const first = boot(server, file);
    first.store.add(entry("exactAddress", "a@example.com"));
    const plan = await first.adapter.plan(first.store.list(), initialSieveState());
    first.store.beginSync(plan);
    await first.adapter.apply(plan);
    first.store.close();
    const writtenRules = server.scripts.get("senderban-rules");
    expect(writtenRules).toContain("a@example.com");

    // Process 2: stored state is still the old one, yet the retry must not mistake our own write for a foreign edit.
    const second = boot(server, file);
    const [report] = await second.engine.recover();
    expect(report).toMatchObject({
      accountId: ACCOUNT,
      interrupted: 1,
      outcome: { status: "applied" },
      drift: { drifted: false },
    });
    expect(server.scripts.get("senderban-rules")).toBe(writtenRules);
    expect(second.store.getState(ACCOUNT)).toBeDefined();
    expect(await second.engine.recover()).toEqual([]);
    second.store.close();
  });

  it("refuses to overwrite a rules script someone else edited, and verify reports the drift", async () => {
    const server = new FakeSieveServer();
    const { store, adapter, engine } = boot(server);
    store.add(entry("exactAddress", "a@example.com"));
    await engine.sync(ACCOUNT);

    server.scripts.set("senderban-rules", "# edited by someone else\n");
    store.add(entry("exactAddress", "b@example.com"));
    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "failed", code: "REMOTE_CHANGED" });
    expect(server.scripts.get("senderban-rules")).toBe("# edited by someone else\n");

    const state = store.getState(ACCOUNT);
    if (state === undefined) throw new Error("state was not stored");
    expect((await adapter.verify(state)).drifted).toBe(true);
  });

  // Red-team KC-2: a round the engine timed out used to finish later and put its older list back.
  it("a round that outlives its deadline drops the connection and cannot write afterwards", async () => {
    const server = new FakeSieveServer();
    const store = new Store(openDatabase(":memory:"));
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sessions = 0;
    const adapter = new SieveAdapter({
      accountId: ACCOUNT,
      connect: () => {
        const session = server.session();
        sessions += 1;
        if (sessions > 1) return Promise.resolve(session);
        return Promise.resolve({
          ...session,
          // Stalls after the round read the remote, so its idea of the remote goes stale.
          haveSpace: async (name: string, size: number) => {
            await stalled;
            return session.haveSpace(name, size);
          },
        });
      },
    });
    const engine = new SyncEngine(store, {
      debounceMs: 5,
      timeoutMs: 250, // the second round must fit inside it even on a loaded CI machine
      retry: { baseMs: 600_000, maxMs: 600_000 },
    });
    engine.addAccount({ id: ACCOUNT, adapter, initialState: initialSieveState() });

    const first = store.add(entry("exactAddress", "a@example.com"));
    if (!first.ok) throw new Error("add failed");
    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "failed", code: "TRANSIENT" });
    expect(server.destroyed).toBe(1);

    // The person changes their mind; the next round (a fresh connection) writes the new list.
    store.remove(first.entry.id);
    store.add(entry("exactAddress", "b@example.com"));
    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "applied" });
    const written = server.scripts.get("senderban-rules");
    const putsAfterSecondRound = server.puts.length;
    expect(written).toContain("b@example.com");

    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(server.puts.length).toBe(putsAfterSecondRound);
    expect(server.scripts.get("senderban-rules")).toBe(written);
    engine.dispose();
    store.close();
  });

  it("reports QUOTA_EXCEEDED when the server has no room, without touching the remote", async () => {
    const server = new FakeSieveServer();
    server.maxScriptBytes = 10;
    const { store, engine } = boot(server);
    store.add(entry("exactAddress", "a@example.com"));
    expect(await engine.sync(ACCOUNT)).toMatchObject({ status: "failed", code: "QUOTA_EXCEEDED" });
    expect(server.scripts.size).toBe(0);
  });
});
