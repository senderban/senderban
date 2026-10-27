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
   - **Ownership** is the filter **id recorded in the local journal** (written before the create, completed after) **plus** exact equality
     of criteria and action on read-back. The earlier idea of a marker in the criteria is dropped as the ownership test: `query` and
     `negatedQuery` are free text, so a marker changes what the filter matches, and a marker that is a constant in this public repo would let
     any sender put it in a mail and walk past every filter. A marker may exist only for crash recovery, as a **per-install random value of
     ≥ 128 bits**, and only if G1 shows its placement does not change matching. A filter with our marker but an unknown id or changed content
     is reported `REMOTE_CHANGED` and never deleted automatically (the Sieve lane behaves the same way). Gmail has no update, so a filter
     the person edited in Gmail is a new filter that must stay untouched.
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

- **Client-side limits** (global CLAUDE.md item 7): a per-minute request cap, a per-account 24 h unit quota and a global daily ceiling, as
  named constants with a test, so one account's loop cannot eat the project's quota or trip Google's per-user limit.
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
  a `5xx` on `filters.create` is **not** retried blindly: the adapter retries at most twice, then reports the entry as failed and
  visible, because an oversized query would otherwise loop forever as "transient".
- **Scope:** `filters.list`, `create` and `delete` all worked with `gmail.settings.basic` + `gmail.metadata`; `getProfile` works with
  that set. The filters page does not name the scope; this is the measurement.
- **Token life:** in "Testing" Google returned `refresh_token_expires_in: 604799` (7 days): `signIn` passes it on as
  `refreshTokenExpiresInSeconds`. Access token `expires_in` 3599; refresh token 103 characters (limit 512).
  In "In production" the same call returned no such field (G4 below).

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
