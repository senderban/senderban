# 0013 — Outlook and Microsoft 365 through Graph message rules

Status: **accepted, partly measured** (2026-10-31, new mail 2026-11-01, measured on one personal Outlook.com mailbox 2026-11-01). Shapes not listed under
"Measured" come from the v1.0 reference, read on those days. M1 below decides the provisional numbers. Builds on ADR 0009 (the Gmail lane), which this one
follows where the two providers agree.

## Context

Outlook.com, Hotmail, Live, MSN and Microsoft 365 have no Sieve and no public blocked-senders write in Graph v1.0. Exchange Web Services is being
switched off from October 2026 and fully by April 2027
([Microsoft](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online)), so
[`messageRule`](https://learn.microsoft.com/en-us/graph/api/resources/messagerule) is the one way that stays.

## Decision

1. **A rule per kind and action.** Addresses (`fromAddresses`) and domains (`senderContains`) never share a rule: the conditions of one rule are
   tested together, so one rule holding both would match neither sender. Each rule has one action: Junk is `moveToFolder` with the Junk folder's
   id, Trash is `delete` (Deleted Items), `reject` is Junk because only MXroute refuses at the door. `permanentDelete` is never written (K7).
   Every rule ends with `stopProcessingRules` and takes `sequence: 1`: a block outranks the person's other rules, and the server renumbers them.
2. **Permissions.** `MailboxSettings.ReadWrite` for rules, `Mail.ReadBasic` because that is the least that reads the Junk folder's id
   ([mailfolder-get](https://learn.microsoft.com/en-us/graph/api/mailfolder-get)), `User.Read` for who signed in
   ([user-get](https://learn.microsoft.com/en-us/graph/api/user-get)), `offline_access` for a refresh token. No permission that reads a message
   body. A wider grant is not refused, unlike Google's: Microsoft answers with everything the app was ever granted, and a refusal would be a dead
   end the person cannot fix. The log says so, as a count.
3. **Sign-in.** Authorization code with PKCE (S256) on `/common`, as a public client: no secret, the client ID ships in the app, as other open
   mail clients do. The redirect is `http://localhost:<port>`: Microsoft
   [recommends it](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) for an app using the system browser, ignores
   the port when matching, and its portal takes no `http` address. The same [reply-url](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url) page
   also says to prefer `127.0.0.1`, reachable by editing the manifest, and RFC 8252 §8.3 calls `localhost` not recommended; but it says port matching is ignored for
   localhost only, so a literal address may need a fixed port. M2 tests it, and this point follows the result. The listener binds 127.0.0.1 only: a local process on
   `[::1]` could end the sign-in but holds no PKCE verifier. One sign-in at a
   time across all providers.
4. **The app ships Senderban's registration** (2026-11-01): a public client, so the Application (client) ID is a GUID in the source and there is no secret.
   It takes personal accounts and any organization, with the localhost and native client redirects. A build with the ID empty keeps the button off and
   the page says why.
5. **Refresh tokens replace themselves** ([refresh-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)): the new one is
   encrypted and stored, and a failed save keeps the old one, which Microsoft does not revoke on use. They last 90 days. A mailbox with no block
   for 90 days answers `invalid_grant`, and the person signs in again.
   A re-sign-in is held to the user id from `/me`, not the address: Microsoft says not to identify anyone by one.
6. **There is no revoke.** Microsoft gives a public client no call that ends one grant. Removing an account deletes its rules, then the stored token, and
   tells the person where to take the access away.
7. **Writes.** A rule is changed in place by `PATCH`, unlike Gmail's create-then-delete. A `POST` is never repeated (RFC 9110 §9.2.2). Each write is
   recorded as an intent first; a rule's name carries a nonce (`Senderban 0123456789abcdef`), so the next round finds a create whose answer was
   lost, and a patched rule is recognised by what it holds. After a 5xx or a timeout the outcome stays unknown, whatever the next attempt says.
8. **Ownership, and a rule the person changed.** A rule is ours by its id in the lane's state plus an exact read-back: our name, switched on, not in error, one condition of our
   kind, the entries, no exception, our actions, not read-only. Compared as sets without case (the reference's sample returns `adele` as `ADELE`), without
   `sequence`, and without the folder id's value: its form on the way back is not measured. The answer to each write is read the same way, so a mailbox that stores
   rules otherwise stops the round at the first rule. A rule that no longer reads as written is **kept as edited, never written to or deleted**: unless switched off it still acts on
   mail, and the person changed it for a reason (an exception for a false positive). Its entries count as covered, so no second rule undoes the edit. An Unblock of
   one of them is reported, once, as still held by that rule, instead of reading as done. The Accounts page counts such rules, because a rule switched off blocks nothing, and account removal leaves them and says so. A rule that reads as written again
   is taken back; one deleted in Outlook is forgotten, and what is still wanted is written anew.
9. **Size.** No limit on `fromAddresses` is documented, and Exchange Online holds 256 KiB of rules
   ([Set-Mailbox](https://learn.microsoft.com/en-us/powershell/module/exchange/set-mailbox)). A rule starts at 100 strings; on a 400, 413 or 422 the
   lane halves that and keeps the number in its state, down to 10. A refusal at 10 is reported. A 507, or an error code that says quota, cannot be
   solved by halving and is reported as no room on the mailbox. A refused rule that the smaller size would not change is refused for another reason and is
   reported; a new Junk rule refused that way reads the folder id again. The number does not grow back: it waits for M1.
10. **A domain whose text match would reach the person's mail is not written.** `@contoso.co` matches `@contoso.com`, `@gmail.co` every Gmail sender and `.gov.u` every
    `*.gov.uk`, while the guards at the list compare labels and see none of them. The lane refuses a domain whose last label is no delegated top-level domain (a forged name, and likely a cut of a
    real one; country codes are not all two letters, `.срб` is `xn--90a3ac`) and one that, or a parent of which, is a label-boundary prefix of a domain the person owns, of a listed mail provider or of a provider that sends account
    alerts (a look-alike blocked after a phishing mail would silence the real alerts). It also refuses a name right under `.co`, `.ne`, `.in` or `.bi`
    (`@paypal.co` is also `@paypal.com`, red team KC-3), and such a suffix on its own; a name under a longer suffix there (`@spam.co.in`) is written. The list says **Outlook: not applied** and the result toast says why; one already in a rule is taken out.

## Known limits

- **A domain is a text match.** `senderContains: "@bank.com"` also catches `@bank.com.tr`: Graph has no exact-domain condition. The adapter declares
  `exactDomain: false`, the list and the result toast say so, and the mail stays reversible in Junk or Deleted Items. Point 10 guards the person's own mail, listed providers, the
  account-alert providers, whole countries and the same name under .com, .net, .info and .biz, not every other domain that starts the same way (`.com` reaches `.com.tr`, `.ba` reaches `.bank`; accepted 2026-11-01 after the security review: refusing every top-level domain that starts another refuses most domain blocks, the toast names the limit and the mail stays in Junk or Deleted Items), and not a local part: the text of a domain also matches a dotted local part at any domain. Whether it also reads the display name is not documented.
- **A rule only acts on mail arriving in the Inbox.** Mail already there stays, and retroactive cleaning is not offered.
- **A work or school account may need approval.** Microsoft's default consent policy excludes `MailboxSettings.ReadWrite` and `Mail.ReadBasic` for all but listed mail clients.
  Sign-in then reports that the organization must approve Senderban, and the Accounts page gives a link for the administrator
  ([admin consent](https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent), on `organizations`, because `common` is not allowed there). Microsoft's
  "needs approval" page may lead back as a plain cancel or not at all, so a cancel and a timeout show the same link. Its redirect is Microsoft's native client page, not the
  loopback: the administrator is usually on another computer. The approval's answer is not read; a new sign-in proves it.
- **A create that lands after the round gave up on it**, or that the list cannot show for two rounds, leaves a rule nothing knows, named `Senderban …`. The person can delete it in Outlook. Deleting by
  name alone was refused: a second device's lane holds rules of the same form.

## New mail

11. **A delta query on the Inbox, polled.** A desktop app has no address for a webhook, and Microsoft describes
    [delta](https://learn.microsoft.com/en-us/graph/delta-query-overview) as the pull model that avoids re-reading.
    [`message: delta`](https://learn.microsoft.com/en-us/graph/api/message-delta) takes `Mail.ReadBasic`, on work and personal accounts alike, so no new consent. One
    request a minute, ±10 s, and it carries `from`, `subject` and `receivedDateTime`: unlike Gmail, a new mail costs no second request. Nothing else is selected.
12. **Starting from now.** `$deltatoken=latest` is for Entra and OneDrive, and a first round without a filter reads the whole folder. The first request carries
    `changeType=created` and `$filter=receivedDateTime ge <now>`; the token keeps them. The link is opaque and stored whole, and it is held to Graph's host and version when
    read from disk as well, because the token follows it.
13. **What the documents warn about, and the answer to each.** A filtered delta returns at most 5,000 messages, not said whether per read or per link, and a token's life on
    Outlook is not fixed, so a round lasts seven days and the next starts from the newest mail seen; that mail comes back (`ge`) and is not told again, also after a lost link, unless this device's clock was behind its time. Read-state changes and `@removed` entries come through even when asked
    for new mail only, and the same change can come twice, so an entry without `receivedDateTime` or with `@removed` is skipped, mail more than an hour older than the newest
    seen is not new, and ids are remembered (500). A `410`, a `404` on a stored link or an error code naming the sync state starts a new round from the newest mail seen, so a
    lost token loses no mail. A page over the read cap starts from now and says so.
14. **The sender is `from`**, through the same `parseAddress` as every other sender. The display name is not read. An address that does not parse (an internal
    `/O=...` name) is announced with no Block button. A domain the rule could not take (point 10) is not offered on the toast.
15. **The same lifecycle and the same rules as Gmail.** The timers live in `PollLoop` and what an announcement means in `createMailWatchers`, both now used by the two
    providers, so own-address, "Don't ask again", backoff and halts cannot drift apart.

## Budget lines

One lane holds one request open, against Outlook's four per app and mailbox and 10,000 in ten minutes
([limits](https://learn.microsoft.com/en-us/graph/throttling-limits)). A block costs one list and one write. Client-side: 300 requests a minute and 5,000 a day
per account, 100,000 a day for all accounts. After a 429 or a 503 the lane sends nothing until `Retry-After` has passed, capped at an hour.

New mail: one request a poll, 1,440 a day per account, 72,000 at 50 accounts, which is 10 in ten minutes against Outlook's 10,000 per mailbox. Its own lines: 3,000 a day per
account and 200,000 for all, so a poll cannot eat a block's budget; the minute line and the wait after a `Retry-After` are shared, because Outlook's limit is per app and mailbox.
Five polls at once on a gate of their own. A running watcher renews the access token about hourly, so each account writes accounts.json about once an hour, and a mailbox no
longer loses its sign-in after 90 days without a block. A poll that answered 200 writes no line (118 bytes a minute per account would roll the 1 MiB log in about three hours at 50 accounts); a failed poll and every other request do, and one heartbeat an hour counts the polls.

One registration for every install: Microsoft also counts 130,000 requests per 10 seconds per app across all tenants
([limits](https://learn.microsoft.com/en-us/graph/throttling-limits)). One account polls 0.17 times per 10 seconds, so about 780,000 accounts polling at once reach it. Re-read this line at
100,000 accounts; the lever is a longer poll in a new build. Every client already goes quiet for `Retry-After`.

A block costs one list and one write, an Unblock two lists and one write (the read-back). Graph lanes have a gate of their own: their outage must not hold Gmail and
MXroute lanes. A list is worked out once for all lanes (keyed by the list object and the own-mail test), and a state write that changes nothing writes nothing.

Measured 2026-10-31 on the built core, one laptop, a real store on disk, no network, 4,998 entries, 492 KB of state per lane:

| Lanes | Start, nothing to send | Unchanged list | One block                  |
| ----- | ---------------------- | -------------- | -------------------------- |
| 3     | 170 ms                 | 29 ms          | 374 ms                     |
| 50    | 1.2 s, in one piece    | 0.4 s          | 4.1 s, longest stall 0.2 s |

A round that writes saves one state per write, plus one at its end. A rule refused for good, or a mailbox with no room, stops the lane until the list changes.

## Measured

2026-11-01, one personal Outlook.com mailbox, the app registration with public client flows off, two runs of the built app:

- **M2:** the consent page opened and the token came back (`token` 200, 719 and 759 ms; `profile` 200). The second run's sign-in skipped the consent page
  (6.6 s in all). After a restart the lane signs in with `refresh` 200 and asks nothing.
- **M3, rules:** a block from the notification writes a rule (`POST` 201, about 0.2 s) and reads it back; click to verified block about 0.6 s. Trash and Junk
  are two rules. A second address with the same action is added to the same rule (`PATCH` 200), the Unblock of one entry is a `PATCH` 200, of the last entry
  a `DELETE` 204. A domain block (`senderContains: "@domain"`) is a `POST` 201. Mail from a blocked address went to Deleted Items, mail from another address
  of a blocked domain did not reach the Inbox, and neither was announced. Remove deletes the rules (`DELETE` 204).
- **M4:** the filtered first round answers empty (`outcome=first`, `found=0`), a new mail is announced on the next round with `Mail.ReadBasic` (no 403),
  marking an old mail read announces nothing.

## Still to measure

- **M1:** how many `fromAddresses` one rule takes, and the rule quota on Outlook.com.
- **M2:** whether `localhost` reaches the listener from the common browsers.
- **M3:** that the rule acts while the phone app is open and how fast; whether `senderContains` also matches the display name; the error code of a full
  mailbox; the shape of a next link.
- **M4:** the delta link's length and form, and Pause and Resume.
- **M5:** a work account: what the "needs approval" page does, and that the administrator's link works.
