import { isFreemail, isImapAccount, mailboxKey } from "@senderban/core";
import type { AccountConfig, OwnMail } from "@senderban/core";
import { mailDomain } from "./mxroute-settings.js";

/**
 * The addresses and mail domains that are the person's own, for the rule that "Block at server" never refuses them
 * (ADR 0008 point 3): a spammer can forge them in From, and real mail would bounce. Every configured account
 * counts, whether or not the app runs it yet (a Gmail account is only in the file for now), and not only the ones
 * with an MXroute key. A freemail domain (gmail.com) is never "owned": only the full login address is.
 */
export function collectOwnMail(accounts: readonly AccountConfig[]): OwnMail {
  const domains = new Set<string>();
  const addresses = new Set<string>();
  for (const a of accounts) {
    if (isImapAccount(a)) {
      for (const login of [a.imap.user, a.sieve.user]) {
        if (login.includes("@")) addresses.add(mailboxKey(login.toLowerCase()));
      }
      const domain = mailDomain(a);
      if (domain !== null && !isFreemail(domain)) domains.add(domain);
    } else {
      addresses.add(mailboxKey(a.gmail.email));
      const domain = a.gmail.email.slice(a.gmail.email.lastIndexOf("@") + 1);
      if (!isFreemail(domain)) domains.add(domain);
    }
  }
  return { domains, addresses };
}
