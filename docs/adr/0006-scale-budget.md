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

## MXroute blacklist lane (2026-10-25)

An account with an MXroute key can switch on a second engine lane that mirrors single blocked addresses onto the MXroute spam
blacklist (the server then rejects their mail at SMTP time: measured, `550 High scoring spam message has been dropped`, 007 S5).
Unit = one MXroute blacklist, that is one (server, user name, mail domain); accounts that share one share a lane. `MAX_LANES = 100`.
Provider limits: 60 writes and 200 reads per minute (header `x-ratelimit-limit`, measured 2026-10-25); the bucket's scope (key, user,
IP) and window type are **unmeasured**, sliding window assumed.

| Quantity                             | 1 lane                                                                  | 10            | 50               | Basis                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------- | ---------------- | --------------------------------------------------------------------------------------- |
| Idle: sockets, timers, requests      | 0                                                                       | 0             | 0                | no timer in `mxroute/`; the engine's timers only exist after a trigger                  |
| Switched off and nothing mirrored    | 0 requests                                                              | 0             | 0                | plan has no change; `verify` returns without a request (measured, test)                 |
| Block: requests per lane             | 1 POST                                                                  | 10            | 50               | measured (fake server)                                                                  |
| Unblock: requests per lane           | 1 DELETE + 1 GET (read-back)                                            | 10 + 10       | 50 + 50          | measured; the removal is only counted once the entry is gone from the list              |
| Changes per round                    | at most 30 (`MXROUTE_MAX_CHANGES_PER_ROUND`)                            | same          | same             | plan is capped; the rest is `deferred`, the engine continues 30-60 s later              |
| Writes per minute, one lane          | at most 30 per 30-60 s                                                  |               |                  | derived; 429 is read as "later", a 429 on the first request backs off                   |
| Backlog of B addresses: rounds, wall | ceil(B/30), 30-60 s apart                                               | same per lane | same per lane    | derived: 500 -> 17 rounds, 9-17 min; 5000 -> 167 rounds, 2.5-5 h (RTT unmeasured)       |
| Round time budget                    | 20 s + last request 15 s + read-back 15 s = 50 s < engine deadline 60 s |               |                  | constants; progress is kept, so a slow API cannot restart every round                   |
| Gate                                 | own gate, 2 rounds at once (`MAX_CONCURRENT_BACKGROUND`)                |               |                  | a backlog on 50 lanes cannot hold the 5 slots a click waits for                         |
| Journal bytes per round              | at most 30 changes                                                      |               |                  | the plan is capped (a whole-backlog plan was quadratic: 43.5 MB per lane at 5000)       |
| State row per lane                   | 164 B per mirrored address                                              |               | 41 MB at the cap | measured at 5,000 entries                                                               |
| A refused key                        | 1 request, then held off 30 min                                         |               |                  | AUTH_REQUIRED latch (`AUTH_BLOCK_MS`)                                                   |
| A round with no progress             | backs off like any failure                                              |               |                  | engine: only a round that made progress, or deferred changes, keeps the 30-60 s spacing |
| Quota: per-minute limit, daily cap   | the 30-per-round constant and spacing; no per-key limiter, no daily cap |               |                  | $0 upstream (not metered); risk is a flagged key, unmeasured                            |
| Log                                  | `mxroute-call`: operation, HTTP status, ms (no key, no address)         |               |                  | one line per request, at most 30 per round                                              |

Unmeasured: MXroute round-trip time, whether a DELETE is immediately consistent with the next GET, the bucket scope, what the
server does at the limit beyond the status code. Next measurement: 70 requests with a throwaway entry (`.task/performance-review-mxroute-lane-2026-10-25.md`, "Measure next").

## Not done here (tracked in `.task/performance-review-baseline-2026-10-25.md`)

Auth-throttle replies treated as a wrong password (W2), `list()` read per account
per block (W4), duplicate remote read in apply + verify (W5), no cancellation of timed-out rounds (W6), unpruned failed-sync
journal rows (W7), per-message cursor write (W9), popup/pending flood share per account (W10).

## Measure next

Unmeasured and needed before the pilot: 50 simultaneous real connections, keepalive on the wire, sleep/resume on a real laptop,
MXroute and Gmail login throttling, fsync cost of the cursor write.
