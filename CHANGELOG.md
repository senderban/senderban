# Changelog

All notable changes are listed here, newest first. Versions follow Semantic Versioning.

## [Unreleased]

### Added

- Add an MXroute mailbox in the **Blocked senders** window with its address, password and server.
  Senderban signs in over IMAP and ManageSieve first and stores nothing unless both work.

### Fixed

- ManageSieve now checks the certificate of a server reached by IP address against that address.
- Passwords with control characters or over 255 bytes are refused when an account is added.

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
