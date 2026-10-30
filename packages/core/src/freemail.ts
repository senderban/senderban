import { getPublicSuffix } from "tldts";

// Blocking a whole freemail domain would block millions of unrelated senders, so domain-level
// blocks are refused for these. SEED LIST: incomplete by design; `isNotOffered` adds the Public
// Suffix List (K7) where a domain is offered.
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

/**
 * Mail providers found after 0.1.3. They stop the offer and nothing else: `checkEntry` runs over stored entries, and a refused entry
 * stops the whole lane (`REJECTED`), so one `yahoo.fr` blocked in 0.1.3 would otherwise end every rule of that account after an update.
 */
const FREEMAIL_NOT_OFFERED: ReadonlySet<string> = new Set([
  "yahoo.fr",
  "yahoo.de",
  "hotmail.fr",
  "outlook.de",
  "qq.com",
  "163.com",
  "naver.com",
  "pm.me",
  "hey.com",
  "orange.fr",
  "t-online.de",
  "yahoo.it",
  "yahoo.es",
  "rocketmail.com",
  "aol.fr",
  "live.fr",
  "live.de",
  "outlook.fr",
  "hotmail.de",
  "bk.ru",
  "list.ru",
  "inbox.ru",
  "rambler.ru",
  "libero.it",
  "virgilio.it",
  "laposte.net",
  "free.fr",
  "sfr.fr",
  "wanadoo.fr",
  "bol.com.br",
  "uol.com.br",
  "terra.com.br",
  "seznam.cz",
  "wp.pl",
  "o2.pl",
  "interia.pl",
  "onet.pl",
  "daum.net",
  "hanmail.net",
  "126.com",
  "sina.com",
  "sohu.com",
  "foxmail.com",
  "rediffmail.com",
  "tuta.io",
  "hushmail.com",
  "mailfence.com",
  "att.net",
  "verizon.net",
  "comcast.net",
  "sbcglobal.net",
  "btinternet.com",
  "sky.com",
  "shaw.ca",
  "telus.net",
  "bigpond.com",
  "optusnet.com.au",
  "telia.com",
  "ziggo.nl",
  "kpnmail.nl",
  "mynet.com",
  "turk.net",
  "ttmail.com",
  "superonline.com",
  "yaani.com",
]);

function isListed(list: ReadonlySet<string>, domain: string): boolean {
  let candidate = domain;
  for (;;) {
    if (list.has(candidate)) return true;
    const dot = candidate.indexOf(".");
    if (dot === -1) return false;
    candidate = candidate.slice(dot + 1);
  }
}

/** True for a freemail domain or any subdomain of one (`mail.gmail.com`). Input must be lowercase ASCII. */
export function isFreemail(domain: string): boolean {
  return isListed(FREEMAIL_DOMAINS, domain);
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
 * sender of a country. A shape check, kept because `checkEntry` depends on it; `isNotOffered`
 * covers the rest. Input must be lowercase ASCII.
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

const SUFFIX_OPTIONS = {
  allowPrivateDomains: true,
  extractHostname: false,
  validateHostname: false,
} as const;

/** True for a domain that is itself on the Public Suffix List, ICANN or private section (`co.uk`, `github.io`). */
export function isPublicSuffix(domain: string): boolean {
  return getPublicSuffix(domain, SUFFIX_OPTIONS) === domain;
}

/** True for a domain that other people's mail lives under, so it is never offered as a whole-domain block (K7). Input must be lowercase ASCII. */
export function isNotOffered(domain: string): boolean {
  return (
    isFreemail(domain) ||
    isListed(FREEMAIL_NOT_OFFERED, domain) ||
    isCountrySuffix(domain) ||
    isPublicSuffix(domain)
  );
}
