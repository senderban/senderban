# 0012 — Cleaning over IMAP where no rule can be written

Status: **accepted** (2026-10-31). Measured on a local Dovecot 2.4.5 container only; no iCloud, Yahoo, AOL or GMX account has been
tried yet.

## Context

iCloud, Yahoo, AOL, GMX and Web.de let a client read and move mail over IMAP but offer no way to write a rule from a program: their
rules live in a web page. Sieve and Gmail filters are out, so the only thing Senderban can do there is move the mail itself.

This is **not a block**. Nothing reaches the server, so with Senderban closed a blocked sender's mail stays in the Inbox, and a phone
sees it until Senderban runs again. The product says so wherever it could be read otherwise: the add form, the Accounts card, the
list row and the result toast.

## Decision

1. **Its own account kind**, `clean`, next to `imap` and `gmail`. The form takes address, server, port, app password and, when it
   differs from the address, a user name: Apple's page names only the part before the @ (Apple's iCloud Mail server settings page, read 2026-10-31).
   Nothing is discovered. Port 143 means STARTTLS (RFC 9051 §2.1), any other port implicit TLS; TLS is never optional. The host must
   be a public name, as in the MXroute form, so Proton Bridge (a loopback host with a self-signed certificate) stays out.
2. **One connection per account, the watcher's.** The session opens INBOX read-write instead of EXAMINE, because MOVE needs it. It
   still reads with `BODY.PEEK`/ENVELOPE, so no flag changes, and no body is fetched. It goes back to IDLE after 1 s instead of
   imapflow's 15 s: new mail shows up only in IDLE, so 15 s would be the delay on a blocked mail arriving just after a move. A
   `CleanLink` hands the session to the adapter and takes it back when it closes.
3. **The rules are local.** The engine drives the lane like any other: `plan` diffs the list against the lane's state, and `apply`
   writes that state. `screen` enforces the list the last `plan` was given, so an Unblock stops the moving even after a failed round,
   and the engine's exclusion of the person's own mail holds here too. `verify`
   sends no command: there is nothing to read back, so it reports whether the mailbox is connected, and says **drifted** when it is
   not, because then nothing is moving.
4. **On arrival.** The watcher hands every new mail of a drain to `screen` before announcing, also past the 5 it announces. A blocked
   mail moves and gets no toast. A refused move leaves it in place, says so once and moves the cursor on, because retrying the same
   refusal would hold back every later mail; a lost connection keeps the cursor, so the next session looks again. More than one fetch can
   take (200 mails), an unreadable mail stepped over, or a renumbered mailbox (UIDVALIDITY) queues every rule for the past-mail pass.
5. **Past mail.** A new entry also clears the last 30 days, and at most 50,000 UIDs. A pass walks 5,000-UID windows down from the top
   with `UID SEARCH UID lo:hi SINCE d` until one comes back empty, then runs `UID SEARCH UID floor:top OR FROM ...`, 8 entries at a time.
   A queue of more than 256 entries, as on a first run with a long list, reads the envelopes of those UIDs once instead: 2,500 mails took 0.44 s against
   6.5 s of 313 searches on Dovecot.
   FROM is a substring match over the header, display name included, so each candidate's ENVELOPE is read and matched locally: a
   server's search result alone never moves a mail. A round stops after 10 s, keeps its queue and how far it read in state, and the engine goes on 30-60 s
   later. Every round gets through at least one step however slow the server is, and no round starts over, so a queue always ends. A queue waits with no timer while the mailbox is away; the next session starts the round. The arrival date, not the sent date,
   decides: mail moved in from elsewhere keeps an old date and sits above newer UIDs, which only widens what is read. A window whose
   UIDs were all removed ends the walk early; older mail then stays where it is.
6. **Moving.** `UID MOVE` (RFC 6851), or COPY with `UID EXPUNGE` (RFC 4315). IMAP4rev2 counts only when the session really runs it: a
   server may list rev2 beside rev1 and stay in rev1. Without either the account is refused: imapflow's fallback
   would send a plain EXPUNGE, which also deletes for good whatever else the person has marked `\Deleted`. The folder comes from
   SPECIAL-USE (RFC 6154), or from imapflow's table of localised names, or is created as `Junk`/`Trash`. `reject` files like Junk,
   as on Sieve: IMAP cannot refuse at the door. Junk wins where two rules meet, also as on Sieve.
7. **Removing the account** leaves nothing on any server, so there is no order to keep: the file first, then the lane and the watcher
   stop, then the state goes after the lane's last round. Moved mail stays where it is, and an Unblock does not bring it back.

## Limits

- Only the first address in From is matched, the one the notification shows. A Sieve `address` test looks at all of them. From is the
  sender's to write, so neither is a security boundary.
- A past-mail pass sends one UID MOVE per read, so sparse hits in a long scan cost one command each: 40 hits took 6.1 s of a 7.9 s
  round over 12,000 mails on Dovecot. Holding hits across reads would save that, and would lose them when a mail too large ends the
  connection between reads, so it stays this way.
- Saved rules act from the first mail, the list from the first round after a start. An Unblock whose round failed just before quitting
  can still move mail for that moment.
- A person who drags a blocked sender's mail back to the Inbox gives it a new UID, and Senderban moves it again. Unblock is the way out.
- A refused move is a decision, not a retry: the mail stays in the Inbox, the person is told once, and read-back reports it until a
  move works. Only a new entry or a gap looks at that mail again. The library hides the server's reason for a refused MOVE, so a
  throttled move counts as refused too.
- There is no deadline per command, only the engine's 60 s per round. A provider whose SEARCH outlasts it costs the connection, and the
  new session starts the round again. After 3 such rounds in a row past-mail clearing rests for 30 min and waits for the next list change
  or session after that; rules on new mail go on working. How long SEARCH takes on a real provider is not measured.
- Three rounds cut off in a row, by a lost connection as well, rest past-mail clearing the same way, so one mail or one bad session
  cannot turn into a login loop.
- A mail too large to read during a past-mail pass gives up the messages of that one read, at most 200, logged as `failed`: the
  connection ends on it, and the same read would end the next one.
- Provider SEARCH may differ from RFC 9051's substring rule. That can only miss mail, because rows are matched locally, but it has not
  been measured on any provider.
- Concurrent connection limits are not documented by Apple, and no official Yahoo page was found; third-party figures disagree (5 to
  15). One connection per account stays below all of them.

## Measured (Dovecot 2.4.5, loopback, 2026-10-31)

Past-mail passes over 12,000 mails and 5,000 entries took 7.9-11.6 s in 1-2 rounds. `packages/core/contract/imap-clean.contract.ts`, a real watcher and adapter on one connection, delivery over LMTP. A blocked mail was in Junk
1,044 ms after delivery began, polling included (limit: 5 s). A past-mail pass of 2 entries over 5 mails took 50 ms and moved 3.
