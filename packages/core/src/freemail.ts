// Blocking a whole freemail domain would block millions of unrelated senders, so domain-level
// blocks are refused for these. SEED LIST: incomplete by design. The Public Suffix List check
// from the architecture notes (K7) is not implemented yet, so shared hosting suffixes are not
// covered; tracked as a Phase 4 item.
const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "mail.com",
  "mail.ru",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "fastmail.com",
  "tutanota.com",
  "tuta.com",
]);

/** True for a freemail domain or any subdomain of one (`mail.gmail.com`). Input must be lowercase ASCII. */
export function isFreemail(domain: string): boolean {
  let candidate = domain;
  for (;;) {
    if (FREEMAIL_DOMAINS.has(candidate)) return true;
    const dot = candidate.indexOf(".");
    if (dot === -1) return false;
    candidate = candidate.slice(dot + 1);
  }
}
