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
  "hotmail.co.uk",
  "live.co.uk",
  "outlook.co.uk",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "hotmail.com.tr",
  "outlook.com.tr",
  "yahoo.com.tr",
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

const SECOND_LEVEL_SUFFIX_LABELS: ReadonlySet<string> = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "ac",
  "edu",
  "or",
  "ne",
  "go",
]);

/**
 * True for a country-code public suffix such as `co.uk` or `com.tr`: blocking it would junk every
 * sender of a country. INTERIM shape check until the Public Suffix List is vendored (K7), so
 * private suffixes like `github.io` are still not covered. Input must be lowercase ASCII.
 */
export function isCountrySuffix(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.length !== 2) return false;
  const [second, top] = labels;
  return (
    second !== undefined &&
    top !== undefined &&
    top.length === 2 &&
    SECOND_LEVEL_SUFFIX_LABELS.has(second)
  );
}
