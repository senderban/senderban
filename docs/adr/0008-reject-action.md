# 0008 — `reject`: refuse a sender at the mail server

Status: accepted (2026-10-26). Measured on one real MXroute mailbox (2026-10-25): block from the toast, mail from the sender
refused with `550 High scoring spam message has been dropped`, unblock removes the entry. Not measured: other MXroute accounts,
the API's limit per key versus per account, behaviour for a spoofed sender.

## Decision

A fourth kind of block, `reject` (`blocklist.ts`): the address is written to the MXroute spam blacklist (API) so the server
refuses the mail at the door, and a Junk rule is kept in the Sieve script as the backup for a message that still arrives. Junk and
Trash never reach MXroute. The person chooses it in the toast: "Block at server".

**This is the one action that is not reversible in the K7 sense** (K7: no permanent delete, no discard). A later mail from that
address is refused and kept nowhere until the person unblocks it. So:

1. It is never the default; the toast lists it last and pre-selects Junk.
2. Single addresses only. A whole domain is never refused at the server (its reach on the blacklist is not measured):
   `blockPending` refuses `reject` for the domain scope and the domain button turns it into Junk.
3. Never for one of the person's own login addresses, nor for an address on the mail domain of any configured account (a
   subdomain counts; a freemail domain such as gmail.com does not count as owned, only the full login address does). The blacklist
   is shared by every mailbox of the account, and From can be forged: one click on a forged mail from a colleague would bounce
   their real mail. Enforced in core (`canRejectSender`), not only in the toast. **Accepted residual risk:** a second domain on
   the same MXroute account that no Senderban account logs in with is unknown to the app, so a forged address on it can still be
   refused. It needs the person to pick "Block at server" on that mail; Junk is the default.
4. Only addresses the blacklist takes as a single entry (`canRefuseAtServer`: its own pattern, no `*`, no leading `@`). One
   predicate is shared by the adapter, the client, the toast and the block action.
5. Off unless the person added an MXroute API key and switched the option on (Advanced). Switching it off takes back only what
   Senderban added.

## Data

Migration 3 rebuilds `entries` with `reject` in the action CHECK (SQLite cannot alter a CHECK): one transaction, rows copied as
they are. Migration 0 keeps its frozen action list. Build 888f329 mirrored every single address; it was never released, so the
first start of this build takes those addresses off the blacklist again (one request per address, 30 per round, derived from
`MXROUTE_MAX_CHANGES_PER_ROUND`). That includes an address the person had put there by hand if it was already listed when
Senderban added it (409 counts as ours). Nobody but the author ran 888f329.

## Scale (derived)

Unit = block. Junk or Trash: 0 MXroute requests. `reject`: 1 write on the lane and 1 on unblock plus one read-back list; the key
allows 60 writes a minute (header read 2026-10-25), a round sends at most 30 and the engine continues 30–60 s later. A lane exists
per (server, user, domain), not per account, so 50 accounts on one domain still send each entry once. Failures show as
`mxroute-call` log lines (operation, status, duration; no key, no address).

## Open

Whether MXroute puts a forged own-domain mail past its own checks is not measured; item 3 does not depend on it.
