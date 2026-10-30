# 0005 — Blocked-senders window, settings and unblock

Status: accepted (2026-10-25, Ali asked for a list screen, unblock and a visible app icon).
Builds on ADR 0004; the popup keeps its two block buttons.

## Decision

A normal framed window, "Blocked senders", opened from the tray menu and from the popup gear
(`apps/desktop/src/manage.ts`, page in `apps/desktop/assets/manage/`). One instance: a second request
focuses the open one. It holds two things:

- **The list.** Every entry of the device block list (`Store.list()`): the value, what it matches
  (this address / this domain and its subdomains), when it was added, and an [Unblock] button.
- **Settings.** The popup-seconds setting moves here from the popup (the popup gear now opens this
  window). Same limits and same single source, `POPUP_SECONDS`.

**Unblock** (`unblock()` in core, `notify/unblock.ts`) = `store.remove(id)`, then `engine.sync` on
**every** account at once (each account is its own lane; the plan holds one `remove`), then
`engine.verify` per account. The list is global, so a rule removed on one account only would come
back as drift. The result is per account: removed and read back, removed but not confirmed, or not
applied. An entry that is already gone answers `unknown` and touches no provider.

Why the store is the source of truth: the provider rule is derived from `senderban.db`, so the screen
reads the table and never the provider. Unblock does not need the mail client.

## Layout (2026-10-30)

The one page of three `<details>` became a side bar with two views, **Blocked senders** and **Accounts**, plus **Add mailbox**. Still
one window, one page and no new `BrowserWindow`. Questions stay in the main process's own dialog, not in the page: the page can neither
draw that box nor click it, which holds against a page that was taken over. Replies of a step share one line above the views, so a step
that moves to another view does not lose what it reported. Restart is one bar, driven by `manage:status`.

`manage:status` reads the account file and the watcher states in memory, no provider. `manage:status-changed` is a signal without a
payload, at most one per 500 ms while the window is open and none when it is closed. `manage:pause` takes a boolean, runs one at a time
in the window and counts as a step, so a restart waits for it. The tray has no such guard and needs none: `applyPause` changes every
watcher in one synchronous step, so the later click decides, and only logouts are waited for, together (at most 5 s, `LOGOUT_TIMEOUT_MS`).
A halted account stays halted through Pause and Resume (ADR 0003); only a sign-in or a restart sends the password again.

The list says what the last sync reported, not what was asked: `applied` is "unknown" while a lane that carries the entry is behind, and
`atServer` is true only when a running MXroute lane holds the address. `manage:status` names the mailboxes that are behind.

## Security

Same bar as the popup: sandboxed page, context isolation, no Node, CSP `default-src 'none'`,
navigation and `window.open` denied, every value set through `textContent` (sender addresses came
from mail headers and are untrusted). The preload exposes four calls. Main checks that the IPC sender
is the manage window showing our page; the entry id is re-parsed as a UUID before it reaches the
store; the seconds value is re-parsed with the core schema. The list sent to the page is the entries
only, never an account, password or provider state.

## Scale budget

- Per user (device): a person opens the window a few times a day; one list read = one `SELECT` on at
  most `MAX_ENTRIES` (5000) rows, sent once per open and after each unblock. Not polled. The status is
  pushed: at most 2 signals a second while the window is open, 177 B at 1 account, 1,140 B at 10 and
  5,420 B at 50 (measured 2026-10-30), 0 provider requests. A list with a `reject` entry also needs each
  running MXroute lane's addresses: one read costs 9-26 ms at 5,000 entries (0.5 s at 50 lanes, measured
  2026-10-30), so they are kept per lane until the lane's next round: one set per running lane, 22 MB at
  most at that size, 15 ms or less for a warm read. Background rounds redraw the open list at most once
  per 5 s (41 ms and 1.1 MB at that size, measured 2026-10-31); nothing runs with the window closed.
- Pause and Resume: a click, never a timer. Resume costs one IMAP login per running account (1 / 10 / 50)
  through the gate of 5, about 20 s at 50 and 150 logins a minute at most, and 0 for a halted account.
  Pause costs one logout per account, together, 5 s at most. One `pause` line a click, about 150
  `watcher` lines a cycle at 50 accounts.
- Unblock: 1 store write + N syncs + N verifies, N = accounts (at most `MAX_ACCOUNTS` = 50). At 10x
  (500 entries, 10 accounts) and 100x (5000 entries, 50 accounts) this is the same shape: the sync
  writes one whole rules script per account, which the Sieve measurement already bounds; no work
  grows with the number of devices because nothing here leaves the device.
- Shared resource: a provider connection per account, held only for the duration of its own sync.
  One account that hangs is cut by the engine's 60 s apply limit and does not delay the others.
- One unblock runs at a time (the button is disabled while it runs; main refuses a second while one is
  in flight), so a double click cannot start two sync rounds.
- One one-shot 500 ms timer for the status signal, cleared when the window closes. No other background
  work, no network call to a paid service.

## Icon

A real application icon is generated from `apps/desktop/scripts/make-icons.mjs` (pure Node, no image
dependency) into `assets/icon.ico` (16/32/48/256, PNG-compressed) and `assets/icon.png`. It is used
for the tray, the popup header and the manage window (so the taskbar button shows it). The exe icon
of the dev `electron.exe` stays Electron's until there is a packaged build; that is not measured here.

## Not in this decision

Editing an entry, adding a sender by typing, importing/exporting the list, a Trash action (K7), and
showing per-account sync state. Each is a separate decision.

## Measured (2026-10-25, Windows 11, Electron 45.0.0, throwaway harness with fake handlers)

Real `ManageWindow` and `Popups` from `dist`, driven through the page DOM: two `show()` calls open one
window; three entries drawn (a hostile `<img onerror>` sender stays text, 0 injected elements); the
filter narrows; during an unblock every button is disabled and a second `manage:unblock` is refused
(handler ran once); a non-UUID id, seconds 99 / 2 / `"5"` are refused in main, 5 is saved, 99 is
stopped by the page before IPC; `manage:changed` refreshes the list; the popup gear calls
`openSettings` without opening a second window and the popup has no settings panel; the empty state
shows; `icon.ico` loads (256 px). The real app starts with a fresh userData and no accounts.
Core: `unblock` unit tests and an end-to-end test (real Store + SyncEngine + fake ManageSieve) show the
rule leaves the provider script, the other rules stay, and a second click finds nothing.

NOT measured: a real unblock against a live MXroute mailbox; the taskbar button and tray icon at real
DPI; the second-instance path (starting the exe again opens the window); the exe icon (packaged build).
