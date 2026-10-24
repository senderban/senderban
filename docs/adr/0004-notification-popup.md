# 0004 — Notification popup replaces the native Windows toast

Status: accepted (2026-10-25, Ali). Supersedes the notification part of ADR 0003; the watcher, store
and sync decisions there stand.

## Decision

A new-mail announcement is a small frameless, always-on-top Electron window in the bottom-right
corner (`apps/desktop/src/popups.ts`, page in `apps/desktop/assets/popup/`), not a native toast.

Why: the native toast cannot carry a settings gear, a second button laid out by us, or an in-place
status change; on a dev run it also showed "Electron" as its title. A window gives full control.

- **Two buttons.** [Block sender] (`exactAddress`) and [Block `<domain>`] (`subdomains`: the domain and
  everything under it). The domain button is not offered when `blockableDomain()` returns null (a
  freemail provider or an invalid domain); the block list refuses the same input, so hiding is a courtesy.
  The domain is the sender's own domain, not a registrable-domain guess: there is no Public Suffix List
  in the core yet (`freemail.ts` note).
- **In-place result.** The same popup goes Blocking… -> done. "Verified" means the engine wrote the
  rule _and_ read it back from the provider (`SyncEngine.verify`, `BlockAdapter.verify`); a failed or
  differing read-back says "rule written, not confirmed", never "verified".
- **Action is still Junk.** The rule files mail into Junk, so it skips the inbox but is not discarded
  (architecture K7: reversible only in v0.1). The popup text says so.
- **Gear -> settings.** One setting: how long a popup stays, in seconds, `{min 3, max 60, default 10}`
  (`POPUP_SECONDS` in core is the single source for schema, UI limits and the file). Stored in
  `settings.json` next to `accounts.json` (strict Zod schema, atomic write). Hover, an open settings
  panel and a running block pause the timer.
- **Notices** (watcher stopped, overflow, start failure) use the same window without buttons.

## Security

The page is untrusted: sandboxed, context isolation, no Node, CSP `default-src 'none'`, navigation and
`window.open` denied, sender/subject only ever set through `textContent`. The preload exposes seven
calls. Every IPC message is checked in main: the sender must be one of our popup windows showing our
page, the notification id must be a lowercase UUID found in `PendingBlocks`, the scope must be one of
`BLOCK_SCOPES`, the seconds value is re-parsed with the core schema.

## Scale budget

One popup per announced message; the watcher announces at most 5 per drain per account. At most 4
popups are visible, 50 wait in a queue, the oldest beyond that is dropped and logged (`popups-dropped`).
Pending ids: 200 entries max. No timers run when no popup is open.

## Lost with the toast (accepted)

Action Center persistence and starting the app from a toast (ADR 0003 measure item 4) do not apply to
this path. A popup that nobody sees within the configured seconds is gone; the sender can still be
blocked from the mail client until a list screen exists.

## Measured (2026-10-25, Windows 11, Electron 45.0.0, throwaway harness)

Three popups stacked bottom-right; Blocking… -> done shown in the same window; domain button absent
for `gmail.com`; a second click while done is ignored (one `choose` call); out-of-range seconds (99)
refused, 5 saved; popups closed by the timer. Real app started with the live test account: watcher
`watching`. NOT measured: a real mail producing a popup and a real click writing the MXroute rule.
