import { DatabaseSync } from "node:sqlite";
import { MATCH_KINDS } from "../blocklist.js";

export type Db = DatabaseSync;

/** Bounds shared by the cursor schema (store.ts) and its table constraints, so they cannot drift. */
export const ACCOUNT_ID_MAX = 128;
export const UID_MAX = 4_294_967_295;
/** A Gmail `historyId` is a decimal uint64: 20 digits at most (same bound as `HISTORY_ID` in gmail/mail-client.ts). Unit: digits. */
export const HISTORY_ID_DIGITS_MAX = 20;

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(",");

// Frozen per migration: a migration must produce the same table whatever ACTIONS says today.
const ACTIONS_V1 = ["junk", "trash"] as const;
const ACTIONS_V3 = ["junk", "trash", "reject"] as const;

/** Forward-only. Index i is the migration that takes `user_version` from i to i + 1. */
const MIGRATIONS: readonly string[] = [
  `
  create table entries (
    id         text primary key,
    match      text not null check (match in (${list(MATCH_KINDS)})),
    value      text not null,
    action     text not null check (action in (${list(ACTIONS_V1)})),
    created_at text not null,
    unique (match, value)
  ) strict;

  create table account_state (
    account_id text primary key,
    adapter_id text not null,
    data       text not null,
    updated_at text not null
  ) strict;

  create table sync_journal (
    seq         integer primary key autoincrement,
    account_id  text not null,
    adapter_id  text not null,
    plan        text not null,
    status      text not null check (status in ('pending','applied','partial','interrupted')),
    started_at  text not null,
    finished_at text,
    detail      text
  ) strict;
  create unique index sync_journal_one_pending on sync_journal (account_id) where status = 'pending';
  `,
  // One row per watched account (<= MAX_ACCOUNTS). UIDVALIDITY and UID are unsigned 32-bit (RFC 9051 2.3.1.1).
  `
  create table imap_cursor (
    account_id   text primary key check (length(account_id) between 1 and ${String(ACCOUNT_ID_MAX)}),
    uid_validity text not null check (length(uid_validity) between 1 and 20 and uid_validity not glob '*[^0-9]*'),
    last_uid     integer not null check (last_uid between 0 and ${String(UID_MAX)}),
    updated_at   text not null
  ) strict;
  `,
  // `reject` joins the actions. SQLite cannot change a CHECK in place, so the table is rebuilt (rows copied as they are).
  `
  create table entries_v3 (
    id         text primary key,
    match      text not null check (match in (${list(MATCH_KINDS)})),
    value      text not null,
    action     text not null check (action in (${list(ACTIONS_V3)})),
    created_at text not null,
    unique (match, value)
  ) strict;
  insert into entries_v3 (id, match, value, action, created_at)
    select id, match, value, action, created_at from entries;
  drop table entries;
  alter table entries_v3 rename to entries;
  `,
  // One row per Gmail account being watched (<= MAX_ACCOUNTS). A `historyId` is a decimal uint64 (Gmail API), kept as text because
  // it outgrows a double: 1 to 20 digits, nothing else. Written only when it changes, so an idle mailbox writes nothing.
  `
  create table gmail_cursor (
    account_id text primary key check (length(account_id) between 1 and ${String(ACCOUNT_ID_MAX)}),
    history_id text not null check (length(history_id) between 1 and ${String(HISTORY_ID_DIGITS_MAX)} and history_id not glob '*[^0-9]*'),
    updated_at text not null
  ) strict;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Runs `fn` in a write transaction (`BEGIN IMMEDIATE`); rolls back if it throws. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function userVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"] ?? 0);
}

/** Opens (and migrates) the store. `":memory:"` is allowed for tests. */
export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path, { defensive: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

    const current = userVersion(db);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `store schema ${String(current)} is newer than this build (${String(SCHEMA_VERSION)})`,
      );
    }
    if (current < SCHEMA_VERSION) {
      inTransaction(db, () => {
        for (let v = current; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
