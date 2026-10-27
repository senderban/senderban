import { z } from "zod";
import type { ApplyResult, OpaqueState, Plan } from "../adapter.js";
import { BlockEntrySchema, BlocklistSchema, MAX_ENTRIES, checkEntry } from "../blocklist.js";
import type { BlockEntry, Blocklist } from "../blocklist.js";
import type { Cursor, CursorStore } from "../watcher/watcher.js";
import { ACCOUNT_ID_MAX, UID_MAX, inTransaction, type Db } from "./db.js";

/** Failed changes kept in full in a journal row. Unit: failures. The row also holds the count of all of them. */
export const JOURNAL_FAILED_MAX = 20;

/** Finished journal rows kept per account; open ones are never pruned. */
export const JOURNAL_KEEP = 200;

export type AddResult =
  | { readonly ok: true; readonly entry: BlockEntry; readonly added: boolean }
  | { readonly ok: false; readonly reason: string };

export type SyncStatus = "pending" | "applied" | "partial" | "interrupted";

export interface JournalRow {
  readonly seq: number;
  readonly accountId: string;
  readonly adapterId: string;
  readonly status: SyncStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Planned changes while pending; a short summary once finished. */
  readonly detail: string | null;
}

const StateRowSchema = z.strictObject({
  adapterId: z.string().min(1).max(64),
  data: z.unknown(),
});

const CursorRowSchema = z.strictObject({
  accountId: z.string().min(1).max(ACCOUNT_ID_MAX),
  uidValidity: z.string().regex(/^\d{1,20}$/u),
  lastUid: z.number().int().min(0).max(UID_MAX),
});

const now = (): string => new Date().toISOString();

/** SQLite text columns arrive as `unknown`; anything else is a corrupt row. */
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("store row has a non-text column");
  return value;
}

/**
 * The device's single source of truth: block list, last known provider state per account and the
 * sync journal. A sync is `beginSync` -> adapter.apply -> `completeSync`; the journal row is written
 * before the provider is touched, so a crash in between is found by `recoverInterrupted` on start.
 */
export class Store {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  close(): void {
    this.#db.close();
  }

  // --- block list -----------------------------------------------------------------------------

  add(input: unknown): AddResult {
    const checked = checkEntry(input);
    if (!checked.ok) return checked;
    const entry = checked.entry;
    return inTransaction(this.#db, () => {
      const existing = this.#db
        .prepare("SELECT * FROM entries WHERE match = ? AND value = ?")
        .get(entry.match, entry.value);
      if (existing !== undefined) return { ok: true, entry: toEntry(existing), added: false };

      const count = Number(this.#db.prepare("SELECT count(*) AS n FROM entries").get()?.["n"]);
      if (count >= MAX_ENTRIES)
        return { ok: false, reason: `block list is full (${String(MAX_ENTRIES)})` };

      this.#db
        .prepare(
          "INSERT INTO entries (id, match, value, action, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(entry.id, entry.match, entry.value, entry.action, entry.createdAt);
      return { ok: true, entry, added: true };
    });
  }

  remove(id: string): boolean {
    return this.#db.prepare("DELETE FROM entries WHERE id = ?").run(id).changes > 0;
  }

  list(): Blocklist {
    const rows = this.#db.prepare("SELECT * FROM entries ORDER BY created_at, id").all();
    return BlocklistSchema.parse(rows.map(toEntry));
  }

  // --- provider state -------------------------------------------------------------------------

  getState(accountId: string): OpaqueState | undefined {
    const row = this.#db
      .prepare("SELECT adapter_id, data FROM account_state WHERE account_id = ?")
      .get(accountId);
    if (row === undefined) return undefined;
    return StateRowSchema.parse({
      adapterId: row["adapter_id"],
      data: JSON.parse(text(row["data"])) as unknown,
    });
  }

  setState(accountId: string, state: OpaqueState): void {
    writeState(this.#db, accountId, state);
  }

  // --- IMAP watcher cursor --------------------------------------------------------------------

  /** What the INBOX watcher persists so a restart does not forget which mail it already announced. */
  readonly cursors: CursorStore = {
    get: (accountId) => this.#getCursor(accountId),
    set: (accountId, cursor) => {
      this.#setCursor(accountId, cursor);
    },
  };

  #getCursor(accountId: string): Cursor | undefined {
    const row = this.#db
      .prepare("SELECT uid_validity, last_uid FROM imap_cursor WHERE account_id = ?")
      .get(accountId);
    if (row === undefined) return undefined;
    const parsed = CursorRowSchema.parse({
      accountId,
      uidValidity: row["uid_validity"],
      lastUid: row["last_uid"],
    });
    return { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid };
  }

  /** Throws on an invalid cursor. Within one UIDVALIDITY the stored UID never moves backwards. */
  #setCursor(accountId: string, cursor: Cursor): void {
    const checked = CursorRowSchema.parse({ accountId, ...cursor });
    this.#db
      .prepare(
        `INSERT INTO imap_cursor (account_id, uid_validity, last_uid, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, updated_at = excluded.updated_at
         WHERE excluded.uid_validity <> imap_cursor.uid_validity OR excluded.last_uid > imap_cursor.last_uid`,
      )
      .run(checked.accountId, checked.uidValidity, checked.lastUid, now());
  }

  // --- sync journal ---------------------------------------------------------------------------

  /** Records intent before the provider is written. Throws if this account already has a sync open. */
  beginSync(plan: Plan): number {
    const summary = plan.changes.map((c) => ({ kind: c.kind, id: c.entry.id, match: c.match }));
    const result = this.#db
      .prepare(
        "INSERT INTO sync_journal (account_id, adapter_id, plan, status, started_at) VALUES (?, ?, ?, 'pending', ?)",
      )
      .run(plan.accountId, plan.basedOn.adapterId, JSON.stringify(summary), now());
    return Number(result.lastInsertRowid);
  }

  /** Closes the journal row and stores the new provider state in one transaction. */
  completeSync(seq: number, accountId: string, result: ApplyResult): void {
    const status: SyncStatus = result.failed.length === 0 ? "applied" : "partial";
    // The first few failures in full and the count of all: a 500-entry failure is one row of a few hundred bytes, not 70 KB.
    const detail = JSON.stringify({
      applied: result.applied,
      failedCount: result.failed.length,
      failed: result.failed.slice(0, JOURNAL_FAILED_MAX).map((f) => ({
        entryId: f.entryId,
        code: f.error.code,
        message: f.error.message,
      })),
    });
    inTransaction(this.#db, () => {
      const closed = this.#db
        .prepare(
          "UPDATE sync_journal SET status = ?, plan = '', detail = ?, finished_at = ? WHERE seq = ? AND account_id = ? AND status = 'pending'",
        )
        .run(status, detail, now(), seq, accountId);
      if (closed.changes !== 1) throw new Error(`sync ${String(seq)} is not open for ${accountId}`);
      writeState(this.#db, accountId, result.state);
      this.#prune(accountId);
    });
  }

  /** The adapter threw before returning a result: close the row as interrupted, keep old state. */
  failSync(seq: number, accountId: string, reason: string): void {
    this.#db
      .prepare(
        "UPDATE sync_journal SET status = 'interrupted', plan = '', detail = ?, finished_at = ? WHERE seq = ? AND account_id = ? AND status = 'pending'",
      )
      .run(JSON.stringify({ reason: reason.slice(0, 500) }), now(), seq, accountId);
  }

  /**
   * Call once at start. Any row still `pending` belongs to a process that died mid-sync: the provider
   * may be half-written, so the caller must `verify`/re-plan those accounts before trusting the stored
   * state. Returns the rows that were interrupted.
   */
  recoverInterrupted(): readonly JournalRow[] {
    return inTransaction(this.#db, () => {
      const open = this.#db
        .prepare("SELECT * FROM sync_journal WHERE status = 'pending' ORDER BY seq")
        .all()
        .map(toJournalRow);
      this.#db
        .prepare(
          "UPDATE sync_journal SET status = 'interrupted', finished_at = ? WHERE status = 'pending'",
        )
        .run(now());
      return open.map((r) => ({ ...r, status: "interrupted" as const }));
    });
  }

  journal(accountId: string, limit = 50): readonly JournalRow[] {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), JOURNAL_KEEP);
    return this.#db
      .prepare("SELECT * FROM sync_journal WHERE account_id = ? ORDER BY seq DESC LIMIT ?")
      .all(accountId, capped)
      .map(toJournalRow);
  }

  #prune(accountId: string): void {
    this.#db
      .prepare(
        `DELETE FROM sync_journal WHERE account_id = ? AND status <> 'pending' AND seq NOT IN (
           SELECT seq FROM sync_journal WHERE account_id = ? AND status <> 'pending' ORDER BY seq DESC LIMIT ?)`,
      )
      .run(accountId, accountId, JOURNAL_KEEP);
  }
}

function writeState(db: Db, accountId: string, state: OpaqueState): void {
  db.prepare(
    `INSERT INTO account_state (account_id, adapter_id, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET adapter_id = excluded.adapter_id, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(accountId, state.adapterId, JSON.stringify(state.data ?? null), now());
}

function toEntry(row: Record<string, unknown>): BlockEntry {
  return BlockEntrySchema.parse({
    id: row["id"],
    match: row["match"],
    value: row["value"],
    action: row["action"],
    createdAt: row["created_at"],
  });
}

function toJournalRow(row: Record<string, unknown>): JournalRow {
  const detail = row["detail"] ?? row["plan"];
  return {
    seq: Number(row["seq"]),
    accountId: text(row["account_id"]),
    adapterId: text(row["adapter_id"]),
    status: row["status"] as SyncStatus,
    startedAt: text(row["started_at"]),
    finishedAt: row["finished_at"] === null ? null : text(row["finished_at"]),
    detail: detail === null || detail === "" ? null : text(detail),
  };
}
