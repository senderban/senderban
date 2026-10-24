# 0002 — Local store: `node:sqlite`

Status: accepted (2026-10-24)

## Decision

The local blocklist, per-account provider state and the sync journal live in one SQLite file, opened
with the built-in `node:sqlite` module (`DatabaseSync`). No native npm module.

## Measurements (2026-10-24)

| What                         | Result                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Electron 45.0.0 bundles      | Node 24.22.0, ABI 150 (`releases.electronjs.org/releases.json`, released 2026-10-21)        |
| `node:sqlite` inside it      | loads, SQLite 3.53.4, `journal_mode=wal` accepted, `BEGIN IMMEDIATE` sets `isTransaction`   |
| How it was run               | `ELECTRON_RUN_AS_NODE=1 electron.exe` on the official zip (sha256 matches `SHASUMS256.txt`) |
| Main-process run             | NOT measured yet; same Node builtins, to be confirmed in Phase 5 with the real app          |
| Dev/CI Node                  | 24.14.1: same API, SQLite 3.51.2                                                            |
| `better-sqlite3` (not taken) | 13.0.3, native addon, needs a rebuild per Electron ABI                                      |

`node:sqlite` is "Stability 1.2 - Release candidate" in Node 24, no flag needed
([docs](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)). It is still a pre-stable API, so all
use is behind `packages/core/src/store/db.ts`; swapping the driver touches one file.

## Why not `better-sqlite3`

It would add a native build per Electron ABI to the installer and CI, and Electron 45 changes how
native addons see files inside ASAR archives
([Electron 45 blog](https://www.electronjs.org/blog/electron-45-0)). `node:sqlite` removes that
surface. Revisit if the API changes incompatibly before it is stable.

## Rules

- `defensive: true`, `foreign_keys=on`, `journal_mode=WAL`, `busy_timeout` set; schema version in
  `user_version`, migrations are forward-only and run inside one transaction.
- Every write that spans more than one statement runs in `BEGIN IMMEDIATE`.
- Single writer device (architecture K7): one app instance owns the file; the desktop shell takes
  Electron's single-instance lock (Phase 5).
- Rows read back are re-validated with the Zod schemas; a corrupt row is an error, not silently used.
- Journal is bounded: the last 200 finished rows per account are kept.
