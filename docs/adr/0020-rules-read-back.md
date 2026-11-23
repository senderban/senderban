# 0020 — Reading the rules back

Status: **accepted** (2026-11-22). Builds on ADR 0012 (any ManageSieve server). Measured on a local Dovecot 2.4.5
(`packages/core/contract/arrivals.contract.ts`). Not measured: at a provider, how often it happens to people, and what a webmail's own
filter editor (Roundcube) leaves of our include line when a person switches it off there.

## Context

A round is planned from what Senderban wrote last, not from the server. With nothing to change it opens no connection. So when another
program makes its own Sieve script the active one (only one can be, RFC 5228 and RFC 5804), no block works on that mailbox and nothing
notices until the next click. The same holds for a script somebody edited or deleted. And a mail of a blocked sender that did reach the
Inbox was announced like any other, with the same Block button.

A log of November 2026 showed such a mail: a domain blocked in the evening, a second arrival (a new UID) the next morning. The message that
could be inspected had been delivered seconds before the block. An IMAP move gives a message a new UID and keeps its INTERNALDATE, so a mail
moved back to the Inbox looks new to a watcher that reads UIDs only. Which of the two happened cannot be told from that log. It will be
from now on.

## Decision

1. **The delivery time is read.** The watcher's FETCH asks for INTERNALDATE. It is server data: a date outside 1982-9999 is no date.
2. **A mail of a blocked sender is recognised before anything is shown** (`coveringEntry`, the oldest entry that covers it). Delivered up
   to 2 minutes after the block: older than the rule could be, no notification, one log line. Later, or with no usable time: a leak. Its
   notification still comes, and the rules of that account are read back at once. The notice says the block is not on that server yet when
   the last finished round did not write it; otherwise that the rule is there and something before it may have kept the mail. It does not say
   that the rule ran: an include inside another filter's `if`, or after a `stop`, reads as present. Sieve accounts only: a cleaning account
   takes such mail out itself, and the polling accounts are told by their own lanes. Known limits: a mail moved back from Junk by the person
   that was delivered after the block counts as a leak, and a PC clock ahead of the server's makes a leak look older than its block (the log
   line gives the difference). A list that cannot be read never holds a mail back: it is announced.
3. **A read-back on a schedule.** 2-5 minutes after start, then every 23-25 hours, one Sieve account after another. A server that could not
   be reached is asked once more 10-15 minutes later. Accounts with nothing to do on the server, held for a removal, halted (a refused
   password is not sent again), or while paused are left out.
4. **Repair only when another script took the place.** When the one failed check is that a script of somebody else is active and does not
   include our unchanged rules, every entry is written again through the normal round: the include line goes into that script, with a backup,
   as at any block. At most once in 20 hours per account and run, so two programs do not fight. Everything else is only told: rules edited or
   deleted, no script active, our main script edited, our include taken out of a script it had been put into, an active script that cannot be
   read. Somebody meant that, or nobody knows (a program that writes its script anew looks the same). A round that saved nothing leaves no mark
   behind.
   Our main script counts as ours only when it holds exactly what we wrote. With anything else in it, it is the person's script: while it is
   active a block adds the include line with a backup; while nothing is active a block refuses to switch it on. Before 0.3.3 a block replaced
   the whole script, and a removal deleted it. A removal now takes our include out of the other
   scripts too, active or not (the first 64). One that does not run and cannot be read or edited safely is passed over: the removal must not
   be stuck on it, and the person finds the line if they ever switch that script on.
   While the rules do not run, the list says "not confirmed" for that account, until a read-back or a round says otherwise.
5. **A server that cannot be reached is not news about the rules.** It is logged only, except after a leak, where the notice says that the
   rules could not be read.

## Scale budget

Unit = Sieve account. One ManageSieve login and three commands per read-back. 1 / 10 / 50 accounts: 1 / 10 / 50 read-backs a day and as
many per start, never two at once from here (leaks wait in the same line), each inside the engine's gate and 60 s deadline. A leak adds at most one an hour per account,
a repair at most one round in 20 hours and run. Memory: two numbers per account. One timer, stopped at quit.

Log: `blocked-arrival` (arrival, kind of entry, seconds after the block), `rule-check` (why, result, failed checks), `rule-repair`.
