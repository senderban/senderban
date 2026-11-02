# 0019 — The Store package, and a click on a toast while the app is closed

Status: **accepted** (2026-11-02). Builds on ADR 0003 (desktop shell) and ADR 0007 (native toasts). Measured on Windows 11 (build 26200),
Electron 45.2.1, an unsigned package registered with `Add-AppxPackage -Register` and a local Dovecot server. Not measured: an install from the
Store itself, and a build uploaded to the Partner Center.

## Context

A toast outlives the app: it stays in the Action Center after the app quit or restarted. Two things follow.

1. In the Store package a click on a toast reaches the app only through a COM activator named in the manifest. Without it Windows starts a
   new process with the button's arguments and the choice in the toast (Junk or Trash) is lost.
2. The id on the button names a row of `PendingBlocks`, which lives in memory. After a restart no id is known, so the click answered
   "expired" and blocked nothing (ADR 0003, known gap).

## Decision

1. **The Store package is the same app.** `electron-builder.store.yml` extends the NSIS config and adds the `appx` target.
   electron-builder 26.18.0 has no `msix` target yet. `identityName` and `publisher` are placeholders until the Partner Center reserves the
   name; a Store upload must carry the values it shows. The Store re-signs the package, so a Store build uses no certificate. `dist:store`
   builds first, so a `dist/` patched for a test (a temporary CA in `main.js`) is never packed.
2. **One COM activator.** `build/appx-extensions.xml` registers the class that Windows calls for a click, and `main.ts` passes the same id to
   `app.setToastActivatorCLSID` when `process.windowsStore` is true. A test compares the two. The class starts `Senderban.exe
-ToastActivated`, and the `start` log line says `cold: true` for such a start.
3. **A never-shown `Notification` object.** A click made while the app was closed only reaches `handleActivation` if a `Notification` was
   created before it. Without one, Windows kept starting the app again every two minutes (5 starts in 8 minutes, measured); with it there
   was no repeat in 8.5 minutes. This is a side effect measured on Electron 45.2.1, not something the Electron docs promise, so it is
   measured again on every Electron bump: close a toast with its X button, click its body, click a button, each with the app closed, and
   count the `start` lines over 10 minutes (one per click).
4. **The button carries the sender, signed.** A button writes `act`, `id`, and a tail (`acct`, `from`, `t`) plus `mac`: the first 16 bytes
   of HMAC-SHA-256 (RFC 2104) over the five fields, as a JSON array so no sender can run two fields together. The key is 32 random bytes
   made on first use and kept with `safeStorage` in `activation-key.json`, like the account passwords. Without it a forged activation could
   name any sender and any lane, and the app would block it. With no key (the OS cannot keep one, the file cannot be written) no toast carries
   a tail and none is accepted, and an earlier toast answers "expired" as it did before.
   The tag is not secret and hides nothing. It only shows that this machine wrote the arguments.
5. **A signed click is taken back, with the old guards.** `PendingBlocks.restore` takes an id it does not hold, issued before this process
   started and inside the 24 hour TTL, for an account the person still has (`lanes`, which the removal paths splice; the engine keeps a
   lane until the restart, so it is not asked). `blockPending` then applies the rules it always applied: not the person's own address, no
   free-mail domain, `reject` only where the server can refuse, Gmail only Trash.
6. **A click on the body opens the buttons again.** The toast has `launch="act=open;…"`. The click blocks nothing; it shows the toast again,
   kept on screen until answered, from what the app can rebuild (the sender, the lane, the offer of the provider). The subject of a toast
   of an earlier run is not kept.

## What stays open

- **A second delivery after a restart.** Which ids were answered is not written to disk. Windows can deliver the same click twice (toast and
  Action Center); in one process the second is a `duplicate`, but a second delivery to a new process finds an empty table and the click is
  claimable once more within the 24 hours. `store.add` is idempotent, so the cost is one sync on the clicked lane. Persisting spent ids
  would add a write for every answer; not done. Inside one process the answered ids are kept apart from the table of announcements and
  swept by the 24 hours only, so 200 newer toasts do not make an answered id claimable again.
- **The signed `act` limits only its own click.** A signed tail restores the id; a later button of the same toast then acts on it without
  a tail. `blockPending` derives the domain itself and applies its own rules, and every button of a toast is in the same XML, so the
  signed `act` is not a control to rely on.
- **Who may call the activator.** The manifest sets no `LaunchAndActivationPermission`, so the machine default applies (administrators,
  SYSTEM, interactive users). Code running as the same user can call it. It can also decrypt `activation-key.json` (DPAPI protects
  against other users, not against other apps of the same user) and read the signed tails from the toast database Windows keeps per user,
  as it can already read the passwords. The tag stops a caller that can deliver an activation but cannot read this user's files. The
  action choice (Junk, Trash, reject) is not signed: it is the person's pick in the toast. Not measured from a low-integrity process.
- **The Store build is made on a developer machine**, not in `release.yml`, so it has no CI build and no attestation. Before the first
  upload it should be built there, with the built-in Gmail client step, and attested.
- **A stray data folder.** After a cold start `%APPDATA%\Senderban` (9 files, 557 KB, caches only) appeared beside the package's own
  `LocalCache\Roaming\Senderban`. Cause not measured. A Store user could have two data homes.
- **Not measured:** a cold click with Move to Trash chosen (the choice rides in `userInputs`; a lost choice falls to Junk, which is
  reversible), Quit with a toast on screen, the NSIS build's cold click.
