# 0018 — Finding who runs a mailbox from its address

Status: **accepted** (2026-11-01). Builds on ADR 0012 (any ManageSieve server) and ADR 0014 (cleaning). Measured on public DNS and on
public ManageSieve and IMAP ports without signing in. No account was added at any provider through it.

## Context

A person knows their address, not whether their domain runs on Migadu or which server name to type. The add form made them pick a
provider first, and a custom domain says nothing about who hosts it. Only the mail domain's DNS does, and DNS is unsigned: on a hostile
network anyone can answer it. A person who presses this button has no way to tell a right name from a forged one, so a design that asks
them to compare names protects nobody.

## Decision

1. **A button, not a keystroke.** "Find my provider" runs on one click, at most one at a time and six a minute, and ends with the window
   or after 10 seconds. Mail never starts it.
2. **Known domains cost nothing.** `gmail.com`, `icloud.com` and the like answer from a table, with no query, so no DNS answer can change
   them.
3. **An MX record picks, it does not write.** The hosts of the lowest preference are matched by whole labels against a fixed table of
   zones. A match gives a provider whose servers come from Senderban's own table, so a forged record that lands here reaches a known
   provider at worst. MXroute is the one exception: its mailbox server is the MX host, so the name stays, but only one label inside
   `mxrouting.net`. Hosts of one preference that disagree are nobody's.
4. **An unknown mail host is asked.** In the order of RFC 5804 §1.8, with the primary MX in between because most servers run both: the
   first `_sieve._tcp` target, the primary MX, the domain, with names inside the domain moved to the front so that a forged record cannot
   stand before the real server. At most three, side by side, 5 seconds each, read in that order, so one that answers stops those
   behind it. A probe is `probeManageSieve`, so nothing of the person's is sent and the answer comes from behind
   verified TLS. Next comes the `_imaps._tcp` target of RFC 6186, on 993 only, as a cleaning account. Then "unknown".
5. **Inside the mail domain is evidence, outside is none (RFC 6186 §6).** Someone who can forge a DNS answer still needs a public
   certificate for the name, and that takes hold of the person's domain. So a name from DNS fills the form only when it is the domain
   or below it, MXroute's servers apart (decision 3). Not on a public suffix, where strangers register the names below it: such a
   domain has no inside. A name outside comes back as `named`: the page says records can be forged, sends the person to their
   provider's welcome mail or account page, gives the name last, as data, and leaves the field empty without moving the cursor there.
   A hosted domain pays one paste for this. A subdomain the domain has given away is out of sight here.
6. **The process that asks compares for itself.** The main process checks the server against the address's domain, and for an outside
   name the dialog in front of the password opens with "This server is not part of example.com." A preset, a server this table names
   for that very domain and an MXroute server get no note: a note that is false on `icloud.com` teaches people to pass it. This guards
   against forged DNS and a mistyped name, not against a taken-over page, which sends the address too; the dialog's `Address:` line is
   what is left for that.
7. **A name from DNS is held to the rule of a typed one, and more.** `isPublicHostName` is the same check the form uses. SRV ports are
   limited to 4190, 2000 and 993. The probe's socket takes its address from `publicAddressLookup`, which drops private, loopback and
   link-local answers and the IPv6 forms that carry an IPv4 address, inside the socket's one lookup. A name cannot answer one thing to a
   check and another to the connection. A greeting, and a probe's capabilities, stop at 8 KiB.
8. **A suggestion fills the form and nothing else.** The password, Add and the dialog stay as they were. Anything typed for an address
   before, a password above all, is cleared.
9. **The system's resolver only.** No DNS over HTTPS and no list of ours: plain DNS to the servers the system lists. These are not
   always the path an app's own name lookups take: `dns.Resolver` reads the server list and does not use the hosts file, and a system set
   to encrypted DNS is not known to use it here. The privacy page says so.

## Standards

- **RFC 6186 §6** asks for two things: to check that a target lies in the queried domain, which decision 5 does, and for a target outside
  it to verify with the user before any connection. **That second part is a departure:** a probe connects first. It follows the
  person's click and carries nothing of theirs, what it gives away is the person's IP address, and an outside name it finds never
  reaches the form. The `_imaps._tcp` target is never connected to here.
- **RFC 7817 §3** lists the address's domain and the connected host name as reference identifiers. Senderban checks the host name the
  person sees in the dialog. The SRV-ID comparison §3 adds for RFC 6186 discovery is not done: Node reads no SRV-ID, and leaving it out
  only makes fewer certificates pass. A host with a certificate only for the mail domain fails the probe, and the domain is tried next.
- **RFC 5804 §1.8** has a client try every SRV target; a suggestion takes the first.
- ADR 0012 did not use `_sieve._tcp` because unsigned DNS should not choose where a password goes. That still stands: a name from DNS
  reaches the password only from inside the domain, where the certificate speaks for it.

## Scale budget

Unit: a click, not an account. One click costs 3 DNS queries sent together and at most 3 TCP and TLS connections, none for a known
domain, and the two SRV queries are cancelled when the MX answer is enough. There is no timer, no table and no work at idle, so nothing
grows with the account count: 50 accounts are 50 clicks in the life of the install, and the same at 10x and 100x. No shared or paid
upstream is touched. The `account-detect` log line carries the result kind, the time, the record and probe counts and the MX error
code, never the domain or a server.

## Measured

On 2026-11-01, in Electron 45.1:

| Case                                                      | Result                                | Time        |
| --------------------------------------------------------- | ------------------------------------- | ----------- |
| Known domain                                              | from the table                        | 12 ms       |
| MX in the table (Migadu, mailbox.org, Purelymail, others) | provider                              | 31-219 ms   |
| MXroute                                                   | provider, primary MX as the server    | 104 ms      |
| Google Workspace and Microsoft 365 custom domains         | Gmail, Microsoft                      | 36, 91 ms   |
| `yahoo.co.uk`, `verizon.net`                              | Yahoo, AOL                            | 138, 166 ms |
| Domain with a public ManageSieve, not in the table        | `server`, the domain itself           | 534-684 ms  |
| `_imaps._tcp` inside the domain, port 4190 filtered       | `clean` with a name from DNS          | about 5.2 s |
| Null MX (`example.com`)                                   | no mail                               | 39 ms       |
| Domain that does not exist                                | no domain                             | 86 ms       |
| Nothing found, port 4190 filtered                         | unknown                               | about 5.2 s |
| Dead resolver (Node 24.14)                                | `dns-failed`, one server, two or more | 6 s, 10 s   |

- Five real ManageSieve servers answered a probe in 294 to 1,229 ms, so 5 seconds leaves a margin of 4.
- `imap.mail.me.com`, `imap.mail.yahoo.com`, `imap.aol.com`, `imap.gmx.net`, `imap.gmx.com` and `imap.web.de` greeted on 993 under a
  certificate that verified. Each is also on the provider's own help page.
- The page was driven through every result in real Electron with a fake main process, in both themes. No test covers the page's
  script in `npm test`, so the rules that matter live in core and the main process, where tests do reach them.

## Accepted risks

- **A gateway hides the host.** A domain behind Proofpoint or Mimecast shows the gateway in its MX record, so it reads as unknown even
  on Microsoft 365. The person picks the provider by hand, as before.
- **`verizon.net` reads as AOL**, which runs its mail. AOL's help pages give it the same IMAP server.
- **An address at the wrong domain** gets a fillable name, with no note: the name is inside that domain. A typo in the domain or a
  person told what to type lands here, with no forged DNS. Nothing here can tell. The dialog still names the server and the address.
- **The `named` text is attacker-written on a forged answer.** It is printed last, as data, and the person is sent elsewhere for the
  name, but no test with people exists.
- **A name lookup cannot be cancelled.** `publicAddressLookup` runs on libuv's threadpool, so a stuck system resolver holds up to 3 of its
  4 threads past the deadline. The click is freed either way. How long Windows holds one was not measured.

## Not measured

- Adding an account from a suggestion at any provider.
- A forged answer on a real network with a real certificate.
- Node 24.14 here reports `127.0.0.1` as its DNS server and every `resolveMx` is refused (nodejs/node #62347), while Electron 45.1's
  c-ares finds the real server. A person's machine where Electron does the same gets "Could not read this domain's mail records", and the
  form still works.
- The DNS server of an IPv6-only network, and a Windows system set to encrypted DNS.
- A DNS64 network: every IPv4-only mail host arrives under `64:ff9b::/96`, which is refused, so a probe finds nothing there and
  detection falls through to `_imaps` or unknown. It fails closed; the form still works.
