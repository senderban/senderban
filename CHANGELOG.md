# Changelog

All notable changes are listed here, newest first. Versions follow Semantic Versioning.

## [Unreleased]

### Changed

- A new window: **Blocked senders** and **Accounts** in a side bar, one **Restart now** bar, and
  **Add mailbox** with MXroute and Gmail in one place. The list can be narrowed to what sits at the
  server, in Junk or Trash, or is not applied, and each address dims its local part so that the
  domain stands out.
- **Accounts** groups mailboxes by mail domain, with **Block at server** on the domain and the state
  of each mailbox's watcher next to it. **Advanced** is gone: the key lives under **Accounts**.
- The side bar shows what Senderban is watching, and watching can be paused there as well as from
  the tray.
- The notification's domain button names the domain: **All of example.org**. A very long domain
  keeps the label **Whole domain**.

### Fixed

- A Gmail sign-in keeps offering **Restart now** after the window is closed.

## [0.1.3] - 2026-10-30

### Changed

- The MXroute API key now lives apart from your mailboxes. Removing a mailbox leaves the key alone,
  even the last one; **Remove key** under **Advanced** is the only way to delete it, and it asks
  first. It stops being used at once, before any restart. One key covers every mailbox and domain
  on your MXroute account, and a key stored by an older version moves over by itself.
- **Block at server** is now switched on per mail domain, and a mailbox removed and added back keeps
  the choice.

### Fixed

- Removing the mailbox that held the key no longer switches **Block at server** off for good on the
  other mailboxes of that domain: they pick it up at the next restart.
- After **Remove key**, or with an unreadable key file, Unblock no longer reports a sender as fully
  unblocked while it may still be on your MXroute blacklist: it tells you to delete it in your
  MXroute panel.
- The window keeps offering **Restart now** after a key is saved or removed, or a domain switched.

## [0.1.2] - 2026-10-30

### Added

- Remove an MXroute mailbox in the **Blocked senders** window. Senderban deletes its rules from the
  mail server first, then forgets the password. If the rules cannot be deleted it says so and asks.

### Changed

- Adding an account now asks first, in a box the app itself draws, naming the server that will
  receive the password.
- Closing the window during the login check cancels the add: nothing is stored.
- **Restart now** stays on offer after the window is closed and opened again.
- A saved account refreshes the list at once, and says when blocks on your list stop applying
  because that mail domain now counts as your own.

### Fixed

- A certificate that does not verify now has its own message, apart from a server that cannot be
  reached.
- An account file can no longer reuse the mailbox of another account under a new id, or take an id
  ending in `.mxroute` or `.gmail`.
- An account whose id clashes with another lane no longer stops the app at start: that account is
  skipped.
- A mail too large to read no longer stops notifications for its mailbox: Senderban steps past it
  and says how many messages it did not announce.
- More private and reserved names are refused as a mail server (`.arpa`, `.onion`, `.svc`).
- A vacation message with an odd quote in it no longer makes the active Sieve script unreadable.
  A script Senderban cannot read is not edited.
- The password field counts bytes, as the check behind it does.

### Security

- A single IMAP response is capped at 8 MiB (4 MiB per line or literal), down from imapflow's 1 GiB
  and 2 GiB defaults.

## [0.1.1] - 2026-10-30

### Added

- Add an MXroute mailbox in the **Blocked senders** window with its address, password and server.
  Senderban signs in over IMAP and ManageSieve first and stores nothing unless both work.

### Fixed

- ManageSieve now checks the certificate of a server reached by IP address against that address.
- Passwords with control characters or over 255 bytes are refused when an account is added.
- A ManageSieve login that runs out of time now closes its connection, so the password is not sent
  after the form has answered.
- Closing an IMAP session no longer waits more than 5 seconds for the server to answer LOGOUT.
- Reserved names such as `mail.test` or `mail.home.arpa` are refused as a mail server.
- An address directly under a country suffix, such as `co.uk`, no longer makes the whole suffix
  count as your own mail.

### Known limits

- An MXroute account cannot be removed in the app yet.

## [0.1.0] - 2026-10-30

First release. Windows only.

### Added

- Windows notification for each new mail, with a one-click block written on the mail server.
- MXroute: IMAP IDLE watcher, Sieve rules (Junk or Trash), whole-domain blocks, and an optional
  **Block at server** through the MXroute blacklist.
- Gmail: sign-in through your own Google Cloud project, new-mail polling, filters that move mail to
  Trash. No whole-domain block.
- One block list shared by all accounts, with a **Blocked senders** window to filter and undo.
- Per-user installer, `SHA256SUMS` and build provenance attestation. The installer is unsigned.

### Known limits

- MXroute and other IMAP accounts are added with `--add-account` and a JSON file; there is no form.
- Gmail setup needs your own Google Cloud project ([guide](docs/gmail-setup.md)).
- Outlook, Hotmail and Microsoft 365 are not supported yet (planned for v0.2).
