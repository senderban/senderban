# 0010 — Windows installer and toast identity

Status: accepted (2026-10-27) for the build and install; the toast of the installed app (header "Senderban", icon, click, Unblock) was measured on 2026-10-28
(see "Measured"). Builds on ADR 0007 (native toasts need a Start-menu shortcut that carries the app identity).

## Decision

- **electron-builder 26.18.0** (npm `latest` on 2026-10-27; 26.18.1 sits on the `v26` tag, not `latest`), **NSIS**, one-click, per user
  (`%LOCALAPPDATA%\Programs\senderban`), no administrator rights, no desktop shortcut, one Start-menu shortcut `Senderban`.
  Electron moved from 45.0.0 to **45.1.0** (npm `latest`), both pinned exactly.
- **Identity:** `appId: com.senderban.desktop` is the AppUserModelID. Read from the electron-builder source
  (`templates/nsis/include/installer.nsh`): the NSIS script runs `WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"`. The value equals
  `APP_USER_MODEL_ID` in `apps/desktop/src/main.ts`. Measured after a silent install: `Get-StartApps` lists one entry, name
  `Senderban`, AppID `com.senderban.desktop`, and Windows keeps toasts under that AppID in the Action Center (the test toasts and two
  real ones).
- **Why not Forge/Squirrel:** Electron's notification guide says Squirrel sets the shortcut itself, but Squirrel brings its own update
  and install layout and a separate maker; NSIS is one file, per user, and the shortcut identity is in a template we could read. No
  auto-update is built (no server, ADR 0003/0006); a new version is a new download.
- **Fuses** (Electron security checklist): `runAsNode` off (the app starts no child process; the packaged exe ignored
  `ELECTRON_RUN_AS_NODE=1`, which this machine sets), `enableNodeCliInspectArguments` off, `enableNodeOptionsEnvironmentVariable` off,
  `enableCookieEncryption` on, `onlyLoadAppFromAsar` on, `enableEmbeddedAsarIntegrityValidation` on (Windows, Electron >= 30). Left at
  its default: `grantFileProtocolExtraPrivileges`, because the manage window is a `file://` page; a custom protocol is a later step.
- **Contents:** `package.json`, `dist`, `assets`, no source maps, no tests; the workspace package `@senderban/core` is copied but only its
  built `dist` is kept. Packaged app: 1,413 files in `app.asar` (11 MB before trimming); the installer is about 122 MB (Electron).
- **Unsigned for v0.1** (docs 010: SignPath after the first release; Azure Artifact Signing is closed to an individual in Turkey).
  `.github/workflows/release.yml` builds from a `vX.Y.Z` tag and keeps `SHA256SUMS` and the installer as workflow artifacts. It creates
  **no** GitHub Release: publishing stays a deliberate step. Actions are pinned to commit SHAs (checkout v7.0.1, setup-node v7.1.0,
  upload-artifact v7.0.2, download-artifact v8.0.2, attest-build-provenance v4.2.2). After the security review of 2026-10-27:
  - two jobs: `build` (install scripts, tests, build; no signing authority) and `attest` (only download, `sha256sum --check`, attest;
    holds `id-token: write`), so a dependency's code cannot get a provenance for a file of its own;
  - only a pushed version tag is attested; a manual run builds but is not attested; the tag must equal the app version (`vX.Y.Z` against
    `apps/desktop/package.json`), else the build stops; no npm cache in the release build;
  - the README verify command pins `--signer-workflow`, `--source-ref` and `--deny-self-hosted-runners`.
  - Repository settings, set 2026-10-28 with the owner's approval: a tag ruleset on `refs/tags/v*` (no update, no delete; creating a tag
    stays allowed), a branch ruleset on the default branch (no deletion, no force-push; no pull-request or status-check rule, so a
    direct push still works), and the Actions policy `allowed_actions: selected` (GitHub-owned actions only) with
    `sha_pinning_required: true` (before: `all` and `false`). Read back with `gh api repos/senderban/senderban/rules/branches/main` and
    `.../actions/permissions`. Not exercised: a rejected force-push or tag delete (not tried on purpose).
- **Asar integrity** is on, but while the exe is unsigned it only detects a changed `app.asar`, not a changed exe: an attacker who can
  write the install folder (same user) can replace the exe too. It is a hygiene fuse, not a tamper defence, until the exe is signed.
- **Uninstall keeps the user data** (`%APPDATA%\Senderban`, `deleteAppDataOnUninstall: false`: an `appId` change must never wipe accounts).
  The README says what stays and how to remove accounts first (a removed Gmail account is revoked at Google).

## Measured (2026-10-27, Windows 11 26200, Node 24.14.1)

- `electron-builder --dir`: the unpacked app starts and logs `start` with Electron 45.1.0 on a temporary data folder.
- NSIS build: the installer builds without a signing certificate ("signing is skipped"), SHA-256 of the first build
  `985df2d5…` (not a release hash).
- Install folder: a one-click per-user install names its folder after the **package name**, not the product name
  (`targetUtil.getWindowsInstallationDirName`: the product name only counts for assisted or per-machine installs); the workspace name
  `@senderban/desktop` gave `@senderbandesktop`. `extraMetadata.name: senderban` in the config fixes it (folder `senderban`).
- Silent install: `Start-Process Senderban-Setup-<v>.exe -ArgumentList /S -Wait` installs and does **not** start the app. Started from Git
  Bash as `./Senderban-Setup.exe /S`, MSYS rewrites `/S` as a path, the installer runs interactively and **launches the app on the real
  profile** (it did once: the app connected the real IMAP account and announced two new mails; nothing was clicked, no rule written).
  Use PowerShell for silent installs, and set `accounts.json` aside first when testing.
- Uninstall: the registered quiet command is `"Uninstall Senderban.exe" /currentuser /S` (without `/currentuser` it did nothing). It removes
  the files, the Start-menu shortcut and the uninstall registry entry, and keeps `%APPDATA%\Senderban` (`deleteAppDataOnUninstall: false`).
  An empty install folder can stay behind.
- A stray `Electron.lnk` from development (target `node_modules\electron\dist\electron.exe`, same AppUserModelID, created 2026-10-24) was
  in the Start menu; `Get-StartApps` listed it as "Electron" next to the installer's entry. It was moved out of the Start menu for the test
  (backup kept), so the identity has exactly one shortcut.

- **Toast click with the installed identity (2026-10-28 10:50, screen unlocked, Ali at the machine).** A harness (the dev Electron with the
  product's own `Toasts` class and toast XML, `app.setAppUserModelId("com.senderban.desktop")`) showed one toast while the installer's
  Start-menu shortcut was the only holder of that identity. Ali pressed "This sender" 19 s later: the harness log has `toast-activation`
  and then `choose scope=address action=junk`, so a click is delivered with a shortcut-only identity (the registry key of ADR 0007 is
  not needed and was not present). The click is a person's, not ours: UI Automation (`Windows.UI.Core.CoreWindow` named "notification")
  found no toast window in the 20 s while it was on screen, so that route cannot read or press a Windows 11 toast. Process: the
  harness runs in the dev Electron, not in the installed `Senderban.exe`; the identity is the shortcut's either way, but a click on a
  toast of the installed app itself is not measured.

- **Toast of the installed app itself (2026-10-28 11:14-11:19, screen unlocked, Ali at the machine, one MXroute IMAP account).** Mail
  to the watched mailbox made the installed `Senderban.exe` show its own toast. First toast: header "Electron". Cause: a leftover
  dev-harness shortcut `Electron.lnk` (target `node_modules/electron/dist/electron.exe`) was still in the Start menu and carried the same
  AppUserModelID, and Windows took the display name from it; `Get-StartApps` listed `Electron` and `Senderban` apart. After the stray
  shortcut was moved out (not deleted), the second toast had header "Senderban", the app icon, the Junk/Trash action selection and the
  "This sender" / "Whole domain" buttons. Ali pressed "This sender": log `toast-activation`, then `sync applied=1`, then `choice
  scope=address action=junk result=blocked verified=true`. Unblock from the "Blocked senders" window: "The rule is gone from 2 place(s)
  and was read back from the provider", log `unblock result=unblocked confirmed=2 accounts=2`; no toast follows an Unblock (the window shows
  the result). Lesson: a second shortcut with the same AppUserModelID takes over the header; after install, scan the Start menu for `.lnk`
  files that carry the identity.

## Not measured

- The Action Center entry of the second toast and the toast on a locked machine (three earlier tries on a locked machine, LogonUI running,
  2026-10-27 22:45, 2026-10-28 00:06 and 01:13, put the toasts in the Action Center only).
- The installer on another Windows build, a per-machine install, SmartScreen behaviour for the unsigned file, the workflow run on GitHub.
- Upgrade over an existing install (same `appId`, new version), and what happens to a running tray app.
