# Senderban

Block a sender once, from the Windows notification, on every mail account you own.

> **Status: v0.1, early release.** Windows only. Works on MXroute and Gmail: the full loop (new mail,
> notification, block, next mail filed away, undo) was measured on one real account of each on
> 2026-10-30. Nothing is measured on other providers. The installer is unsigned. Start with a
> mailbox you can afford to experiment on.

## Download

[Latest release](https://github.com/senderban/senderban/releases/latest): `Senderban-Setup-X.Y.Z.exe`.
It installs for your user only, no administrator rights.

The installer is **unsigned** for v0.1, so Windows SmartScreen warns on first run (**More info**,
then **Run anyway**). Check the download first. This prints a hash to compare with `SHA256SUMS` on
the release, which catches a broken download:

```powershell
Get-FileHash .\Senderban-Setup-X.Y.Z.exe -Algorithm SHA256
```

This proves the file came from the tag's release workflow. It needs the GitHub CLI (`gh`):

```powershell
gh attestation verify .\Senderban-Setup-X.Y.Z.exe --repo senderban/senderban --signer-workflow senderban/senderban/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z --deny-self-hosted-runners
```

## What it does

A new mail arrives. Senderban shows a Windows notification. One click writes a rule on the mail
provider's own server (a Gmail filter or a Sieve script), so the block also applies on your phone,
in webmail and in whichever mail client you use. The block list is shared by all your accounts, a
warning or a failure shows as a notification, and every block can be undone in the **Blocked senders**
window. **Settings** picks the default action, whether a block that worked is confirmed, and how long
new-mail notifications stay on screen. **Don't ask again** on a notification stops the questions about a
sender without blocking it; its own page lists those senders, filters them and can take them back.
Each mailbox on a mail server can also have a **spam filter** in **Accounts**: the server moves mail at or
over the score you pick, or the notification asks. It needs a mail server that adds a spam score.

| On                | Choices                                                            | Whole domain |
| ----------------- | ------------------------------------------------------------------ | ------------ |
| MXroute           | **Move to Junk** (default), **Move to Trash**, **Block at server** | yes          |
| Other mail server | **Move to Junk** (default), **Move to Trash**                      | yes          |
| Gmail / Workspace | **Move this sender to Trash**                                      | no           |
| Other (IMAP)      | **Move to Junk** (default), **Move to Trash**                      | yes          |

**Other (IMAP)** is no rule on a server: Senderban moves the mail itself, only while it runs. With
Senderban closed a blocked sender's mail stays in the inbox, and your phone sees it. Blocking someone
there also moves their mail of the last 30 days out of the inbox, and adding the mailbox does this
for your whole block list at the next start.

- **Block at server** (MXroute, one address, off until you switch it on) puts the address on the
  MXroute blacklist, which covers every mailbox on that mail domain. On the mailbox measured the
  sender got `550 High scoring spam message has been dropped` and no copy was kept. That depends on
  the spam-score limit in your MXroute panel, so a Junk rule stays as the backup for a mail that
  still arrives.
- A single-address Junk or Block at server entry made on MXroute goes to Trash on Gmail: Gmail
  filters cannot file mail into Spam.
- Gmail has no whole-domain block: measured, its `from:` search also matches the display name and
  look-alike domains ([ADR 0009](docs/adr/0009-gmail-account.md)). A whole-domain entry made on
  MXroute is not applied on Gmail, and the list says so.
- Your own addresses are never blocked, and a whole-domain block never covers your own mail domain.

It is not an email client. It does not send, sync, search or download message bodies.

## What it reads and writes

- **Reads:** only the `From` and `Subject` of a newly arrived message, plus the server's
  `X-Spam-Score` header on IMAP accounts, on your device, to build the notification. No message
  body. Nothing is sent to a Senderban server (there is none). An **Other (IMAP)** mailbox is the
  exception to "newly arrived": to clear past mail, Senderban reads the sender of older messages in
  that inbox, up to 30 days back and 50,000 messages, on your device. It keeps only what it moves.
- **Writes:** rules on your mail provider, tagged as Senderban's own, and it leaves rules you created
  alone. The exception is the MXroute blacklist, which has no tag: Unblock removes an address there
  even if you had listed it yourself. An **Other (IMAP)** mailbox gets no rule: Senderban moves mail
  from blocked senders out of its inbox, and Unblock does not bring that mail back.
- **The default action is reversible** (Junk or Trash). There is no permanent delete. **Block at
  server** is the one choice that can leave no copy, and you have to switch it on and pick it.
- **Secrets** are stored encrypted with Windows DPAPI, for your Windows user, in
  `%APPDATA%\Senderban`. They never go to logs.

Full policy: [senderban.com/privacy](https://senderban.com/privacy/).

## Add an account

Not sure which of these you need? Open **Accounts**, **Add mailbox**, type your address and press
**Find my provider**. Senderban reads your domain's mail records, may ask the mail server what it is
without signing in, and fills in the right form. A server name read from DNS is a suggestion: compare
it with what your provider gave you. Nothing is saved until you add the mailbox yourself
([ADR 0018](docs/adr/0018-provider-detection.md)).

### Gmail

Open Senderban from the tray, **Accounts**, **Add mailbox**, **Gmail**, **Add Gmail account**, sign in
with your Google account in your browser, **Restart now**. There is nothing to set up.

Google has not verified Senderban yet, so the sign-in page shows "Google hasn't verified this app"
and the app is limited to 100 users. To sign in through a Google Cloud project you own instead, see
[docs/gmail-setup.md](docs/gmail-setup.md).

### MXroute and other mail servers

Open Senderban from the tray, **Accounts**, **Add mailbox**, **Mail server**, pick your provider,
enter the mail address and password, **Add mailbox**, **Restart now**. For MXroute also enter the
server (it is in your MXroute welcome mail). Senderban asks you to confirm the server, checks that
it speaks ManageSieve before any password leaves your device, signs in over IMAP and ManageSieve and
stores nothing unless both work. The password is stored encrypted on this device.

**Other mail server** is for any server that speaks ManageSieve, such as a self-hosted Dovecot,
Stalwart, mailcow or Mailu. Only Dovecot was measured. It needs a public host name, IMAP over TLS on 993, ManageSieve with STARTTLS (the port is yours to set, 4190 by default) and
a certificate that verifies.

A server without the Sieve `include` extension (Migadu and Purelymail advertise none) has room for
one active script. Senderban's rules take that place if it is free. If you already run a script of
your own there, Senderban refuses the mailbox and leaves your script alone.

**Remove** next to the account deletes Senderban's rules from the mail server, then the password. If
the rules cannot be deleted it says so and asks you first. Senders on the MXroute blacklist stay
there until you delete them in your MXroute panel. Your MXroute API key stays too: it has its own
**Remove key** under **Accounts**.

The form uses IMAP over TLS on port 993 and ManageSieve on port 4190 unless you change it, with the mail address as user
name. For any other setup, quit Senderban from the tray and save this as `account.json` with your
own values, directly in your user folder (`%USERPROFILE%`). Not on the Desktop or in Documents: they
may sync to OneDrive. Not in a new folder under `C:\`: other users of the PC can read it. Then run
the command below it.

Without `"provider"` the account counts as MXroute. When it works the password is stored encrypted and the file is gone. If the file is still there it
failed: delete it with Shift+Delete, which skips the Recycle Bin. If the file ever reached a synced
folder, change the password.

```json
{
  "id": "you@example.com",
  "provider": "other",
  "imap": { "host": "mail.example.com", "port": 993, "secure": true, "user": "you@example.com" },
  "sieve": { "host": "mail.example.com", "port": 4190, "user": "you@example.com" },
  "password": "your mailbox password"
}
```

```powershell
& "$env:LOCALAPPDATA\Programs\senderban\Senderban.exe" "--add-account=$env:USERPROFILE\account.json"
```

Then start Senderban again.

To offer **Block at server**: under **Accounts**, in **MXroute API key**, enter your MXroute server,
user name and API key once (it covers every mailbox and domain on your MXroute account), switch on
**Block at server** on each mail domain you want, and restart Senderban.

## Provider support

| Provider                          | Mechanism                                          | Target | Evidence                                 |
| --------------------------------- | -------------------------------------------------- | ------ | ---------------------------------------- |
| MXroute                           | Sieve (ManageSieve) + blacklist API                | v0.1   | measured 2026-10-30                      |
| Gmail / Workspace                 | Gmail filters (own OAuth client)                   | v0.1   | measured 2026-10-30, Gmail only          |
| Migadu                            | Sieve (ManageSieve)                                | v0.2   | measured on Dovecot, not on the provider |
| mailbox.org                       | Sieve (ManageSieve)                                | v0.2   | measured on Dovecot, not on the provider |
| Purelymail                        | Sieve (ManageSieve)                                | v0.2   | measured on Dovecot, not on the provider |
| Other ManageSieve server          | Sieve (ManageSieve)                                | v0.2   | measured on Dovecot 2026-10-31           |
| Outlook / Hotmail / Microsoft 365 | Graph message rules, delta for new mail            | v0.2   | documented, not yet measured             |
| iCloud, Yahoo, AOL, GMX, Web.de   | Other (IMAP): cleans on arrival, not a server rule | v0.2   | measured on Dovecot, not on the provider |

"Documented" means read in the provider's official documentation. It is not a claim that it works.
"Measured" means it ran against a real account. "Measured on Dovecot, not on the provider" means
the same code ran against a local Dovecot + Pigeonhole on 2026-10-31, and the provider's public
ManageSieve port answered with the right abilities without a sign-in. No rule was written and no
mail filtered at that provider ([ADR 0012](docs/adr/0012-generic-managesieve.md)). On the Other (IMAP)
row it means the local Dovecot only ([ADR 0014](docs/adr/0014-imap-clean.md)).
Not yet measured on MXroute: adding the `include` to a user's already-active Sieve script, and an
envelope-sender match on its own (the test mail had the same From and envelope address).

## Uninstall

Rules live on your mail server, so uninstalling does not lift a block: **Unblock** each sender first.
Windows removes the program but keeps `%APPDATA%\Senderban` (encrypted account secrets, the block
list, logs). Before uninstalling, remove each Gmail account under _Accounts_ (that also revokes
Senderban's access at Google), switch _Block at server_ off and then remove the MXroute key, remove
each MXroute mailbox; then delete the folder yourself.
Details and what was measured: [docs/adr/0010-windows-installer.md](docs/adr/0010-windows-installer.md).

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

Layout: `packages/core` (provider-agnostic logic, TypeScript) and `apps/desktop` (Electron shell).
Architecture decisions are in [docs/adr](docs/adr). Changes per version: [CHANGELOG.md](CHANGELOG.md).

Build the installer:

```sh
npm run build
npm run dist -w apps/desktop   # apps/desktop/release/Senderban-Setup-<version>.exe
```

## License

[Apache-2.0](LICENSE).
