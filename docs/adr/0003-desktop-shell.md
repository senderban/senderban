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
  the id is carried in `arguments` or `toastXml`. Whether a custom string survives to
  `ActivationArguments.arguments` is **unmeasured**.
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

1. `node:sqlite` opens the store file in the Electron **main process** (ADR 0002 only measured `ELECTRON_RUN_AS_NODE`).
2. A notification with a [Block sender] button shows on Windows 11 from an unpackaged dev run with the pinned-shortcut workaround.
3. Clicking the button calls `handleActivation` with `type: 'action'`, `actionIndex: 0`, while the app is running.
4. Same click after the app was quit and relaunched by the toast (activation-launch path).
5. A custom id in the notification reaches `ActivationArguments.arguments`.
6. IDLE `exists` event on contact@senderban.com delivers a notification within seconds; survives 29-min renewal and a sleep/resume.
7. Installer: which tool creates the shortcut with AUMID + ToastActivatorCLSID (Squirrel sets it automatically per the tutorial; other tools do not). Chosen after 2–5, recorded in a new ADR.

## Not decided here

Installer and code signing (separate ADR, item 7), Gmail notification source (K6: BYO pilot only,
`gmail.metadata` is Restricted), tray menu contents beyond Pause/Quit.
