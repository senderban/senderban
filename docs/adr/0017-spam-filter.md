# 0017 — A spam filter per mailbox

Status: accepted (2026-10-31). Delivered through LMTP to Dovecot 2.4.5 in the contract tests; not yet measured on a real provider's delivery.

## Decision

A mailbox on a mail server can move mail at or over a spam score, to Junk or Trash, or ask in the notification. The choice lives on the
mailbox's row in **Accounts** and in `accounts.json` (`packages/core/src/spam-filter.ts`, `spamFilter` on the account). A mailbox with no
filter keeps the script it had, byte for byte.

- **The server moves the mail.** It is one more rule in the Sieve script Senderban already keeps: it runs with Senderban closed and for
  every mail client, costs one script write per change, nothing per mail, and no timer.
- **Three limits, not a number.** Low 15, Medium 10, High 5, in SpamAssassin points. Its docs call the default 5 "quite aggressive", give an
  ISP "8.0 or 10.0", and keep deleting mail for "15.0 or higher"
  ([Conf](https://spamassassin.apache.org/full/4.0.x/doc/Mail_SpamAssassin_Conf.html)). Nothing under 5 is offered. Whole numbers are
  all the list below needs.
- **It moves one mail and blocks no sender.** There is no automatic block. A From can be forged, so spam sent in a customer's name would
  otherwise put the customer on the block list; a move costs only the mail that scored. **Ask in the notification** is how a sender gets
  blocked: no rule is written, the mail stays, and its toast says "Over your spam limit" and starts on **Block at server** where the mailbox
  offers it (this is the second way a person opts in to that start, ADR 0008). A person clicks.
- **The rule goes last**, so a blocked sender keeps the action of its entry.
- **Gmail and Other (IMAP) have no filter.** Gmail gives no score and "Other (IMAP)" has no server rule.

## The rule

One `header :matches` test on a list of the scores from the limit up, digits with at most one `*` at the end: `5`, `5.*`, `5 *`, then `10*` to
`99*`, because two digits in a row cannot be a score under 10. One test, so one line of the header has to hold all of it, and base Sieve,
so no server needs an extension for it. The list is 90 to 135 strings.

Two earlier drafts failed on a real server, Pigeonhole 2.4.5, which is why it reads this way:

- `:value "ge"` with `i;ascii-numeric`. That comparator reads a value with no leading digit as positive infinity
  ([RFC 4790 9.1.1](https://www.rfc-editor.org/rfc/rfc4790.txt)), so a clean mail's `-1.2` is over every limit. A second test that asks for a
  digit can be met by another line of the same header: `-1.2` beside `0.0` moved clean mail.
- `?` for "any digit". Pigeonhole matched `1? *` on `1.6 (+)` and `?.6 *` on `4.9 (++++)`, so a `?` before a `*` does not hold one character
  there, and every score from 1 to 4.9 moved.

Every score from -20.0 to 199.9 is tested against all three lists, and Dovecot takes the cases that matter over LMTP
(`dovecot.contract.ts`).

A sender's own `X-Spam-Score: 99` moves its own mail, which it can do by being spam, and a higher score that an earlier server left on
forwarded mail moves that mail. A server that adds no score of its own lets a sender write one under the limit, so such a mailbox is simply
unfiltered: the page says the filter needs a server that adds a score.

## Limits

- Not measured: that a real provider's `X-Spam-Score` is on the mail when Sieve runs. Senderban has read the header on delivered MXroute
  mail (2026-10-25), and a rule that finds no header does nothing. Migadu, mailbox.org and Purelymail scores are not measured at all, and a
  server with its own scale may not mean what these three words say.
- Moved mail shows no notification: the watcher reads the inbox. The page says so.
- The watcher's `parseSpamScore` drops a score when a mail has two score lines, and the rule does not. A toast can show no score for a mail
  a rule would move.
- The rule ends with `stop`, as block rules do, so a person's own Sieve rules after our include do not run for that mail.
- `ask` starts a toast on an action that keeps no copy, on the mail most likely to carry a forged From. The filter is set per mailbox and the
  person still clicks. Security review (2026-10-31) asked to drop the start and keep only the note; the owner chose it, ADR 0008 records it.
- A mailbox with a filter writes the `spamFilter` key: an older version will not read that `accounts.json`.
