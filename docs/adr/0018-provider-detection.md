# 0018 — Finding who runs a mailbox from its address

Status: **accepted** (2026-11-01). Builds on ADR 0012 (any ManageSieve server) and ADR 0014 (cleaning). Measured on public DNS and on
public ManageSieve and IMAP ports without signing in. No account was added at any provider through it.

## Context

A person knows their address, not whether their domain runs on Migadu or which server name to type. The add form made them pick a
provider first, and a custom domain says nothing about who hosts it. Only the mail domain's DNS does.

## Decision

1. **A button, not a keystroke.** "Find my provider" runs on one click, at most one at a time, and ends with the window or after 10
   seconds. Mail never starts it.
2. **Known domains cost nothing.** `gmail.com`, `icloud.com` and the like answer from a table, with no query, so no DNS answer can change
   them.
3. **An MX record picks, it does not write.** The hosts of the lowest preference are matched by whole labels against a fixed table of
   zones. A match gives a provider whose servers come from Senderban's own table, so a forged record reaches a known provider at worst.
   MXroute is the one exception: its mailbox server is the MX host, so the name stays, but only inside `mxrouting.net`. Hosts of one
   preference that disagree are nobody's.
4. **An unknown mail host is asked.** In the order of RFC 5804 §1.8, with the primary MX in between because most servers run both: the
   `_sieve._tcp` target, the primary MX, the domain. At most three, side by side, 5 seconds each. A probe is `probeManageSieve`, so
   nothing of the person's is sent and the answer comes from behind verified TLS. Next comes the `_imaps._tcp` target of RFC 6186, on 993
   only, as a cleaning account. Then "unknown".
5. **A name from DNS is held to the rule of a typed one, and more.** `isPublicHostName` is the same check the form uses. SRV ports are
   limited to 4190, 2000 and 993. The probe's socket takes its address from `publicAddressLookup`, which drops private, loopback and
   link-local answers inside the socket's one lookup. A name cannot answer one thing to a check and another to the connection.
6. **A suggestion fills the form and nothing else.** The password, Add and the main process's dialog naming the server stay as they
   were. A name that came from DNS is said to be one, in a warning. Anything typed for the address before, a password above all, is
   cleared.
7. **The system's resolver only.** No DNS over HTTPS and no list of ours: the domain goes where the person's other lookups go.

## Departures from the standards

- **RFC 6186 §6** says a client SHOULD confirm with the user a target outside the queried domain before any connection. The probe does
  not ask: it follows the person's click and carries nothing of theirs, and the dialog in front of the password is that confirmation.
  What the connection gives away is the person's IP address to the mail host of their own domain.
- ADR 0012 did not use `_sieve._tcp` because unsigned DNS should not choose where a password goes. That stands: here it fills the form,
  as that ADR allowed, and the person confirms the name.

RFC 7817 §3 is followed: of the two reference identifiers it allows, Senderban uses the host name it connected to, which is the one the
person sees in the dialog. A host with a certificate only for the mail domain fails the probe, and the domain itself is then tried.

## Scale budget

Unit: a click, not an account. One click costs 3 DNS queries side by side and at most 3 TCP and TLS connections, none for a known
domain. There is no timer, no table and no work at idle, so nothing grows with the account count: 50 accounts are 50 clicks in the life
of the install, the same at 10x and 100x. No shared or paid upstream is touched. The `account-detect` log line carries the result kind,
the time, the record and probe counts and the MX error code, never the domain or a server.

## Measured

On 2026-11-01, in Electron 45.1:

| Case                                                      | Result                             | Time        |
| --------------------------------------------------------- | ---------------------------------- | ----------- |
| Known domain                                              | from the table                     | 12 ms       |
| MX in the table (Migadu, mailbox.org, Purelymail, others) | provider                           | 31-219 ms   |
| MXroute                                                   | provider, primary MX as the server | 104 ms      |
| Google Workspace and Microsoft 365 custom domains         | Gmail, Microsoft                   | 36, 91 ms   |
| `yahoo.co.uk`, `verizon.net`                              | Yahoo, AOL                         | 138, 166 ms |
| Domain with a public ManageSieve, not in the table        | `other`, the domain itself         | 534 ms      |
| `_imaps._tcp` only, port 4190 filtered                    | `clean` with a name from DNS       | about 5.2 s |
| Null MX (`example.com`), domain that does not exist       | no mail                            | 39, 86 ms   |
| Nothing found, port 4190 filtered                         | unknown                            | about 5.3 s |

- Five real ManageSieve servers answered a probe in 294 to 1,229 ms, so 5 seconds leaves a margin of 4.
- `imap.mail.me.com`, `imap.mail.yahoo.com`, `imap.aol.com`, `imap.gmx.net`, `imap.gmx.com` and `imap.web.de` greeted on 993 under a
  certificate that verified. Each is also on the provider's own help page.
- The page was driven through every result in real Electron with a fake main process, in both themes. No test covers the page's
  script in `npm test`.

## Accepted risks

- **A gateway hides the host.** A domain behind Proofpoint or Mimecast shows the gateway in its MX record, so it reads as unknown even
  on Microsoft 365. The person picks the provider by hand, as before.
- **DNS can be forged on an open network.** It can then suggest a server of the attacker's, with a certificate of its own for that
  name. The warning and the dialog name it, and the person must still press Sign in. The answer is limited to a suggestion, not removed.
- **`verizon.net` reads as AOL**, which runs its mail. AOL's help pages give it the same IMAP server.

## Not measured

- Adding an account from a suggestion at any provider.
- Node 24.14 here reports `127.0.0.1` as its DNS server and every `resolveMx` is refused (nodejs/node #62347), while Electron 45.1's
  c-ares finds the real server. A person's machine where Electron does the same gets "Could not read this domain's mail records", the
  form still works.
- The DNS server of an IPv6-only network.
