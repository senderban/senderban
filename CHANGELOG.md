# Changelog

All notable changes are listed here, newest first. Versions follow Semantic Versioning.

## [Unreleased]

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
