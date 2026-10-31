# 0016 — Don't ask again

Status: accepted (2026-10-31). Covered by tests; not yet clicked on a real toast.

## Decision

A sender that is not unwanted but keeps arriving (a service's own mail, for example) should stop asking without being blocked. The toast
gets **Don't ask again**, and a list keeps those senders in `quiet.json` beside `settings.json` (`packages/core/src/notify/quiet.ts`,
`apps/desktop/src/quiet-file.ts`).

- **It lives where the toast already says what happens.** On a toast with a choice it is the last entry, and the two buttons say who, as
  for a block: **This sender** or **All of <domain>**. A Gmail toast has no choice, so it is the second button, in place of the system's
  Dismiss; the toast's own close button still dismisses it. A Gmail filter takes single addresses, and this list follows that toast's
  one scope.
- **It only keeps a toast from showing.** No mail moves, no rule is written, no provider is called, and it needs no new permission. It
  is local to the device. A forged From costs a notification and nothing else, which is why the check needs no proof of the sender.
- **It is not a block.** Never the default, never pre-selected. An entry does not undo a block or stop one. The "claims to come from your
  own address" notice and every warning still show.
- **A domain entry takes in subdomains**, as a domain block does. The click goes through `blockableDomain`, so a provider's domain or
  the person's own cannot be added, even by a click that does not match the toast.
- **Taken back on its own page**: the list has its own view in the side bar, with a filter, and shows up to 500 matching entries with **Remove**.
- **A file that cannot be used is set aside** as `quiet.json.unreadable`, and notifications show: the safe side, and the next click does
  not write over a list the person may want back.

## Why not the other ways

- **Contacts:** not readable with the permissions Senderban has. Asking for them is a new scope and a new review.
- **"I replied to this sender":** Senderban does not read it today. It would mean reading the Sent folder of every mailbox, not measured.
- **A spam score threshold:** Gmail gives no score, and unwanted newsletters may score low, so a threshold hides what the person wants to
  block. It can come later as an extra, with "all mail" as the default.

## Scale

Unit = announced mail: one lookup per label of the sender's domain, in a Set in memory, no I/O. A click is one atomic write. At most
`QUIET_MAX` = 2,000 entries bound memory, the file and the page. Saves are queued, so two quick clicks lose neither. No timer, no table.
A click still needs its pending id: past 24 hours or 200 announcements it says the message expired, and nothing changes.
