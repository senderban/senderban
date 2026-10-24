# 0001 — Stack and toolchain

Status: accepted (2026-10-24)

## Decision

TypeScript core (`packages/core`) with an Electron shell (`apps/desktop`), npm workspaces, Node.js 24.

Versions were measured with `npm view` on 2026-10-24 and pinned exactly:

| Package            | Version | Note                                                                                              |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| electron           | 45.0.0  | latest stable                                                                                     |
| typescript (`tsc`) | 7.0.2   | installed as `@typescript/native` alias; used for type checking                                   |
| typescript (API)   | 6.0.2   | `typescript` is aliased to `@typescript/typescript6`                                              |
| vitest             | 5.0.5   |                                                                                                   |
| eslint             | 10.13.0 |                                                                                                   |
| typescript-eslint  | 8.72.0  |                                                                                                   |
| zod                | 4.6.7   |                                                                                                   |
| prettier           | 3.9.10  |                                                                                                   |
| @types/node        | 24.19.2 | matches the Node 24 line that Electron 45 depends on (`@types/node` ^24.9.0), not the newest 26.x |

## Why Electron

Windows toast buttons are the product. Electron's `Notification` supports `actions` buttons and
`Notification.handleActivation` on Windows, which receives a button click even if the notification
object was garbage collected
([Notification API](https://www.electronjs.org/docs/latest/api/notification),
[NotificationAction](https://www.electronjs.org/docs/latest/api/structures/notification-action)).
Tauri v2's notification actions are documented for mobile only.

Windows needs an AppUserModelID and a Start Menu shortcut for notifications
([tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)). To be measured on a
real install before it is relied on.

## Why two TypeScript versions

TypeScript 7.0 is the native compiler and ships without a programmatic API until 7.1
([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
typescript-eslint 8.72.0 requires `typescript >=4.8.4 <6.1.0`. So `tsc` is 7.0.2, while the
`typescript` module that tooling imports is the official 6.0.2 re-export. Remove the alias once
typescript-eslint supports the 7.x API.

## Known follow-ups

- Electron 45 deprecates the synchronous `safeStorage` methods and removes them in 46. Use
  `encryptStringAsync` / `decryptStringAsync` from the start
  ([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)).
- Native modules (SQLite) and the installer toolchain are decided in Phase 4/5, not now.
