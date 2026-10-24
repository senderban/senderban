# Senderban

Block a sender once, from the Windows notification, on every mail account you own.

> **Status: pre-alpha. Nothing works yet.** There is no installer, no release and no tested provider
> integration. The code in this repository is the foundation (address/blocklist model, adapter
> contract, provider registry). Do not point it at a real mailbox.

## The idea

A new mail arrives. Senderban shows a notification with **[Block sender]**, **[Domain…]** and
**[Open]**. One click writes a rule on the mail provider's own server (a Gmail filter, a Sieve
script, an Outlook rule), so the block also applies on your phone, in webmail and in whichever mail
client you use. The result is shown per account and can be undone.

It is not an email client. It does not send, sync, search or download message bodies.

## What it will read and write (design, not yet implemented)

- **Reads:** only the `From` and `Subject` headers of a newly arrived message, on your device, to
  build the notification. No message body. Nothing is sent to a Senderban server (there is none).
- **Writes:** one rule per provider, tagged as Senderban's own. It never touches rules you created.
- **Default action is reversible** (move to Junk / Trash). There is no permanent delete.
- Credentials are stored in the operating system's keychain, never in the project database or logs.

## Planned provider support

| Provider                | Mechanism                        | Target | Evidence                     |
| ----------------------- | -------------------------------- | ------ | ---------------------------- |
| MXroute                 | Sieve (ManageSieve)              | v0.1   | documented, not yet measured |
| Gmail / Workspace       | Gmail filters (own OAuth client) | v0.1   | documented, not yet measured |
| Outlook / Microsoft 365 | Graph message rules              | v0.2   | documented, not yet measured |

"Documented" means read in the provider's official documentation. It is not a claim that it works.

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

## License

[Apache-2.0](LICENSE).
