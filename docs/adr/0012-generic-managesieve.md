# 0012 — Any ManageSieve server, not only MXroute

Status: **accepted** (2026-10-31). Builds on ADR 0011 (the MXroute key). Measured on a local Dovecot 2.4.5 + Pigeonhole, twice: as
shipped and with `include` switched off. Nothing here was measured with a real mailbox at Migadu, mailbox.org or Purelymail.

## Context

The Sieve adapter speaks RFC 5804, and only the form, its texts and the measurement were tied to MXroute. Reading what three
providers say on their public ManageSieve ports, with no sign-in, showed that a new label was not enough:

| Provider    | ManageSieve host          | `include` | Behind verified TLS                                              |
| ----------- | ------------------------- | --------- | ---------------------------------------------------------------- |
| Migadu      | imap.migadu.com           | no        | PLAIN offered; `fileinto`, `mailbox`, `envelope` present         |
| mailbox.org | imap.mailbox.org          | yes       | PLAIN offered; `fileinto`, `mailbox`, `envelope` present         |
| Purelymail  | mailserver.purelymail.com | no        | as above, but only after a `CAPABILITY` command (see Decision 5) |

The adapter required `include`, so every round on Migadu and Purelymail would have failed, and it refused Purelymail's connection
outright.

## Decision

1. **One kind of account, a provider field.** `provider` says who runs the mailbox. An account without it is from before 0.2, when
   the form made MXroute accounts only, and counts as MXroute. Consequence: 0.1.x refuses unknown fields in `accounts.json`, so going
   back to 0.1.x with such a file needs the field removed by hand.
2. **A preset's servers are chosen in the main process.** For Migadu, mailbox.org and Purelymail the form sends no host, and the schema
   refuses one: the page never says where a password goes. MXroute and "Other mail server" keep a typed host, and only "Other" has a
   port. IMAP stays TLS on 993 and the login stays the address; any other setup uses `--add-account`.
3. **What belongs to MXroute stays with MXroute.** The key card appears only with an MXroute mailbox or a stored key. A key is offered no
   domain from elsewhere, no blacklist lane runs for one, and a mail domain hosted elsewhere is not told it needs a key.
4. **The first step of the check sends nothing of the person's.** `probeManageSieve` runs STARTTLS, verifies the certificate and reads
   the capabilities, then closes. A host without ManageSieve, without STARTTLS, with a bad certificate or without PLAIN answers before
   any password left the device, each with its own sentence. A lane that meets a greeting without STARTTLS sends nothing and tries
   again: only an unauthenticated greeting says so, and it must not stop the lane. It retries at the engine's line with no stop: 7-9
   connections in the first hour, then 2-4 an hour, 53-101 a day per lane, 100-200 an hour at 50 lanes (measured 2026-10-31, real
   `SyncEngine`). Each one is a connect, a greeting and a close, so it carries no credential and no lockout risk.
5. **Bytes behind the STARTTLS reply are dropped unread, not refused.** Purelymail sends its capabilities in clear right behind the
   reply and nothing after the handshake (3 of 3 connections, 2026-10-31); RFC 5804 §2.2 wants them after TLS. Refusing such bytes was
   stricter than needed: the channel holding them is thrown away with them, so nothing injected reaches the parser, and the password
   still goes only through verified TLS, on capabilities that came through it. Such a server is asked with `CAPABILITY`, followed by a
   `NOOP`. ManageSieve has no tags and the server may or may not repeat itself, so the reply without data closes the exchange and
   nothing is left to answer the next command. A compliant server that sent no clear bytes is never asked. The price is one round
   trip per connection on such a server.
6. **Without `include`, the rules script itself is the active one.** RFC 5804 allows one active script, so this works only while the
   place is free. A person's own active script on such a server is left alone: the add form says so and saves nothing, and a later round
   writes nothing and fails with `CAPABILITY_NOT_SUPPORTED`. Merging rules into someone's script is not attempted.

## Departure from the standard

RFC 5804 §1.8 has a client look up `_sieve._tcp.<domain>` before falling back to 4190. Senderban does not: the person names host and
port, `nslookup` found no such record for any of the three providers (2026-10-31), and unsigned DNS should not choose where a password
goes. If a provider ever depends on it, the record can fill the form, with the person confirming the name.

## Scale budget

Per account added, by a person, one at a time: one more TCP and TLS connection and one `LISTSCRIPTS`. A sync round sends the same commands
as before, plus one `CAPABILITY` and `NOOP` exchange per connection on a server that spoke in clear. A round opens one connection to
write and one to verify. Nothing shared grows with the account count at 10x or 50x. `reachMs` in the `account-added` log line shows what the new step costs.

## Measured

- Blocked sender delivered over LMTP landed in Junk and another sender in INBOX, with and without `include`
  (`generic-sieve.contract.ts`). Without it: block, deliver, verify, unblock, deliver, uninstall.
- The real `checkAccount` against Dovecot: ok, refused password, port that is not ManageSieve, closed port (`account-check.contract.ts`).
- A stand-in for the clear-reply behaviour, with forged capabilities in the clear bytes (`starttls-clear-reply.test.ts`, in `npm test`).

## Accepted risks

- **The active place can still be lost in one round trip.** On a server without `include` a round reads the script list before its
  first write, and again right before `SETACTIVE`. A script the person activates between that last read and `SETACTIVE` is switched off,
  not edited or deleted, and `verify` then sees our script active and reports nothing wrong. Only a round that takes the active place
  can do this. A server with `include` has a wider window of up to three commands when Senderban's own main script is activated, as it had before this change.
- **A free host and port reach what they can reach.** "Other mail server" refuses private names and addresses, but a public name may
  resolve to an internal address (DNS rebinding, wildcard DNS services). Each try needs a click in a main-process dialog naming the host
  and port, carries no data of the person's until the probe passes, and answers one fixed word. Resolving the name and refusing private
  addresses is not done: it adds a step that does not stop rebinding.
- **Clear bytes split across two packets** would reach the TLS handshake. This is untested. The expected result is a failed handshake,
  a retried round, and "ManageSieve did not answer" in the add form. Every connection so far delivered them in one packet.

## Not measured

- Any sign-in, rule, delivery or removal at Migadu, mailbox.org or Purelymail. The README says so per provider.
- `imap.mailbox.org`: its ports are documented, its host only in a user forum. It answered ManageSieve and IMAP under a verified
  certificate on 2026-10-31.
- **A lost answer to the last write can still strand the rules script.** The first write is now the empty rule set, so a round that fails before
  the real rules go up leaves a script the next round adopts. If the server took the real rules and the answer never arrived, the script stays
  unrecorded, and a later round with a different list stops with `REMOTE_CHANGED`. Same on every server, and refusing there keeps a person's
  edit safe: an unrecorded script with entries cannot be told from one they changed.
- **The 60 s deadline can still lose the copy of a person's script.** A failed last write saves the copy made in that round, and the changes
  count as failed. If that write outlasts the round's deadline, the engine has already given up and nothing is saved. Removal then drops our
  two lines by hand, and a `require "include";` it added stays.
- Junk and Trash folder names at those providers. `fileinto :create` makes a folder of that name if theirs differs.
- A webmail filter editor that rewrites the active script could drop the `include` line. `verify` reports that as drift.
