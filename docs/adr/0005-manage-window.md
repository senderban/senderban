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

## Security

Same bar as the popup: sandboxed page, context isolation, no Node, CSP `default-src 'none'`,
navigation and `window.open` denied, every value set through `textContent` (sender addresses came
from mail headers and are untrusted). The preload exposes four calls. Main checks that the IPC sender
is the manage window showing our page; the entry id is re-parsed as a UUID before it reaches the
store; the seconds value is re-parsed with the core schema. The list sent to the page is the entries
only, never an account, password or provider state.

## Scale budget

- Per user (device): a person opens the window a few times a day; one list read = one `SELECT` on at
  most `MAX_ENTRIES` (5000) rows, sent once per open and after each unblock. Not polled.
- Unblock: 1 store write + N syncs + N verifies, N = accounts (at most `MAX_ACCOUNTS` = 50). At 10x
  (500 entries, 10 accounts) and 100x (5000 entries, 50 accounts) this is the same shape: the sync
  writes one whole rules script per account, which the Sieve measurement already bounds; no work
  grows with the number of devices because nothing here leaves the device.
- Shared resource: a provider connection per account, held only for the duration of its own sync.
  One account that hangs is cut by the engine's 60 s apply limit and does not delay the others.
- One unblock runs at a time (the button is disabled while it runs; main refuses a second while one is
  in flight), so a double click cannot start two sync rounds.
- No new timers, no background work, no network call to a paid service.

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
