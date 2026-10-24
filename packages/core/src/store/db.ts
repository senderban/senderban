import { DatabaseSync } from "node:sqlite";
import { MATCH_KINDS, ACTIONS } from "../blocklist.js";

export type Db = DatabaseSync;

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(",");

/** Forward-only. Index i is the migration that takes `user_version` from i to i + 1. */
const MIGRATIONS: readonly string[] = [
  `
  create table entries (
    id         text primary key,
    match      text not null check (match in (${list(MATCH_KINDS)})),
    value      text not null,
    action     text not null check (action in (${list(ACTIONS)})),
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
      throw new Error(`store schema ${current} is newer than this build (${SCHEMA_VERSION})`);
    }
    if (current < SCHEMA_VERSION) {
      inTransaction(db, () => {
        for (let v = current; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
