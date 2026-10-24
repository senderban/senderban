# 0003 — Desktop shell: tray, IMAP IDLE watcher, Windows notification

Status: proposed (2026-10-24). Nothing below is measured on a real Windows install yet; the
"Measure in Phase 5" list is the acceptance gate, not a footnote.

## Decision

A tray-only Electron 45.0.0 app (no window). One process owns the store (single-instance lock, already
in `apps/desktop/src/main.ts`). Per account, an IMAP watcher holds an IDLE connection to the INBOX.
On a new message it fetches only `From` and `Subject`, shows a Windows notification with
**[Block sender]**, and on activation hands the sender to the existing store + `SyncEngine`.

## What the docs say (read 2026-10-24, not run)

| Fact                                                                                                                                                      | Source                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Notification` takes `actions` of `type: 'button'` (macOS, Windows, Linux)                                                                                | [NotificationAction](https://www.electronjs.org/docs/latest/api/structures/notification-action)   |
| `Notification.handleActivation(callback)` (Windows) receives every activation; if one already happened before registering, the callback fires immediately | [Notification](https://www.electronjs.org/docs/latest/api/notification)                           |
| `ActivationArguments`: `type` (`click`/`action`/`reply`), raw `arguments` string, `actionIndex`                                                           | [ActivationArguments](https://www.electronjs.org/docs/latest/api/structures/activation-arguments) |
| Windows needs an AppUserModelID and a Start Menu shortcut carrying it and a ToastActivatorCLSID                                                           | [Notifications tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)           |
| Dev workaround: pin `electron.exe` to Start Menu and `app.setAppUserModelId(process.execPath)`                                                            | same tutorial                                                                                     |

Conflict inside the docs: the tutorial says buttons need the userland module
`electron-windows-notifications`, while the API pages document `actions` + `handleActivation`
natively. The API pages are newer and specific; the tutorial may be stale. **Decided by measurement,
not by choosing a page** (see list below). If native buttons do not fire, fallback is `toastXml`
(documented Windows option), and only then a userland module.

## IMAP watcher

- Library: `imapflow` 2.9.1 (`npm view`, 2026-10-24), MIT, 8 runtime dependencies. Pinned exactly when added.
- ImapFlow does **not** reconnect: after `close`/`error` a new client instance is required
  ([docs](https://imapflow.com/docs/api/imapflow-client/)). The reconnect state machine is ours, lives
  in `packages/core` behind a client interface (so it is unit-tested without a network), and has:
  exponential backoff with a cap, `maxIdleTime` below 29 min (RFC 2177 says servers may drop IDLE
  after 30 min), and a forced reconnect on Electron `powerMonitor` `resume` (ImapFlow documents nothing about sleep).
- Reads the IMAP `ENVELOPE` only (From address, Subject), INBOX opened read-only (`EXAMINE`). No
  body, nothing leaves the device. (A `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)]` fetch took 1 ms on
  MXroute, 2026-10-24; `ENVELOPE` through ImapFlow is not yet measured there.)
- Header text is hostile input: the sender must parse as an exact address (`parseAddress`), the
  display name is never shown, the subject loses control and bidi characters and is capped at 200.
- At most 5 toasts per fetch; older new mail in the same gap is counted, not announced.
- STARTTLS is required when not implicit TLS (`doSTARTTLS`), and an authentication failure halts the
  watcher instead of retrying (a retry loop with a wrong password risks a server-side lockout).
- Dedup key per message: `(accountId, uidValidity, uid)`; the last seen UID is persisted so a restart
  does not re-notify.

## Notification → action

- The activation callback is registered at startup, before `whenReady` work, so an activation that
  launched the app is not lost.
- The callback only receives `actionIndex` and a raw `arguments` string, not our sender. Pending
  notifications are therefore stored (`id → accountId, sender, createdAt`, bounded and expiring) and
  the id is the `Notification` `id`, which Windows returns as `tag=<id>` in
  `ActivationArguments.arguments` (measured, item 5). One click can call the handler twice (item 3).
- Click on [Block sender] only enqueues; the write goes through the sync engine, and the result
  (applied / failed / undo) is shown as a second notification. Default action stays reversible (Junk).

## Secrets

IMAP/ManageSieve app passwords are encrypted with `safeStorage.encryptStringAsync` /
`decryptStringAsync` (sync variants are deprecated in 45, removed in 46; ADR 0001). Ciphertext goes in
the store, never plaintext, never logs.

## Measured so far (MXroute, 2026-10-24, read-only, `contract/live-imap.contract.ts`)

- `imapflow` 2.9.1 over implicit TLS (993): connect + `EXAMINE INBOX` 1.8–2.2 s; `ENVELOPE` fetch of 4 messages 137–150 ms; `uidValidity` and `uidNext` read; a range past the end announced nothing.
- Idle watcher: one mail sent from a second account while `AccountWatcher` was in `watching` was announced exactly once through the `exists` event (state path `connecting>watching>stopped`).
- NOT measured: delivery-to-announcement latency (the send time was not recorded), the 25-minute IDLE restart, sleep/resume, reconnect after a real network drop, the STARTTLS path, and the authentication-failure path (one wrong login was deliberately not tried against the live account).

## Measure in Phase 5 (each one gets its result written here)

1. ~~`node:sqlite` opens the store file in the Electron **main process**~~ — **MEASURED 2026-10-24**: Electron 45.0.0 main process (real app run, not `ELECTRON_RUN_AS_NODE`), Node 24.22.0, `sqlite_version()` 3.53.4, `BEGIN IMMEDIATE` sets `isTransaction`. In-memory DB only; a file DB in WAL mode from the main process is still covered by ADR 0002's `ELECTRON_RUN_AS_NODE` run. Trap: the VS Code extension host sets `ELECTRON_RUN_AS_NODE=1`; launching `electron.exe` from there runs plain Node (`'electron' does not provide an export named 'app'`). Unset it (`env -u ELECTRON_RUN_AS_NODE`).
2. ~~A notification with a [Block sender] button shows on Windows 11 from an unpackaged dev run~~ — **MEASURED 2026-10-24** (Windows 11 26200, `electron.exe` 45.0.0, native `actions: [{type:'button'}]`, AUMID `com.senderban.desktop`): shown and clicked by Ali. No manual pinned shortcut was needed: at the first `show()` Electron itself created `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Electron.lnk` (AUMID `com.senderban.desktop`). The first run went unseen (nobody was looking; Windows logged `delivered to com.senderban.desktop`), the second was seen. Not measured: toasts under Do Not Disturb, and a packaged app's shortcut.
3. ~~Clicking the button calls `handleActivation` with `type: 'action'`, `actionIndex: 0`~~ — **MEASURED 2026-10-24**: `{"type":"action","arguments":"type=action&action=0&tag=spike-A-native","actionIndex":0}` while the app was running. **One click produced two `handleActivation` calls ~60 ms apart** (and the instance `action` event fired twice too). The handler must be idempotent: consume the pending id once.
4. Same click after the app was quit and relaunched by the toast (activation-launch path). **NOT measured.**
5. ~~A custom id in the notification reaches `ActivationArguments.arguments`~~ — **MEASURED 2026-10-24 for the native path**: the `Notification` `id` arrives as `tag=<id>` inside `arguments`, so `toastXml` is not needed to carry our pending id. `toastXml` (`launch=`/`<action arguments=>`) was shown in the same run but produced no activation record; **not measured**, not needed. Parse `arguments` with `URLSearchParams`, treat it as untrusted, and look the id up in the bounded pending map.
6. IDLE `exists` event on contact@senderban.com delivers a notification within seconds; survives 29-min renewal and a sleep/resume.
7. Installer: which tool creates the shortcut with AUMID + ToastActivatorCLSID (Squirrel sets it automatically per the tutorial; other tools do not). Chosen after 2–5, recorded in a new ADR.

## Build and wiring (2026-10-25)

- Electron cannot import the workspace's `.ts` sources, so both packages are compiled with `tsc` (`npm run build`, also a CI step) to `dist/`. `@senderban/core` has an `exports` map: `types` points at `src/*.ts` (editor and `tsc` see the source), `default` at `dist/*.js` (Electron runs the build). Entry points: `.` (pure, also safe for the browser extension), `./store` (`node:sqlite`), `./node` (imapflow, raw TCP/TLS ManageSieve). No bundler yet; added when the installer is chosen (item 7).
- `apps/desktop/src/main.ts`: tray (account states, Pause/Resume, Quit), per-account `AccountWatcher`, a toast per new message with [Block sender], `Notification.handleActivation` registered before `whenReady` and answered through a promise that resolves once the store/engine/watchers exist.
- The click logic is `handleBlockActivation` in core (tested without Electron, 6 tests): only `type: 'action'` with `actionIndex 0`, id read from `tag=` and accepted only as a lowercase UUID, then `PendingBlocks.consume` once. A duplicate id is dropped silently (the 60 ms second activation); an unknown id says the toast expired. The entry is exact-address, action `junk`; the clicked account syncs at once for the confirmation toast, the other accounts through the debounce.
- Accounts live in `userData/accounts.json` (strict schema, bounds in core `accounts.ts`), password only as `safeStorage.encryptStringAsync` ciphertext. Bootstrap until a settings window exists: `electron apps/desktop --add-account=<file.json>` (file holds the plaintext password and is deleted after saving).
- Measured 2026-10-25 (Windows 11, Electron 45.0.0, no real mail account): the built app starts, shows the tray, opens `senderban.db` in WAL mode from the main process, starts a watcher that backs off against an unresolvable host and stays up for 8 s; `--add-account` produced a `v10` DPAPI ciphertext and deleted the input file.
- NOT measured: a real toast click through this wiring, activation after a restart (item 4), tray visibility on screen, Quit while a sync is running.
- Known gap: `PendingBlocks` is in memory. A toast still in the Action Center after the app restarted reports "expired" instead of blocking. Fix when item 4 is measured (persist `id -> account, sender, created_at` in the store, same bound and TTL).

## Live end-to-end measurement (2026-10-25, the maintainer's test mailbox on MXroute, built app, log `logs/senderban.log`)

- New mail from a second account: IDLE `exists` -> `announce` (a new UID, domain only in the log) -> toast with [Block sender] shown by Ali. The first test mail went to a wrong address, so the earlier "no mail" was not a watcher fault.
- One click on [Block sender]: two `activation` events 13 ms apart (earlier spike: 60 ms), result `duplicate` for the second and `blocked` for the first; `sync applied=1 failed=0` 1.9 s after the click. Exactly one entry written.
- Read back from MXroute over ManageSieve: `senderban-main` active (`include :personal "senderban-rules"`), `senderban-rules` holds the exact-address rule for the clicked sender (`address :is "from"` + `envelope :is "from"`, `fileinto :create "Junk"; stop;`). The mailbox had no Sieve script before, so the "include into the user's existing active script" path is still unmeasured.
- NOT measured: a blocked sender's next mail actually landing in Junk through this app-written rule on this account; item 4 (click after app restart); the "Block not applied" toast; toast layout is still Electron's default (header "Electron", Electron icon, internal account id in the body) and is the next work item.
- Side effect left on the live account: the rule for the test sender and the two scripts above (uninstall: `SieveAdapter.uninstall` with the stored state).

## Not decided here

Installer and code signing (separate ADR, item 7), Gmail notification source (K6: BYO pilot only,
`gmail.metadata` is Restricted), tray menu contents beyond Pause/Quit.
