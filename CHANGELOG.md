# Changelog

All notable changes are listed here, newest first. Versions follow Semantic Versioning.

## [Unreleased]

### Changed

- The new-mail notification has one button per action: **Junk**, **Trash**, **Block** and **Mute**. The
  list above them now picks who it applies to, **Only this sender** or **Whole domain**, and starts on
  the sender. The buttons are fixed words, so they no longer grow with a long domain. **Mute** is what
  **Don't ask again** was in the list.
- The notification shows the sender's domain in bold with the whole address under it, and the mailbox
  the mail came to on the first line.
- **Block** is on a notification only after you turn on **Block at server when the mailbox can** in
  **Settings**. Before, it was always in the list and the switch only pre-selected it.
- A Gmail notification has **Trash** and **Mute**; its button is no longer red. Red is for **Block**.

## [0.2.0] - 2026-11-01

### Added

- **Find my provider** on **Add mailbox**: type your address and Senderban reads your domain's mail
  records, asks the mail server what it is without signing in, and fills in the right form. Nothing is
  saved until you add the mailbox yourself. See [ADR 0018](docs/adr/0018-provider-detection.md).
- **Settings** page: the action a notification starts on (Junk or Trash), an opt-in to start on
  **Block at server** where the mailbox offers it, **Confirm each block**, and how long new-mail
  notifications stay on screen (Short, Long or Until I close them). See
  [ADR 0015](docs/adr/0015-settings-page.md).
- **Don't ask again** on a notification stops the notifications from a sender or a whole domain. It
  moves no mail and writes no rule, and its own page lists those senders, with a filter and **Remove**. See
  [ADR 0016](docs/adr/0016-dont-ask-again.md).
- **Spam filter** on each mailbox on a mail server, in **Accounts**: Low (score 15 or more), Medium
  (10) or High (5). The server moves that mail to Junk or Trash, also while Senderban is closed, or the
  notification says the mail is over your limit. It never blocks a sender by itself, and it needs a
  mail server that adds a spam score. See [ADR 0017](docs/adr/0017-spam-filter.md).
- Every notification now says what it cannot offer, for example "This mailbox has no block-at-server
  option".
- **Add mailbox** now takes any mail server that speaks IMAP and ManageSieve: pick MXroute, Migadu,
  mailbox.org or Purelymail, or **Other mail server** with your own host and port. The presets were
  checked on the providers' public ports without signing in; the rules themselves were measured on
  a local Dovecot, not on those providers.
- Before any password leaves the device, Senderban asks the ManageSieve port what it is, so a server
  without it, without encryption or with a bad certificate is named as such.
- **Outlook and Microsoft 365:** sign in with your Microsoft account, no setup of your own. Your block
  list becomes rules on the mailbox, so every mail app follows, and a sender goes to Junk or Deleted
  Items at the server. New mail shows a notification within about a minute. A work or school account
  whose organization must approve Senderban gets a link to send to its administrator. Measured on a
  personal Outlook.com account: sign-in, the notification, an address block written as a rule and
  read back, a domain block, Unblock, several blocks sharing one rule, and removing the account with
  its rule. A work or school account is not measured yet ([ADR 0013](docs/adr/0013-graph-adapter.md)).
- On Outlook, a domain block right under `.co`, `.ne`, `.in` or `.bi` is refused, because Outlook
  matches the text and the rule would also catch the same name under `.com`, `.net`, `.info` or
  `.biz`. Block the address instead. A domain under a longer suffix such as `.co.in` is written.
- **Other (IMAP)** under **Add mailbox**, for mailboxes with no rule Senderban can write (iCloud, Yahoo,
  AOL, GMX, Web.de). This is cleaning, not a server rule: while Senderban runs it moves a blocked
  sender's new mail to Junk or Trash, and clears the last 30 days of the Inbox when you block someone.
  With Senderban closed the mail stays in the Inbox. Measured on iCloud with one address block. Yahoo,
  AOL, GMX and Web.de ran on a local Dovecot server only.

### Changed

- Adding a mailbox or signing in to Gmail or Outlook restarts Senderban on its own a moment later, so
  the new account is watched without a click; the window opens again on **Accounts** if it was open.
  **Restart now** stays for removals and key changes, while watching is paused, and when a step is
  still running.
- A block that worked no longer shows a notification unless **Confirm each block** is on. Warnings
  and failures always show.
- The notification reads in two columns: the subject and the account on the left, the spam score on
  the right, with a green, yellow or red line for its level.
- New logo: a blue envelope with a red ban sign.
- On Windows 11, **This sender** uses the red button style that the Gmail button already had.
- Gmail no longer needs a Google Cloud project: the installer comes with Senderban's own client and
  you sign in with your Google account. Your own project stays available under **Use my own Google
  project (advanced)**.
- Servers without the Sieve `include` extension work: Senderban's rules become the active script
  when that place is free. A mailbox with its own active script on such a server is refused when
  added, and that script is never touched.
- A server that sends its capabilities in clear behind the STARTTLS reply is no longer refused. Those
  bytes are dropped unread and the capabilities are asked for over TLS.
- The MXroute key card shows only when you have an MXroute mailbox or a saved key.

## [0.1.4] - 2026-10-31

### Changed

- A new window: **Blocked senders** and **Accounts** in a side bar, one **Restart now** bar, and
  **Add mailbox** with MXroute and Gmail in one place. The list can be narrowed to what sits at the
  server, in Junk or Trash, or needs a look, and each address dims its local part so that the
  domain stands out.
- **Accounts** groups mailboxes by mail domain, with **Block at server** on the domain and the state
  of each mailbox's watcher next to it. **Advanced** is gone: the key lives under **Accounts**.
- The side bar shows what Senderban is watching, and watching can be paused there as well as from
  the tray.
- The notification's domain button names the domain: **All of example.org**. A long domain keeps
  its end, **All of …attacker.example**, because Windows cuts a button with no ellipsis.
- The domain button is no longer offered for a public suffix or a shared host (Public Suffix List,
  through `tldts`), or for more mail providers. A domain already on your list keeps working.

### Fixed

- A Gmail sign-in keeps offering **Restart now** after the window is closed.
- **Blocked senders** no longer says more than it knows: while a mailbox's last update failed, its
  entries read **Not confirmed**, count under **Needs a look** and a line names the mailbox. **At
  server** holds only what a running server blacklist holds.
- Pause and Resume no longer leave a mailbox unwatched when the tray and the window are used
  together, and Pause waits for every mailbox at once.
- Pause and Resume no longer send a refused password again: a stopped account stays stopped until
  you sign in again or restart.

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
