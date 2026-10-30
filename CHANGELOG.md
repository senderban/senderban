# Changelog

All notable changes are listed here, newest first. Versions follow Semantic Versioning.

## [0.1.0] - Unreleased

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
