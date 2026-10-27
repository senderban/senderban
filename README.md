# Senderban

Block a sender once, from the Windows notification, on every mail account you own.

> **Status: pre-alpha. Works today on MXroute only. Next: Gmail, then Hotmail / Outlook.** The
> notification, the Sieve rule and the MXroute server-side block ran against one real MXroute mailbox
> (2026-10-25). There is no installer and no release yet, and nothing is measured on other providers.
> Do not point it at a mailbox you cannot afford to experiment on.

## The idea

A new mail arrives. Senderban shows a notification with a choice of what happens to future mail
(**Block at server**, **Move to Junk**, **Move to Trash**) and two buttons, **This sender** and
**Whole domain**. One click writes a rule on the mail provider's own server (a Gmail filter, a Sieve
script, an Outlook rule), so the block also applies on your phone, in webmail and in whichever mail
client you use. On MXroute, **Block at server** also puts the address on the server's blacklist, so
the sender gets an error (`550 High scoring spam message has been dropped`) and the mail never
arrives. The result is shown per account and can be undone.

It is not an email client. It does not send, sync, search or download message bodies.

## What it will read and write (design, not yet implemented)

- **Reads:** only the `From` and `Subject` headers of a newly arrived message, on your device, to
  build the notification. No message body. Nothing is sent to a Senderban server (there is none).
- **Writes:** one rule per provider, tagged as Senderban's own. It never touches rules you created.
- **Default action is reversible** (move to Junk / Trash). There is no permanent delete.
- Credentials are stored in the operating system's keychain, never in the project database or logs.

## Planned provider support

| Provider                          | Mechanism                           | Target             | Evidence                          |
| --------------------------------- | ----------------------------------- | ------------------ | --------------------------------- |
| MXroute                           | Sieve (ManageSieve) + blacklist API | v0.1 (works today) | measured (2026-10-24, 2026-10-25) |
| Gmail / Workspace                 | Gmail filters (own OAuth client)    | v0.1               | documented, not yet measured      |
| Outlook / Hotmail / Microsoft 365 | Graph message rules                 | v0.2               | documented, not yet measured      |

"Documented" means read in the provider's official documentation. It is not a claim that it works.
"Measured" means the adapter ran against a real account: for MXroute that is install, in-place update, read-back, uninstall, and one delivered mail from a blocked sender filed into Junk by the generated script (2026-10-24), on a mailbox with no existing Sieve script.
Not yet measured on MXroute: adding the `include` to a user's already-active script, and an envelope-sender match on its own (the test mail had the same From and envelope address).

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

Layout: `packages/core` (provider-agnostic logic, TypeScript) and `apps/desktop` (Electron shell).
Architecture decisions are in [docs/adr](docs/adr).

### Windows installer (not released yet)

```sh
npm run build
npm run dist -w apps/desktop   # apps/desktop/release/Senderban-Setup-<version>.exe
```

A per-user installer (no administrator rights). It is **unsigned** for v0.1, so Windows SmartScreen
shows a warning on first run. A tagged build in GitHub Actions also writes `SHA256SUMS` and a build
provenance attestation; check a download with `gh attestation verify <file> --repo senderban/senderban`.
Details and what was measured: [docs/adr/0010-windows-installer.md](docs/adr/0010-windows-installer.md).

## License

[Apache-2.0](LICENSE).
