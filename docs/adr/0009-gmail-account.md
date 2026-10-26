# 0009 — Gmail account (own OAuth client): sign-in, storage, filters, new-mail watcher

Status: **proposed** (2026-10-26). Nothing here is measured on a real Gmail account yet. Facts below marked "read" come from Google's
pages read on that date; "from memory" and "not measured" are marked where they appear. Builds on 006 K6/K7/K8/K10 and ADR 0006/0008.

## Decision

Gmail joins as a second account kind, v0.1 **bring your own OAuth client only** (006 K6): the person makes a Google Cloud project with a
Desktop-app client and gives Senderban its client ID. No client ID or secret is in the repository.

1. **Sign-in.** Authorization code + **PKCE (S256)** + loopback redirect `http://127.0.0.1:<random port>` — read: Google requires PKCE for
   native apps, a Desktop client is a public client, `client_secret` is optional in the token request, `redirect_uri` must match the
   registered one exactly (<https://developers.google.com/identity/protocols/oauth2/native-app>). The browser is opened with
   `shell.openExternal` on a URL Senderban builds itself (fixed host `accounts.google.com`, never a value from the renderer).
   The listener serves one request, checks `state`, closes at once and after a time limit (5 min, PROVISIONAL, unit seconds).
2. **Scopes.** `gmail.settings.basic` (filters) and `gmail.metadata` (From/Subject for the toast), nothing wider. All four Gmail scopes
   are **Restricted** (read: scopes page). `history.list` accepts `gmail.metadata` among others (read: history.list page).
   Which scope `filters.create` needs is **not stated on the filters page** (read) — measured in G1, not assumed.
3. **Tokens.** Refresh token only, as `safeStorage` ciphertext (DPAPI) like the IMAP password; the access token stays in memory and is
   never written to disk or log. A refresh answering `invalid_grant` is shown as "sign in again", never retried in a loop.
4. **Filters** (`BlockAdapter`): Gmail has `create`, `delete`, `get`, `list` and **no update** (read), so a change is create-then-delete,
   as K8 already says. Only filters Senderban made are touched; they are recognised by a marker in the criteria we write (design in the
   adapter step; G1 decides how a marker survives, since `criteria` has no free-text field). Default action: add label `TRASH`
   (reversible, K7); `SPAM` only if G2 shows it is accepted. No `reject` and no domain-wide server refusal on Gmail (ADR 0008 stays MXroute-only).
5. **Watcher.** `users.history.list` with `startHistoryId`, `historyTypes=messageAdded`, then `messages.get` with `format=metadata`
   for the new ids only. A `404` means the id is too old (read: valid "typically at least a week, rarely a few hours"): drop the cursor,
   take a new `historyId` from `getProfile`, announce nothing for the gap, and log it. The cursor lives in the store like `imap_cursor`.
6. **Toast.** The choices a Gmail account can honour decide the buttons: Trash always; Junk only if G2 is positive; "Block at server"
   never. When one block spans accounts of different kinds, the person's choice is applied where it exists and the result toast says
   where it was not (same wording rule as ADR 0008 point 3).

## Data

`accounts.json` keeps `version: 1`. `AccountConfigSchema` becomes a union of two strict objects, so an existing file (IMAP/Sieve,
MXroute) loads unchanged and needs no migration:

- IMAP/Sieve account — today's shape.
- Gmail account — `{ id, gmail: { clientId, refreshCipher, email } }`, `strictObject`, no `imap`/`sieve`.

App-wide, once, not per account: `googleClient: { clientId, secretCipher? }` (one Desktop client serves several Gmail accounts).
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
Shared resource per account: one lane, one timeout per call (60 s), a 429 or `rateLimitExceeded` is shown and backed off, never
swallowed; a write is not retried blindly (read the remote state first, RFC 9110 §9.2.2). Paid upstream: none (own project, own quota).

## Security notes (owasp-security §5)

Attack path for the loopback listener: another local process connecting first or replaying the redirect → `state` is random
(≥ 128 bits), compared in constant time, single use; PKCE verifier never leaves memory; the listener binds `127.0.0.1` only.
Token endpoint and API calls use TLS with default verification, a deadline each, and responses go through Zod with size limits.
A Google error body is never copied into a log or the renderer. `invalid_grant` after a password change is expected (read: refresh
token dies on a password change for Gmail scopes, after 6 months unused, and in "Testing" after 7 days) and is shown as sign-in again.

## Not decided / open

- G4: token life of an unverified project set to "In production" — not documented on the expiry page (read), measure on day 8.
- G1–G3, G5, G6 (query length, `SPAM`, new-mail-only filter, filters scope, notification latency and unit use).
- Whether one verified Senderban client can ever replace BYO (needs restricted-scope verification and a security assessment, read:
  scopes page; out of v0.1).

## Steps

1. Account-kind refactor (union schema, narrowing) — no behaviour change.
2. OAuth module in core (PKCE, state, refresh) with a fake token endpoint in tests.
3. Gmail filter adapter against a fake Gmail; then G1/G2/G3 live.
4. Watcher + toast wiring; then G6 live.
