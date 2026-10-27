# 0009 — Gmail account (own OAuth client): sign-in, storage, filters, new-mail watcher

Status: **proposed** (2026-10-26). Nothing here is measured on a real Gmail account yet. Facts below marked "read" come from Google's
pages read on that date; "from memory" and "not measured" are marked where they appear. Builds on 006 K6/K7/K8/K10 and ADR 0006/0008.

## Decision

Gmail joins as a second account kind, v0.1 **bring your own OAuth client only** (006 K6): the person makes a Google Cloud project with a
Desktop-app client and gives Senderban its client ID. No client ID or secret is in the repository.

1. **Sign-in.** Authorization code + **PKCE (S256)** + loopback redirect `http://127.0.0.1:<random port>` — read: Google requires PKCE for
   native apps, a Desktop client is a public client, `client_secret` is documented as optional (live: it is required, see Data), `redirect_uri` must match the
   registered one exactly (<https://developers.google.com/identity/protocols/oauth2/native-app>). The browser is opened with
   `shell.openExternal` on a URL Senderban builds itself (fixed host `accounts.google.com`, never a value from the renderer).
   The listener (RFC 8252 §8.3: open the port only for the request, close it when the answer is in) keeps listening until a request
   arrives that is `GET`, on the exact redirect path, with `Host` exactly `127.0.0.1:<port>` and the matching `state`; anything else gets
   a 400 with no echo, at most 20 requests, then it closes. It also closes after a time limit (5 min, PROVISIONAL; the code keeps it in milliseconds), at
   once on `error=access_denied` (shown as "cancelled"), and on quit. Sign-in is single-flight (a double click starts one listener, one
   tab). The answer page is static: `error_description` is never reflected.
2. **Scopes.** `gmail.settings.basic` (filters) and `gmail.metadata` (From/Subject for the toast), nothing wider. All four Gmail scopes
   are **Restricted** (read: scopes page). `history.list` accepts `gmail.metadata` among others (read: history.list page).
   Which scope `filters.create` needs is **not stated on the filters page** (read) — measured in G1, not assumed.
   **The granted scopes are checked** (read: Google says people may grant fewer, and the app must check): the `scope` of the token
   response must be exactly these two. Without `settings.basic` the account cannot block (the toast hides Block for it and says why);
   without `metadata` there is no watcher; an extra scope is refused and explained and not stored. Gmail answers **403 for both** a rate
   limit and a missing permission (read: handle-errors guide), so an error is classified by `error.errors[].reason`, never by status:
   permission → `AUTH_REQUIRED` (no retry); rate → `QUOTA_EXCEEDED`/`TRANSIENT` with backoff.
3. **Tokens.** Refresh token only, as `safeStorage` ciphertext (DPAPI) like the IMAP password; the access token stays in memory and is
   never written to disk or log. A refresh answering `invalid_grant` is shown as "sign in again", never retried in a loop.
   **Identity:** `email` always comes from `users.getProfile.emailAddress` (it accepts `gmail.metadata`), never typed. A re-sign-in that
   returns another address is refused, because it would rebind the lane to another mailbox and orphan the first one's filters. The
   mailbox is compared by `mailboxKey` (Gmail's dot, `+tag` and `googlemail.com` spellings are one inbox). **A refused sign-in does not
   revoke the token it got** (read: Google's revoke removes every grant of the project, so it would break an account that is already set
   up); the person is told the leftover access can be removed under Google Account permissions.
   **Removal** of a Gmail account is, in this order: uninstall our filters, revoke the token (`POST oauth2.googleapis.com/revoke`), delete
   the ciphertext; only a revoke that Google answered with `invalid_token` counts as "already gone", any other failure keeps the stored
   token and says so (the person can retry, or revoke it under Google Account permissions). **Changing the app-wide OAuth
   client** makes every stored refresh token unusable (a token is bound to its client): it revokes the old tokens first, signs every Gmail
   account out, and says so before it saves.
4. **Filters** (`BlockAdapter`): Gmail has `create`, `delete`, `get`, `list` and **no update** (read), so a change is create-then-delete,
   as K8 already says. Default and only action: add label `TRASH` (reversible, K7); a filter does **not** accept `SPAM` (measured, G2:
   `400 Invalid label SPAM in AddLabelIds`). No `reject` and no
   domain-wide server refusal on Gmail (ADR 0008 stays MXroute-only).
   - **Query encoding contract** (security review 2026-10-26, BLOCK-1: `parseAddress` accepts `-x@spam.example`, `+x@…`, `{a}@…`,
     `*@gmail.com`, and `criteria.query` "supports the same query format as the Gmail search box", where `-` excludes and `{ }` is OR; how
     Gmail reads `-` inside `from:( … )` is **not measured**, so this is built as if it were an operator):
     1. every address is emitted as a double-quoted phrase, `from:("a@x.com" OR "b@y.com")`; a canonical address has no `"`, space or
        parenthesis, so a term cannot close its quote;
     2. on top of `parseAddress`, the Gmail lane takes only local parts matching `^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$`; any other
        entry is `CAPABILITY_NOT_SUPPORTED` **for the Gmail lane only**, and the result toast says "not blocked on Gmail". It is never
        written and never silently dropped;
     3. `criteria.from` also matches the sender's **display name** (read), so it is wider than Sieve `address :is`; the domain terms and the
        `exactDomain`/`subdomains` capabilities are declared only after G1 has measured the match;
     4. `verify()` reads each filter back and compares criteria and action byte for byte with what was compiled.
   - **Ownership** is the filter **id in this lane's state** **plus** exact equality of criteria and action on read-back (criteria
     exactly `{ query }`, action exactly `{ addLabelIds: ["TRASH"] }`). No marker in the criteria: `query` and `negatedQuery` are free
     text, so a marker changes what the filter matches, and a constant in this public repo would let any sender walk past every filter.
     **The engine drops a round at 60 s together with what `apply` returned**, so the state must be saved _during_ the round
     (the adapter takes a `checkpoint` callback, bound to `store.setState` for the lane): an **intent** (the entries about to be
     written, and the filter they replace) is saved before each `create`, the new filter right after it, the delete after that.
     Gmail refuses a second identical filter (`400 failedPrecondition`, measured 2026-10-27), so a create whose answer was lost cannot
     make a duplicate: the next round reads the list, and a filter with exactly an intent's content that is not in the state is that
     create, and is taken in; the filter it replaced becomes `stale` and is deleted first. An identical filter that was already there
     when a round began and matches no intent is **not ours** (the person's, or another install's): never adopted, edited or deleted;
     its addresses are recorded as `refused` (they are blocked by it) so one of them cannot hold up the rest. A filter of ours that no
     longer reads as written is forgotten, never touched, and what is still wanted goes into a new filter. Narrow race, accepted: an identical filter that
     appears while a create of ours is unconfirmed (an intent) is taken for ours when the next successful list settles that intent: the
     seconds between a round's list and its create, or longer if rounds keep failing before the list (a dead token). It is a
     second Senderban install's identical filter that could be adopted, never a filter the person wrote with other criteria or actions.
5. **Watcher.** `users.history.list` with `startHistoryId`, `historyTypes=messageAdded`, `labelId=INBOX` (the IMAP watcher reads INBOX
   only; without it the person's own sent mail and drafts would be announced with a Block button on their own address), then
   `messages.get` with `format=metadata` for the new ids only, re-checking the message `labelIds`. Paging is capped per drain (excess
   goes to the existing overflow notice, as on IMAP); `historyId` is a `^[0-9]{1,20}$` string compared as a BigInt, never a `Number`.
   A `404` means the id is too old (read: valid "typically at least a week, rarely a few hours"): drop the cursor, take a new `historyId`
   from `getProfile`, and **tell the person** that mail in the gap was not announced (the same notice as an IMAP overflow), and log it.
   The cursor lives in the store like `imap_cursor`.
   **Sender address from the raw `From` header** (security review FLAG-1; the IMAP path gets a bare address from ENVELOPE, Gmail returns
   header text): accept exactly one `From` header holding exactly one mailbox; take the addr-spec inside `<>` when there is one, then
   `parseAddress`; anything else (two mailboxes, two `From` headers, group syntax, comment, display name that looks like an address) is
   announced without Block buttons, or not at all, and logged as the fixed word `from-unparsable`. A display name is never an address
   (`"boss@co.com" <x@spam.example>` must offer `x@spam.example`). The subject goes through the same sanitiser as on IMAP.
6. **Toast.** The choices a Gmail account can honour decide the buttons: Trash only ("Move to Junk" is not offered for Gmail: a filter
   cannot add `SPAM`, measured); "Block at server" never. When one block spans accounts of different kinds, the person's choice is applied where it exists and the result toast says
   where it was not (same wording rule as ADR 0008 point 3).

## Data

`accounts.json` keeps `version: 1`. `AccountConfigSchema` becomes a union of two strict objects, so an existing file (IMAP/Sieve,
MXroute) loads unchanged and needs no migration:

- IMAP/Sieve account — today's shape.
- Gmail account — `{ id, gmail: { email, refreshCipher } }` (shipped in step A0), `strictObject`, no `imap`/`sieve`. `email` must be in the canonical form `parseAddress` returns.

`gmail.email` is unique across Gmail accounts and does not equal any IMAP/Sieve login (a second lane over one mailbox would plan and
delete over one filter set).

App-wide, once, not per account: `googleClient: { clientId, secretCipher }` (one Desktop client serves several Gmail accounts). **The
secret is required, not optional**: Google's page calls `client_secret` optional for a Desktop client, but a refresh without it was
answered `400` live (2026-10-26, measured); the real client made on that day has a 72-character ID and a 35-character secret.
It is entered through one IPC channel that follows the MXroute key precedent (`manage.ts`): trusted-frame check, a `strictObject`
`{ clientId, clientSecret }` with the named limits below (secret: printable ASCII without space, PROVISIONAL 1–256), a reply that is a
fixed word, the secret never sent back. The sign-in channel carries no URL and no scope, at most an `accountId` for a re-sign-in. Where it
is stored: **`google-client.json` next to `accounts.json`** (decided in A1b; `AccountsFileSchema` is a strict `{ version, accounts }`), a strict
`{ version: 1, clientId, secretCipher }`, read with a 16 KiB cap. Saving the **same client ID with a new secret keeps every token** (the tokens are bound to the ID);
a **different ID** needs the person's confirmation, revokes the stored tokens with the old client (at most 5 at a time), signs the accounts out and only then saves.
A client file that cannot be read is replaceable from the page (it shows as "no client"): the signed-in accounts are signed out **without** a revoke (there is no
client to revoke with) and the page says the access Google still lists can be removed under Google Account permissions.
A signed-out account keeps its id and address and has no `refreshCipher` (the field is optional since A1b).
`gmail.accessEndsAt` (optional, epoch seconds, 2001-09-09 to 2100-01-01) is stored at sign-in as now + `refresh_token_expires_in` when Google limits the token
("Testing": 7 days); the page shows the end date and, after it, "Access expired" (a token that cannot refresh must not read as "Signed in"). A new sign-in replaces it or clears it.
The secret is not confidential for a Desktop client (read), so `secretCipher` is hygiene, not protection.
Bounds (PROVISIONAL until a real value is seen, tighten then, same rule as `MXROUTE_LIMITS`): clientId 1–128 ASCII, matching
`^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$` (shape from memory); ciphertext reuses `Ciphertext` (≤ 8192). `email` is checked
with the existing address validation. UI, Zod and file use the same numbers (rules/security.md).
Code that reads `account.imap` / `account.sieve` (`main.ts` lines around 272, 281, 309, 371; `mxroute-settings.ts`) must narrow by kind
first: this refactor is the first code step and ships alone, with the existing 430 tests as the safety net.

## Scale (derived, quotas read 2026-10-26)

Unit = Gmail account. Quota units read: `history.list` 2, `messages.get` 20 (metadata), `filters.create` 5, `filters.delete` 5,
`filters.list` 1, `getProfile` 1; limits 6,000 units/min/user and 1,200,000 units/min/project.

| per account            | requests                                                  | units                                                   |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| watcher idle           | 1 `history.list`/min = 1,440/day                          | 2,880/day                                               |
| new mail               | 1 `messages.get`; ≤ 5 per drain (`DEFAULT_MAX_PER_DRAIN`) | 20 each → ≤ 100 per drain                               |
| 50 mails/day (assumed) | 50 `messages.get`                                         | 1,000/day → **≈ 3,900/day**, the K8 figure, now derived |
| one block change       | 1 `filters.list` + `create` + `delete` + verify `list`    | ≈ 12                                                    |

10× (10 accounts): 10 requests/min, ≈ 39k units/day; 50× (`MAX_ACCOUNTS`): 50 requests/min, ≈ 195k units/day, 100 units/min on the
project against 1.2M/min. Each Gmail account is its own "user", so the 6,000/min per-user limit is not shared between accounts.
The wall that matters is not quota but **sleep/resume**: 50 accounts reconnecting at once must be spread (jitter + a cap on parallel
refreshes), as in the watcher's backoff (`DEFAULT_BACKOFF`). Not measured: real mail volume, push-less poll latency (G6), what Google
does to an unverified production project that polls every minute.
Shared resource per account: one lane, one deadline per call (15 s for the OAuth, profile and Gmail calls, as for MXroute; the engine's
60 s round contains them), a 429 or `rateLimitExceeded` is shown and backed off, never
swallowed; a write is not retried blindly (read the remote state first, RFC 9110 §9.2.2). Paid upstream: none (own project, own quota).

### Budget lines still to be written into the adapter (performance review 2026-10-26, W1–W4)

- **Client-side limits — written (A2d, `gmail/budget.ts`).** Counted in quota units, not requests (Google charges units): 1,100 a minute per
  account (a usual round is 101; the uninstall of the most filters, 200, is 1,001), 5,000 per account per 24 h, 100,000 per 24 h for all
  accounts. One `GmailBudgets` per app wraps the client (a decorator, so `verify` and `uninstall` pay too); a refusal happens before any
  request leaves and is a `QUOTA_EXCEEDED`, so the round is TRANSIENT and the engine backs off. Windows are hourly (minute: 1 s) buckets,
  bounded memory, over-counting by at most one bucket; the clock moves by forward steps only. **Known gap:** the counters live in memory, so
  a crash loop starts the 24 h lines from zero; Google's own 6,000 units a minute per user is the wall then. Persisting hourly buckets in the
  Store is the fix if a crash loop is ever seen. The new-mail watcher has lines of its own, apart from the filter lane's (2026-10-27,
  after the pre-push review): **poll** (`profile`, `history.list`) 3,600 a day per account and 200,000 for all accounts, **read**
  (`messages.get`) 6,000 a day per account (300 mails) and 150,000 for all accounts; the minute line stays shared. They were one
  4,500 line first, which held only 75 to 81 mails a day (the window can hold 25 hours of polling) and, once full, stopped the poll
  itself. All four are PROVISIONAL until a week of real volume is counted (the hourly heartbeat carries the `found` count).
  Token renewals are not in these counters (they run after the budget check): one per ~59 minutes when healthy, at most 2–4 an hour per
  account while a round fails TRANSIENT, one per 30 minutes after `AUTH_REQUIRED` (engine back-off), so under 200 an hour at 50 accounts.
- **Polling:** 1,440 `history.list` per account per day is 5× the IMAP idle rate. One poll in flight per account, polls spread with jitter
  (50 accounts must not tick together after a resume), and the HTTP agent keeps connections alive longer than Node's default 4 s so a poll
  is not a new TLS handshake each time (measure, do not assume).
- **Filter assignment must be stable.** "≈ 12 units per block" holds only when one added address changes one filter. Addresses are packed
  into filters append-only with a fixed capacity per filter (never by sorted position, which would shift every later address and rewrite
  every filter: worst case ≈ 10,000 requests per block at 50 accounts). One added address = one `create` + one `delete` of the filter it
  joined. A counting fake Gmail over a 24 h fake clock asserts this and the three limits above.
- **Log fields** for the poll and the sync (account tag, status, units, duration, a fixed reason word; no address, no token), and a
  distinct state for "no new mail" versus "token dead / polling stopped", so silence is not read as "all quiet".

## Security notes (owasp-security §5)

Attack path for the loopback listener: another local process connecting first or replaying the redirect → `state` is random
(≥ 128 bits), compared in constant time, single use; PKCE verifier never leaves memory; the listener binds `127.0.0.1` only.
Token endpoint and API calls use TLS with default verification, a deadline each, and responses go through Zod with size limits.
Schemas for **Google's** responses are bounded but not strict (unknown keys are stripped, known keys bounded): a strict schema would
reject every sign-in the day Google adds a field; strict stays for our own files and IPC. If `refresh_token_expires_in` is present, the
person is told when access ends. No SDK: a small `fetch` client like `mxroute/client.ts` (the `googleapis` package pulls in
`google-auth-library` and its tree, one more supply-chain surface for four endpoints).
A Google error body is never copied into a log, a toast or the renderer; the Gmail adapter and watcher use fixed messages (a test feeds a
400/401/403 body holding an address and a `ya29.`-shaped string and finds neither anywhere). `invalid_grant` after a password change is expected (read: refresh
token dies on a password change for Gmail scopes, after 6 months unused, and in "Testing" after 7 days) and is shown as sign-in again.

## Measured live (2026-10-26, Ali's own test mailbox, project `senderban-byo`, "Testing")

Sign-in through the real `signIn` against Google, in a real browser; probes with filters that match nothing (fake `.invalid`
addresses), each deleted at once, filter count checked before and after (1 and 1).

- **Sign-in works end to end:** `signed-in`, mailbox identified by `getProfile`, 38 s including the person's clicks; token call 323 ms,
  profile call 211 ms. `http://127.0.0.1:<port>` with no path is accepted as the redirect; `access_type=offline` + `prompt=consent` are
  accepted. Google's consent page shows both permissions **unticked by default** (granular consent), so the scope check matters.
  The "Google hasn't verified this app" warning comes first and is expected for a Testing app and its test user.
- **`client_secret` is required** (see Data). A refresh without it: `400`, which `tokenFailure` maps to `REJECTED`; step A1b should show
  "the client secret is missing or wrong" for it, not "sign in again". (Shipped in A1b as the reply `client-refused`: `REJECTED` and
  `AUTH_REQUIRED` from the token call. Google's own error word for a missing secret was not recorded; see I2 of the A1b review for the other causes that share the reply.)
- **G2:** `addLabelIds: ["SPAM"]` → `400 invalidArgument`; `["TRASH"]` → 200. So Gmail's lane is Trash only.
- **G1:** `criteria.query` of 353 up to **14,003** characters (400 quoted addresses) was accepted; **28,003** characters answered
  `500 backendError` (an undocumented limit lies between). The earlier ~1,400–1,500 figure (secondary source) is wrong for the API.
  Consequences: capacity per filter is a named constant far below the wall (PROVISIONAL **50 addresses**, about 1.8 k characters);
  a `5xx` or a timeout on `filters.create` leaves the outcome unknown, so it is **not** retried blindly: the list is read first (after every
  failed attempt, the last included), at most two retries, then the round fails (a rewrite already saved as an intent is found again by the
  next round). An intent is not dropped on any error: a refusal that came from the read after the create says nothing about the create, so the next successful
  list settles it either way (adopted if the filter is there, dropped with a follow-up if not). An oversized query would
  otherwise loop forever as "transient".
- **Scope:** `filters.list`, `create` and `delete` all worked with `gmail.settings.basic` + `gmail.metadata`; `getProfile` works with
  that set. The filters page does not name the scope; this is the measurement.
- **Token life:** in "Testing" Google returned `refresh_token_expires_in: 604799` (7 days): `signIn` passes it on as
  `refreshTokenExpiresInSeconds`. Access token `expires_in` 3599; refresh token 103 characters (limit 512).
  In "In production" the same call returned no such field (G4 below).
- **Filter ids and duplicates (2026-10-27, production project):** a filter this lane created got an id of 38 characters and the person's
  own filter has one of 74, both letters and digits only (two samples; the client accepts a wider shape). `create` answers `200` with
  exactly `id`, `criteria`, `action`. A **second identical create** (same criteria and action) answers `400` reason `failedPrecondition`,
  message "Filter already exists": Gmail never holds two identical filters. So a lost create answer cannot produce a duplicate; the retry
  sees `400 exists`, and the adapter must tell "ours from the lost attempt" (absent from the round's first list) from "the person's"
  (present in it): only the first is adopted, the second is never touched. Probe: one `.invalid` address, created twice, deleted (204),
  filter count 1 before and 1 after.
- **The adapter driven live (2026-10-27, A2c + A2d at senderban `c30fa65`, fresh sign-in, fake `*@a2-probe.invalid` addresses, Ali's
  own filter present throughout):** every filter Google returned, ours or not, has exactly the keys `id`, `criteria`, `action`; ours have
  `criteria` = `{query}` only and `action` = `{addLabelIds: ["TRASH"]}` only, so the ownership read-back (exact key set + exact
  query) holds on real Gmail. The read-back query was byte for byte the compiled one for a 10-address filter (263 characters), a
  50-address filter (1,303) and a 49-address rewrite (1,277). Rounds: 10 addresses 1 round / 310 ms; growing to 60 (one rewrite + one new
  filter) 1 round / 676 ms; one removal = `list` 96 ms + `create` 184 ms + `delete` 124 ms (1 round, 411 ms); unblock of all 59 = 1 round,
  417 ms. `verify` reported no drift after every settled round. Filter count 1 before, 1 after, same id. Calls: `list` 96–164 ms,
  `create` 172–257 ms, `delete` 124–134 ms; the whole drive was 14 calls = 46 quota units, no refusal from our budget. Not
  measured: a failure in the middle (the intent paths run on the fake only), a mailbox with hundreds of filters, a non-ASCII `from:` term.
- **Does a quoted `from:("x@d")` match only that address? (2026-10-27, three probe rounds, one real mail per case, marker filters that
  add a label, never Trash, each deleted right after; senders `smith@`, `john.smith@`, `xsmith@senderban.com` and one personal Gmail
  address, written `person@gmail.com` here):** the filter for `smith@senderban.com` (marker `STARRED`) marked the mail from `smith@`
  and not those from `john.smith@` or `xsmith@`. The filter for `john.smith@` (marker `IMPORTANT`) marked only the `john.smith@` mail;
  its negative half is usable, its positive half is not independent, because Gmail also sets `IMPORTANT` on its own. A filter for the
  exact Gmail address (`STARRED`) and one for `gmail.com` (`CATEGORY_FORUMS`) matched the Gmail mail. A dotted variant, a plus-tag
  variant and a shortened local part (the last letters of it, `rson@gmail.com` here) did not match, but those three used markers that were not checked against
  Gmail's own labelling, so they are weaker. One probe looked like a partial match (a longer local part that ends in the same letters, against the same sender) and
  is discarded: its marker was `IMPORTANT`. Read: in these cases the quoted form acted as the whole address, so a block did not spread
  to `john.smith@` or `xsmith@`. Not measured, and still open: the same prefix case on gmail.com with a marker Gmail does not set on
  its own, display-name matching (a sender named `"x@d" <other@d>`), upper and lower case, a non-ASCII term, and the Trash action
  itself (assumed to read the query as the marker action does). How Gmail tokenises is not readable (needs a scope we do not hold).
  Marker labels came only from `STARRED` and the `CATEGORY_*` set, because creating a label needs a scope we do not hold.
- **Behaviour added after the push-before reviews (2026-10-27):** the Gmail lane never mirrors the person's own mailbox (an own
  address already in a filter is removed like an Unblock, and the result toast says so); an Unblock of an address held by a foreign
  filter now answers `REMOTE_CHANGED` once, not "done" (a state written before `Refusal.id` existed keeps the old behaviour, none exists
  because the lane is unreleased); a filter list over 2 MiB is `REJECTED`, so the engine stops re-downloading it, and an uninstall on
  it answers `filters-left`; the journal row keeps 20 failures plus a count, and each request writes one log line (`gmail-http`), except a new-mail history poll
  that answered 200: an hourly `gmail-heartbeat` per account (state, polls, failed, found, slowest poll, seconds since the last good
  poll) stands for those, because one line a minute per account would roll the 1 MiB log in under three hours at 50 accounts. A
  failed poll and a watcher that stopped are visible (a line, and no heartbeat). `history.list` also asks for `fields` and
  `prettyPrint=false`, and a page that still passes the read cap is a reported gap (`too-large`), not an endless retry.
  Not fixed, known: an Unblock that shrinks `{a,b}` to `{a}` while a foreign filter holds `a` reports `foreign` every round and `b`
  stays trashed.
- **New-mail reading driven live (G6, 2026-10-27, W-b `mail-client` against Ali's own mailbox, project `senderban-byo` "In production",
  fresh sign-in, token revoked afterwards; real mail from one other address of Ali's, two mails received):** `profile` answers a decimal
  `historyId` string. `history.list` with no new mail answers `200 {"historyId":"…"}` with **no `history` key** (the schema treats it as
  optional). `startHistoryId` is **exclusive**: asked from a message's own `historyId`, that message is not listed; asked from the
  `historyId` the previous answer returned, nothing repeats. A **future** id and id `1` both answer `404 NOT_FOUND` with the same body
  (`reason notFound`), so a future cursor reads as a gap, not as an empty page. `messages.get` with
  `format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=id,labelIds,payload/headers` is **accepted** (200, 375 bytes) and
  carries exactly `id`, `labelIds`, `payload.headers`; without `fields` it is 512 bytes (adds `threadId`, `sizeEstimate`, `historyId`,
  `internalDate`) and, with these scopes, **no `snippet` either way**. A missing message id answers `404` (the client's `"gone"`). Labels
  seen on a new mail: `UNREAD`, `IMPORTANT`, `CATEGORY_PERSONAL`, `INBOX`. The mailbox `historyId` also moves without any new INBOX
  mail (three moves in 12 minutes while the mailbox was in use: reads and label changes), so the cursor advances on idle polls too.
  **Latency, one sample:** mail received 18:20:47 (`internalDate`, one-second resolution), listed by a 5-second poll 17.9 s later, so
  Google's own lag is about 13–18 s; at the 60 s cadence the watcher adds up to a further minute. A second sample was not obtained
  (the second mail never came). **Units:** 140 calls in 12 minutes (138 `history.list`, 1 `profile`, 1 `messages.get`), about 297 units
  at 5-second polling; at 60 s it is 2 units per idle minute. **Not measured:** what a 404 costs in quota, a sustained hours-long run at
  the 60 s cadence on the unverified project, sleep/resume, a mail that is not in INBOX, a `Reply-To`/multi-`From` mail, a gap older than a week.
- **The watcher driven live in the desktop app (W-d at senderban `d3d62bb`, 2026-10-27, a copy of an earlier profile, Ali's mailbox, one
  mail from another address of Ali's):** a version-3 database opened and was migrated to 4 with its rows intact. The first start with a
  token Google no longer honoured ended as `refresh 400` -> `AUTH_REQUIRED` -> `halted-auth` in 0.3 s, with the notice, and nothing
  polled afterwards. After "Sign in again" and a restart: token refresh 259 ms, `profile` 180 ms, first run 459 ms (it took the cursor),
  then one `history.list` a minute (166-200 ms each). The mail was announced at the next poll: `history.list` 197 ms + `messages.get`
  110 ms, whole poll 432 ms, the log line holding the sender's domain only. A click on "This sender" with Trash chosen (the only choice
  offered) reached the app as `toast-activation`, then `filter list` 204 ms, `filter create` 193 ms, `applied`, read back `verified`, action `trash`
  (0.75 s from the click to the result). Unblock then deleted the filter (`filter delete` 204) and read it back. Removing the account
  stopped the watcher, revoked the token (200) and left no cursor row (0 rows). Poll time with these numbers is about 0.45 s, so 50
  accounts at one poll a minute keep about 0.4 of a gate slot busy on average (one account measured; many at once not). Not
  measured: the Pause and Resume tray items, a removal while a poll is in the air, sleep/resume, more than one account.

## Not decided / open

- G4: **closed (2026-10-27).** Publish needed a homepage and a privacy policy URL on the Branding page (`https://senderban.com/` and
  `https://senderban.com/privacy/`, authorized domain `senderban.com`); the project is now "In production", not submitted for
  verification. A fresh sign-in through the real `signIn` returned `signed-in` with **no `refresh_token_expires_in`** (Testing: 604799),
  so the 7-day limit is gone. Consent still shows "Google hasn't verified this app" (expected; 100-user lifetime cap applies, and the
  consent page shows no privacy link until the branding is verified). Verification itself is not started.
- G3, G5, G6 (new-mail-only filter, the label read for the old "magic folder" idea, notification latency and unit use). The BLOCK-1
  probe (how `-term` inside `from:( … )` is read) needs a read scope we do not request; the contract (quoted terms + local-part
  allowlist) is kept regardless.
- Whether one verified Senderban client can ever replace BYO (needs restricted-scope verification and a security assessment, read:
  scopes page; out of v0.1).

## Steps

1. Account-kind refactor (union schema, narrowing) — no behaviour change. **Done (A0).**
2. OAuth module in core (PKCE, state, refresh, scope check, identity check, revoke) with a fake token endpoint in tests; decides where
   `googleClient` is stored.
3. Gmail filter adapter against a fake Gmail; then G1/G2/G3 live. **Gate before this step:** the query encoding contract above, with a
   property test over the `LOCAL_ATOM` alphabet (the compiled query tokenises as exactly `from:(` + N quoted terms joined by `OR` + `)`,
   no unquoted `- + { } *`; fixtures `-x@spam.example`, `+x@…`, `{a}@…`, `a*b@…`, `*@gmail.com`, `x|y@…`, `a}or{b@x.com`), and a
   fake-Gmail test where a filter holding the text "senderban", a UI-edited copy of ours and a marked filter with another action all stay
   untouched through plan, apply, recover and uninstall. The one live probe that closes BLOCK-1 uses a throwaway label, never Trash.
4. Watcher + toast wiring (fixture table for the `From` header cases above); then G6 live.

### A1b (desktop connection) — done 2026-10-26

One manage-window section, five IPC channels (`manage:google-state`, `-save-client`, `-sign-in`, `-cancel`, `-remove`), each with the trusted-frame check and a
`strictObject` schema; replies are fixed words. `shell.openExternal` is only reached through `openGoogleAuthUrl` (https, `accounts.google.com`, the fixed path,
no port or credentials; it opens the parsed form of the URL, never the raw string). One Google step at a time (`exclusive`); one `serialized` queue for every writer
of `accounts.json` (MXroute key saves and Gmail sign-ins share it). Removal order is as in point 3; the first step (uninstall our filters) is a comment until the filter
adapter exists and must be added there.

A refused sign-in tells the person the access Google already gave can be removed under Google Account permissions, **except `duplicate`**: the token of a mailbox that is
already set up belongs to the same grant as the working account, so removing it there would break that account. `full` carries the note.

Security review follow-ups (2026-10-26): the never-refuse address set (ADR 0008 point 3) follows `accounts.json` while the app runs (`createOwnMail`, refreshed by
`onAccountsChanged` after a sign-in, a sign-out or a removal; a failed read keeps the old set), so a Gmail address connected after start-up is protected at once. A removal
shrinks it at once too. Removing an account that held no token answers `removed-not-revoked` and says nothing was revoked. Only a client file that is there but invalid
(`ClientFileInvalid`) counts as unreadable; an I/O error (a scanner holding the file) fails the step and drops nothing. Not done: security FLAG-4 (the loopback's 20-request
cap is spent by unauthenticated requests).

Open (not done in A1b): an account whose stored token cannot be decrypted (profile restored on another machine, Windows password reset) cannot be removed from the page
(the revoke never succeeds); it needs a "remove here anyway, I removed the access in my Google account" confirmation. Also unmeasured: whether Google ignores a wrong
`client_secret` on `revoke` (the request sends it today; Google's page shows the token only), which would take the secret out of the removal path.
