# 0010 — Windows installer and toast identity

Status: accepted (2026-10-27) for the build and install; the toast click through the installed identity is **not yet measured**
(the machine was locked, see "Not measured"). Builds on ADR 0007 (native toasts need a Start-menu shortcut that carries the app identity).

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
  - Not done, needs the repository owner: a tag ruleset on `refs/tags/v*` (no update or delete), a branch ruleset on `main`, and the Actions
    policy "require SHA pinning" (`gh api repos/senderban/senderban/actions/permissions`: `sha_pinning_required: false`, `allowed_actions: all`).
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

## Not measured

- What a toast header and icon look like with the installed identity, and whether a click on "This sender" reaches the app
  (`toast-activation` in the log, then `choose`). The machine was locked (LogonUI running; UI Automation found no toast window), so the
  toasts went to the Action Center. ADR 0007's earlier finding (a hand-made registry key broke delivery) is not contradicted or
  confirmed for a shortcut-only identity until this is run with the screen open.
- The installer on another Windows build, a per-machine install, SmartScreen behaviour for the unsigned file, the workflow run on GitHub.
- Upgrade over an existing install (same `appId`, new version), and what happens to a running tray app.
