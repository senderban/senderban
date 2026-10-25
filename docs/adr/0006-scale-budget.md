# 0006 — Scale budget: what one device costs per account

Status: accepted (2026-10-25). Numbers are tagged **measured** (run in this repo, CPU only: no network, no TLS, no fsync),
**derived** (computed from constants in the code) or **unmeasured** (needs the live app or a provider). Nothing here is a
provider limit; no provider's login throttle has been measured.

## Unit and cap

Unit = account. `MAX_ACCOUNTS = 50` (`sync/engine.ts`). Everything below is linear in accounts; nothing is linear in mail volume
(a new mail is one FETCH of `From`/`Subject` and one popup, never a sync).

## Budget

| Quantity                                                             | 1 account               | 10      | 50                         | Basis                                                                          |
| -------------------------------------------------------------------- | ----------------------- | ------- | -------------------------- | ------------------------------------------------------------------------------ |
| Persistent IMAP sockets                                              | 1                       | 10      | 50                         | derived                                                                        |
| Idle keepalive cycles per hour (DONE + NOOP + IDLE)                  | 12                      | 120     | 600                        | derived from imapflow's 300 s `socketTimeout`; wire count unmeasured           |
| Reconnect attempts per hour at the backoff cap, server down          | 12–24                   | 120–240 | 600–1200                   | derived (cap 300 s, equal jitter 150–300 s)                                    |
| IMAP logins in flight after start / resume / unpause                 | 1                       | 5       | **5** (was 50)             | `MAX_CONCURRENT_LOGINS`, test `perf/storm.test.ts`                             |
| ManageSieve connections per block                                    | 2 (sync + verify)       | 11      | 51                         | derived from `notify/block-action.ts`                                          |
| ManageSieve commands per block, steady state                         | 10                      | 64      | 304                        | measured with a counting fake session                                          |
| ManageSieve connections per unblock                                  | 2                       | 20      | 100                        | derived from `notify/unblock.ts`                                               |
| Provider rounds in flight at once (sync, verify)                     | 1                       | 5       | **5** (was 50)             | `MAX_CONCURRENT_SYNCS`, test `perf/storm.test.ts`                              |
| Unblock wall time (sync + verify per account, ~2 s a round, 5 slots) | 4 s                     | 8 s     | about 40 s (was about 4 s) | derived: 2 rounds per account / 5 slots x 2 s. Typical 1–3 accounts: unchanged |
| Time to open every login at 5 slots, 2 s per login                   | 2 s                     | 4 s     | about 20 s                 | derived from MXroute login time (ADR 0003)                                     |
| Rules script per PUTSCRIPT (100 / 1000 / 5000 entries)               | 5.5 KB / 53 KB / 275 KB | ×10     | ×50 up and the same down   | measured (`renderRules`)                                                       |
| Main-thread CPU per account per block (100 / 1000 / 5000)            | 2.4 / 12.8 / ~65 ms     | ×10     | 0.12 / 0.64 / ~3.2 s       | measured; open item W4 in the baseline review                                  |
| Failing account, retry connections per day                           | 68.5                    | 685     | 3425 if all fail           | simulation of the engine's retry backoff                                       |

## Decision

1. **One shared gate per resource, not per account.** `createGate(max)` (`gate.ts`) is a FIFO semaphore. Watchers share one
   gate for IMAP logins (`MAX_CONCURRENT_LOGINS = 5`); the engine owns one for provider rounds (`MAX_CONCURRENT_SYNCS = 5`).
   Per-account lanes stay as they are. A stuck account can hold a slot only until its deadline, so it delays the others by at most
   that deadline, never for good.
2. **Every gated job has a deadline**, otherwise one stuck account would hold a slot for good: a login is abandoned after
   `CONNECT_SLOT_MS = 60 s` (a late session is closed, not leaked); the engine's `plan` now has the same timeout as
   `apply` and `verify` (the Sieve plan is local; this guards adapters that read the provider while planning). The deadline frees
   the slot and aborts a signal: the IMAP connector closes its socket at once (measured by the pre-push performance review: without
   it a provider-wide stall held 25 sockets, 5x the cap). A ManageSieve `connect()` is not cancelled; it ends by its own 15 s steps
   (at most 30 s past the deadline), so a hung Sieve login can still outlive its slot briefly (simulation peak 10 sockets, 2x the cap).
3. **A watcher that is stopped or replaced while it waits for a slot opens no login.**
4. **Resume needs no extra jitter.** Fifty `reconnectNow()` calls queue behind the gate and start five at a time.
5. **5 is a starting value, not a measured limit.** It is two named constants to tune once a provider's login throttle is measured.

## Known cost

One FIFO serves interactive and background rounds. At 50 accounts an unblock takes about 40 s instead of about 4 s, and a block
clicked while a background wave is draining can wait behind it (about 20 s at 50 accounts). Up to about 3 accounts nothing changes.
Interactive priority (a reserved slot or a two-level queue) is the fix if the pilot shows it; it needs the lane model to upgrade a
round that is already waiting, so it is not done here. `dispose()` skips rounds still waiting, so quitting never starts new provider work.

## Not done here (tracked in `.task/performance-review-baseline-2026-10-25.md`)

Auth-throttle replies treated as a wrong password (W2), `halted` accounts retried on every resume (W3), `list()` read per account
per block (W4), duplicate remote read in apply + verify (W5), no cancellation of timed-out rounds (W6), unpruned failed-sync
journal rows (W7), per-message cursor write (W9), popup/pending flood share per account (W10).

## Measure next

Unmeasured and needed before the pilot: 50 simultaneous real connections, keepalive on the wire, sleep/resume on a real laptop,
MXroute and Gmail login throttling, fsync cost of the cursor write.
