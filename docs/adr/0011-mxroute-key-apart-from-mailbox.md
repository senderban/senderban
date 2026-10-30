# 0011 — The MXroute API key lives apart from the mailbox

Status: **accepted** (2026-10-30). Builds on ADR 0008 (the reject action). Measured on 2026-10-30, on one real MXroute account with
version 0.1.2: **Remove** on a mailbox deleted its key too, and the blacklist lane was gone at the next start.

## Context

An MXroute key belongs to the login: it reaches every mailbox and domain of that login. Up to 0.1.2 it was stored inside one mailbox,
so removing that mailbox lost a key the other mailboxes needed, and "Block at server" stopped on them with no message. Each domain
also needed the key typed again.

## Decision

1. **The key has its own file**, `mxroute-keys.json` next to `accounts.json`, the same way `google-client.json` holds the app-wide
   Google client. One record per (server, user name). Its own file because every writer of `accounts.json` would otherwise have to
   carry it, and because 0.1.2 refuses unknown fields in `accounts.json` but ignores a file it does not know.
2. **Removing a mailbox never touches a key**, not even for the last mailbox. Only **Remove key** under **Advanced** does, after a
   question drawn by the main process with Cancel as the default: without the key, Unblock can no longer reach the blacklist. The
   key's lanes stop at once, before any restart: new toasts stop offering **Block at server**, and a toast already on screen says
   the server will not refuse. A key with no mailbox stays until
   the person removes it.
3. **The "Block at server" choice belongs to the domain**, because the blacklist does. It is stored on the key, so a mailbox removed
   and added back keeps it. A domain joins a key the first time it is switched on, and stays there when switched off: its lane then
   takes back what it added (ADR 0008).
4. **A domain has one key.** A blacklist with two writers would have each taking the other's entries for its own.
5. **Lanes keep their ids**: one per domain that has a mailbox, with the id `<mailbox>.mxroute`. No store migration. The owner is
   the mailbox whose lane has stored state, else the first mailbox on the domain: 0.1.2 gave the lane to the first mailbox holding a
   key, and a new owner would lose what the old lane knew. When the owner is removed the next mailbox takes over at the next start, from an empty state; it counts an address
   already on the blacklist and still on the block list as its own (ADR 0008). An address unblocked between that **Remove** and the
   restart stays on the blacklist until the person deletes it in the MXroute panel: the lane that knew it is gone. Keeping that state
   across owners would need a lane id per domain and a store migration, which a window of minutes does not justify. A domain with no
   mailbox has no lane; its entries stay on the blacklist and **Remove** says so. After **Remove key**, or with an unreadable key file, an Unblock of an address that the lane had put there says so in the window, from the lane's stored state: the green "read back" would be untrue, because the sender's mail goes on being refused. After a **Remove** of the owner that state is gone, so the Unblock cannot tell.
6. **Checks.** Saving a key calls `GET /domains`, which needs no domain, so a key can be saved before any mailbox exists. The first
   switch-on of a domain calls the blacklist `list` for that domain. The domain comes from the page, so it must also be the domain of
   a configured mailbox.
7. **Moving old keys.** At start, a key found inside a mailbox moves to the key file: the key file is written first, then the mailbox.
   A crash in between leaves both and the next start merges again. For one login the first key wins; the blacklist of a domain is on
   when any of its mailboxes had it on. A domain already in the key file keeps what the person chose there, and **Remove key** also
   deletes a copy left in a mailbox, so a failed second write cannot bring a removed key or a switched-off domain back.
8. **Trouble with the key file does not stop the app.** A file that fails validation means no blacklist lane and a log line
   (`mxroute-keys-failed`); blocks go on through Sieve, and **Block at server** is not offered. The window tells the person to delete
   the file and save the key again: it holds nothing that cannot be typed again. A key change reaches the running lanes at the next
   start, and the window says so.

## Scale (derived)

Unit = click, under one a minute. Save: 1 `GET /domains`. First switch-on: 1 blacklist `list`. Re-enable, switch-off, Remove key,
Remove mailbox: 0 requests. No timer, no table, no periodic work. Start in steady state: 0 MXroute requests; it reads the key file
once and `accounts.json` twice (the move looks first), and writes twice, fsynced, once only, when a mailbox still holds a key. A
lane's unit is now a domain under a key (ADR 0006 still says server, user name, mail domain).

| Domains                  | Lanes | Start, steady state | Key file + `accounts.json` parse for the page |
| ------------------------ | ----- | ------------------- | --------------------------------------------- |
| 1                        | 1     | 0 requests          | 0.31 ms                                       |
| 10 (10x)                 | 10    | 0 requests          | 1.14 ms                                       |
| 50 (50x, `MAX_ACCOUNTS`) | 50    | 0 requests          | 8.25 ms                                       |

Parse times measured in memory on 2026-10-30, 50x at the schema's maximum; disk reads not measured. Lanes grow with domains that have
a mailbox, at most `MAX_ACCOUNTS` (50), as before. Limits: 50 keys, 50 domains on a key, 2 MiB file (worst case ~1.15 MB). Network calls run outside the `accounts.json` write queue; the file writes share
it. Every call has the 15 s MXroute deadline.

Share: a key allows 60 writes a minute (ADR 0008) and all its domains spend from them. A lane sends at most 30 a round, so three or
more busy domains on one key can meet a 429; the adapter already handles that as "later" and sends nothing twice. This was true before
when one key was pasted into several mailboxes; it is only more visible now.

Logs: `mxroute-saved`, `mxroute-removed`, `mxroute-enabled` (a hash of the login, and the outcome), `mxroute-migrated` (how many
mailboxes), `mxroute-keys-failed`, and `mxroute-call` for both checks (a hash of the login, operation, HTTP status, duration).

## Not measured

A key limited so that it cannot list domains (saving it would answer "refused"), two logins on one device, and the move from a real
0.1.2 file. `GET /domains` with a full key was measured on 2026-10-30, on one real MXroute account: the save answered "saved".
