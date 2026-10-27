import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import type { ApplyResult, OpaqueState, Plan } from "../../src/adapter.js";
import { MAX_ENTRIES } from "../../src/blocklist.js";
import { SCHEMA_VERSION, openDatabase } from "../../src/store/db.js";
import { JOURNAL_FAILED_MAX, JOURNAL_KEEP, Store } from "../../src/store/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "senderban-store-"));
  dirs.push(dir);
  return join(dir, "senderban.db");
};

let counter = 0;
const entry = (value: string, match = "exactAddress") => ({
  id: crypto.randomUUID(),
  match,
  value,
  action: "junk",
  createdAt: new Date(Date.UTC(2026, 9, 24, 12, 0, counter++)).toISOString(),
});

const state = (data: unknown): OpaqueState => ({ adapterId: "sieve", data });
const planFor = (accountId: string, store: Store): Plan => ({
  accountId,
  changes: store.list().map((e) => ({ kind: "create" as const, entry: e, match: e.match })),
  basedOn: state({ v: 0 }),
});
const ok = (data: unknown): ApplyResult => ({ applied: 1, failed: [], state: state(data) });

describe("block list", () => {
  it("adds, dedups on (match, value) and normalises", () => {
    const store = new Store(openDatabase(":memory:"));
    const first = store.add(entry("Spam@Example.com"));
    expect(first.ok && first.added).toBe(true);
    const again = store.add(entry("spam@example.com"));
    expect(again.ok && !again.added).toBe(true);
    expect(store.list().map((e) => e.value)).toEqual(["spam@example.com"]);
  });

  it("applies the same semantic rules as checkEntry", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(store.add(entry("gmail.com", "exactDomain")).ok).toBe(false);
    expect(store.add({ ...entry("a@example.com"), action: "discard" }).ok).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("refuses entries past MAX_ENTRIES", () => {
    const store = new Store(openDatabase(":memory:"));
    for (let i = 0; i < MAX_ENTRIES; i++) {
      expect(store.add(entry(`u${String(i)}@example.com`)).ok).toBe(true);
    }
    expect(store.add(entry("one-too-many@example.com")).ok).toBe(false);
  });

  it("removes by id and survives reopen", () => {
    const file = tempFile();
    const a = new Store(openDatabase(file));
    const added = a.add(entry("keep@example.com"));
    const dropped = a.add(entry("drop@example.com"));
    if (!added.ok || !dropped.ok) throw new Error("add failed");
    expect(a.remove(dropped.entry.id)).toBe(true);
    expect(a.remove(dropped.entry.id)).toBe(false);
    a.close();

    const b = new Store(openDatabase(file));
    expect(b.list().map((e) => e.value)).toEqual(["keep@example.com"]);
    b.close();
  });
});

describe("database", () => {
  it("is defensive: ordinary SQL cannot corrupt the schema", () => {
    const db = openDatabase(":memory:");
    expect(() => {
      db.exec("PRAGMA writable_schema = ON");
      db.exec("UPDATE sqlite_master SET sql = 'x' WHERE name = 'entries'");
    }).toThrow();
    db.close();
  });

  it("refuses a store written by a newer build", () => {
    const file = tempFile();
    const db = openDatabase(file);
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    db.close();
    expect(() => openDatabase(file)).toThrow(/newer/);
  });

  it("rejects a corrupt row instead of using it", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "INSERT INTO entries VALUES ('not-a-uuid', 'exactAddress', 'a@example.com', 'junk', '2026-10-24T12:00:00.000Z')",
    );
    expect(() => new Store(db).list()).toThrow();
  });
});

describe("watcher cursors", () => {
  it("survives a restart, per account", () => {
    const file = tempFile();
    const a = new Store(openDatabase(file));
    expect(a.cursors.get("acct")).toBeUndefined();
    a.cursors.set("acct", { uidValidity: "1700000000", lastUid: 41 });
    a.cursors.set("other", { uidValidity: "9", lastUid: 2 });
    a.close();

    const b = new Store(openDatabase(file));
    expect(b.cursors.get("acct")).toEqual({ uidValidity: "1700000000", lastUid: 41 });
    expect(b.cursors.get("other")).toEqual({ uidValidity: "9", lastUid: 2 });
    b.close();
  });

  it("never moves backwards within one UIDVALIDITY, but follows a renumbered mailbox", () => {
    const store = new Store(openDatabase(":memory:"));
    store.cursors.set("acct", { uidValidity: "7", lastUid: 50 });
    store.cursors.set("acct", { uidValidity: "7", lastUid: 10 });
    expect(store.cursors.get("acct")).toEqual({ uidValidity: "7", lastUid: 50 });

    store.cursors.set("acct", { uidValidity: "8", lastUid: 3 });
    expect(store.cursors.get("acct")).toEqual({ uidValidity: "8", lastUid: 3 });
  });

  it("rejects values outside the IMAP unit range", () => {
    const store = new Store(openDatabase(":memory:"));
    const bad = [
      { uidValidity: "", lastUid: 1 },
      { uidValidity: "12ab", lastUid: 1 },
      { uidValidity: "1".repeat(21), lastUid: 1 },
      { uidValidity: "1", lastUid: -1 },
      { uidValidity: "1", lastUid: 4_294_967_296 },
      { uidValidity: "1", lastUid: 1.5 },
    ];
    for (const cursor of bad)
      expect(() => {
        store.cursors.set("acct", cursor);
      }).toThrow();
    expect(() => {
      store.cursors.set("", { uidValidity: "1", lastUid: 1 });
    }).toThrow();
    expect(() => {
      store.cursors.set("x".repeat(129), { uidValidity: "1", lastUid: 1 });
    }).toThrow();
    expect(store.cursors.get("acct")).toBeUndefined();
  });

  it("migrates a version-1 store without losing the list", () => {
    const file = tempFile();
    const first = openDatabase(file);
    new Store(first).add(entry("keep@example.com"));
    first.exec("DROP TABLE imap_cursor");
    first.exec("DROP TABLE gmail_cursor");
    first.exec("PRAGMA user_version = 1");
    first.close();

    const upgraded = new Store(openDatabase(file));
    expect(upgraded.list().map((e) => e.value)).toEqual(["keep@example.com"]);
    upgraded.cursors.set("acct", { uidValidity: "1", lastUid: 1 });
    expect(upgraded.cursors.get("acct")).toEqual({ uidValidity: "1", lastUid: 1 });
    upgraded.close();
  });
});

describe("Gmail watcher cursors", () => {
  it("survives a restart, per account, and keeps a value above a double's range exact", () => {
    const file = tempFile();
    const a = new Store(openDatabase(file));
    expect(a.gmailCursors.get("acct")).toBeUndefined();
    a.gmailCursors.set("acct", "18446744073709551615");
    a.gmailCursors.set("other", "3434158");
    a.close();

    const b = new Store(openDatabase(file));
    expect(b.gmailCursors.get("acct")).toBe("18446744073709551615");
    expect(b.gmailCursors.get("other")).toBe("3434158");
    b.close();
  });

  it("writes only when the value changes, and may move backwards (a future cursor is replaced)", () => {
    const db = openDatabase(":memory:");
    const store = new Store(db);
    store.gmailCursors.set("acct", "500");
    db.exec("UPDATE gmail_cursor SET updated_at = 'sentinel'");
    store.gmailCursors.set("acct", "500");
    expect(db.prepare("SELECT updated_at FROM gmail_cursor").get()?.["updated_at"]).toBe(
      "sentinel",
    );

    store.gmailCursors.set("acct", "100");
    expect(store.gmailCursors.get("acct")).toBe("100");
    expect(db.prepare("SELECT updated_at FROM gmail_cursor").get()?.["updated_at"]).not.toBe(
      "sentinel",
    );
  });

  it("rejects a value outside the historyId unit range, in the schema and in the table", () => {
    const db = openDatabase(":memory:");
    const store = new Store(db);
    for (const bad of ["", "12ab", "-1", " 1", "1.5", "1".repeat(21), "٣"]) {
      expect(() => {
        store.gmailCursors.set("acct", bad);
      }).toThrow();
    }
    expect(() => {
      store.gmailCursors.set("", "1");
    }).toThrow();
    expect(() => {
      store.gmailCursors.set("x".repeat(129), "1");
    }).toThrow();
    expect(store.gmailCursors.get("acct")).toBeUndefined();
    // The table says the same on its own: a row that skipped the schema is refused too.
    for (const bad of ["", "12ab", "1".repeat(21)]) {
      expect(() => db.prepare("INSERT INTO gmail_cursor VALUES ('a', ?, 'x')").run(bad)).toThrow(
        /CHECK/,
      );
    }
  });

  it("reads a row that does not fit the bounds as no cursor, and the next set replaces it", () => {
    const db = openDatabase(":memory:");
    const store = new Store(db);
    // The table's CHECK refuses such a row; it is switched off here only to plant one.
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.exec("INSERT INTO gmail_cursor VALUES ('acct', 'not-digits', 'x')");
    db.exec("PRAGMA ignore_check_constraints = OFF");
    expect(store.gmailCursors.get("acct")).toBeUndefined();
    store.gmailCursors.set("acct", "42");
    expect(store.gmailCursors.get("acct")).toBe("42");
  });

  it("deletes one account's row and no other", () => {
    const store = new Store(openDatabase(":memory:"));
    store.gmailCursors.set("a", "1");
    store.gmailCursors.set("b", "2");
    store.gmailCursors.delete("a");
    store.gmailCursors.delete("never-there");
    expect(store.gmailCursors.get("a")).toBeUndefined();
    expect(store.gmailCursors.get("b")).toBe("2");
  });

  it("migrates a version-3 store without losing the list", () => {
    const file = tempFile();
    const first = openDatabase(file);
    new Store(first).add(entry("keep@example.com"));
    first.exec("DROP TABLE gmail_cursor");
    first.exec("PRAGMA user_version = 3");
    first.close();

    const upgraded = new Store(openDatabase(file));
    expect(upgraded.list().map((e) => e.value)).toEqual(["keep@example.com"]);
    upgraded.gmailCursors.set("acct", "7");
    expect(upgraded.gmailCursors.get("acct")).toBe("7");
    upgraded.close();
  });
});

describe("reject action", () => {
  it("migrates a version-2 store (Junk and Trash only) and then accepts reject without losing the list", () => {
    const file = tempFile();
    const first = openDatabase(file);
    new Store(first).add(entry("keep@example.com"));
    // What a version-2 database looks like: the old CHECK, no `reject`.
    first.exec("ALTER TABLE entries RENAME TO entries_now");
    first.exec(`CREATE TABLE entries (
      id text primary key, match text not null check (match in ('exactAddress','exactDomain','subdomains')),
      value text not null, action text not null check (action in ('junk','trash')),
      created_at text not null, unique (match, value)) strict`);
    first.exec("INSERT INTO entries SELECT * FROM entries_now");
    first.exec("DROP TABLE entries_now");
    first.exec("DROP TABLE gmail_cursor");
    first.exec("PRAGMA user_version = 2");
    first.close();

    const upgraded = new Store(openDatabase(file));
    expect(upgraded.list().map((e) => e.value)).toEqual(["keep@example.com"]);
    const added = upgraded.add({ ...entry("refuse@example.com"), action: "reject" });
    expect(added).toMatchObject({ ok: true, added: true });
    expect(upgraded.list().map((e) => e.action)).toEqual(["junk", "reject"]);
    upgraded.close();
  });

  it("still refuses an action the schema does not know", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(store.add({ ...entry("x@example.com"), action: "discard" }).ok).toBe(false);
  });
});

describe("sync journal", () => {
  it("writes intent before the provider is touched and closes it with the new state", () => {
    const store = new Store(openDatabase(":memory:"));
    store.add(entry("a@example.com"));
    const seq = store.beginSync(planFor("acct", store));
    expect(store.journal("acct")[0]?.status).toBe("pending");

    store.completeSync(seq, "acct", ok({ v: 1 }));
    expect(store.journal("acct")[0]).toMatchObject({ status: "applied", seq });
    expect(store.getState("acct")).toEqual(state({ v: 1 }));
  });

  it("allows one open sync per account, not per store", () => {
    const store = new Store(openDatabase(":memory:"));
    store.beginSync(planFor("a", store));
    expect(() => store.beginSync(planFor("a", store))).toThrow();
    expect(() => store.beginSync(planFor("b", store))).not.toThrow();
  });

  it("records partial failures and keeps the state the adapter returned", () => {
    const store = new Store(openDatabase(":memory:"));
    const seq = store.beginSync(planFor("acct", store));
    store.completeSync(seq, "acct", {
      applied: 1,
      failed: [{ entryId: "e1", error: new AdapterError("QUOTA_EXCEEDED", "full") }],
      state: state({ v: 2 }),
    });
    const row = store.journal("acct")[0];
    expect(row?.status).toBe("partial");
    const detail = JSON.parse(row?.detail ?? "{}") as { failed: unknown[] };
    expect(detail.failed[0]).toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("keeps a journal row small when a round fails for hundreds of changes: the first few in full, and the count of all", () => {
    const store = new Store(openDatabase(":memory:"));
    const seq = store.beginSync(planFor("acct", store));
    store.completeSync(seq, "acct", {
      applied: 0,
      failed: Array.from({ length: 500 }, (_, i) => ({
        entryId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        error: new AdapterError(
          "TRANSIENT",
          "Senderban's own Gmail limit is reached (minute), later",
        ),
      })),
      state: state({ v: 2 }),
    });
    const detail = store.journal("acct")[0]?.detail ?? "";
    const parsed = JSON.parse(detail) as { failedCount: number; failed: unknown[] };
    expect(parsed.failedCount).toBe(500);
    expect(parsed.failed).toHaveLength(JOURNAL_FAILED_MAX);
    expect(detail.length).toBeLessThan(5_000);
  });

  it("does not move the state when the sync is not open", () => {
    const store = new Store(openDatabase(":memory:"));
    const seq = store.beginSync(planFor("acct", store));
    store.completeSync(seq, "acct", ok({ v: 1 }));
    expect(() => {
      store.completeSync(seq, "acct", ok({ v: 99 }));
    }).toThrow(/not open/);
    expect(store.getState("acct")).toEqual(state({ v: 1 }));
  });

  it("finds a sync left open by a crash and marks it interrupted on the next start", () => {
    const file = tempFile();
    const first = new Store(openDatabase(file));
    first.add(entry("a@example.com"));
    first.setState("acct", state({ v: 1 }));
    first.beginSync(planFor("acct", first));
    first.close(); // process "dies": no completeSync

    const second = new Store(openDatabase(file));
    const found = second.recoverInterrupted();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ accountId: "acct", status: "interrupted" });
    expect(second.getState("acct")).toEqual(state({ v: 1 })); // old state kept until re-verified
    expect(second.recoverInterrupted()).toEqual([]);
    expect(() => second.beginSync(planFor("acct", second))).not.toThrow();
    second.close();
  });

  it("failSync closes an open row without touching state", () => {
    const store = new Store(openDatabase(":memory:"));
    store.setState("acct", state({ v: 1 }));
    const seq = store.beginSync(planFor("acct", store));
    store.failSync(seq, "acct", "connection reset");
    expect(store.journal("acct")[0]?.status).toBe("interrupted");
    expect(store.getState("acct")).toEqual(state({ v: 1 }));
  });

  it("keeps the journal bounded and never prunes an open row", () => {
    const store = new Store(openDatabase(":memory:"));
    for (let i = 0; i < JOURNAL_KEEP + 25; i++) {
      store.completeSync(store.beginSync(planFor("acct", store)), "acct", ok({ v: i }));
    }
    const open = store.beginSync(planFor("acct", store));
    const rows = store.journal("acct", JOURNAL_KEEP);
    expect(rows.length).toBe(JOURNAL_KEEP);
    expect(rows[0]).toMatchObject({ seq: open, status: "pending" });
    store.completeSync(open, "acct", ok({ v: -1 }));
    const kept = store.journal("acct", JOURNAL_KEEP);
    expect(kept.length).toBe(JOURNAL_KEEP);
    expect(kept.every((r) => r.status === "applied")).toBe(true);
  });
});
