// Keeps real mail identities out of this public repository (incident 2026-10-28: a maintainer's real MXroute login, domain and
// server name went into test fixtures). An accident gate, not an adversarial one: a value built at run time ("acme" + ".com",
// base64) is out of reach of any static scan. Two checks, run by the git hooks, `npm test` and CI:
//   1. Allowlist: every e-mail domain, URL host, host name and IPv4 address in a tracked file is a reserved name (RFC 2606,
//      RFC 6761, RFC 5737, RFC 1918), a public host the code names on purpose, or a listed legacy test string. Catches a real
//      name nobody has listed yet.
//   2. Denylist: known real identifiers kept OUTSIDE the repository, in a local file or the SENDERBAN_DENYLIST secret (writing
//      them here would publish them). It covers what 1. cannot see: a bare user name, and a person's own address on a public
//      provider (the allowlist passes any local part at gmail.com).
// Usage: node scripts/check-identifiers.ts              tracked files in the working tree
//        node scripts/check-identifiers.ts --messages   the same, plus every commit message in history (CI, pre-push)
//        node scripts/check-identifiers.ts --staged     staged content (pre-commit hook)
//        node scripts/check-identifiers.ts --message <file>   one commit message (commit-msg hook)
// This file names no example host in its comments: it is scanned like every other tracked file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** RFC 2606 section 2 and RFC 6761 section 6: top-level names that never resolve on the public internet. */
const RESERVED_TLDS = new Set(["example", "test", "invalid", "localhost"]);
/** RFC 2606 section 3: second-level names reserved for documentation. */
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

/**
 * Public zones the code and docs name on purpose: providers Senderban talks to, standards, tooling. A zone matches itself and
 * every subdomain, so only a zone whose subdomains are all the operator's own belongs here.
 */
const PUBLIC_ZONES = [
  "google.com",
  "googleapis.com",
  "googleusercontent.com",
  "gmail.com",
  "googlemail.com",
  "mxroute.com",
  "imapflow.com",
  "github.com",
  "githubusercontent.com",
  "microsoft.com",
  "electronjs.org",
  "nodejs.org",
  "npmjs.com",
  "npmjs.org",
  "apache.org",
  "rfc-editor.org",
  "ietf.org",
  "owasp.org",
  "w3.org",
  "mozilla.org",
  "schemastore.org",
  // The project's own domain (docs/CNAME, the OAuth homepage).
  "senderban.com",
];

/**
 * Names allowed as exactly themselves, never their subdomains: a subdomain of a public suffix or a two-letter host is
 * somebody's real domain. Registrable test strings written before the reserved-name rule (2026-10-27; none is a maintainer's),
 * public suffixes the address parser is tested on, and single public hosts. New tests use reserved names; this list does not grow.
 */
export const EXACT_HOSTS: readonly string[] = [
  "a.co",
  "b.com",
  "c.com",
  "co.com",
  "x.com",
  "y.com",
  "bank.com",
  "mycompany.com",
  "notgmail.com",
  "megmail.com",
  "evilgoogle.com",
  "notexample.com",
  "other.org",
  "index.com.tr",
  "shop.co.uk",
  "a.b.co.uk",
  "xn--bnk-6cd.com",
  "co.uk",
  "org.uk",
  "com.tr",
  "ac.jp",
  // GitHub Pages' root only: a user's own pages are a subdomain.
  "github.io",
  // The server field's placeholder in Advanced (advanced.js): MXroute's naming.
  "eagle.mxlogin.com",
];

/** `packages/core/src/freemail.ts` is itself a list of public mail providers; each is allowed as exactly itself. */
const FREEMAIL_FILE = "packages/core/src/freemail.ts";

/**
 * In code, a dotted word outside quotes counts as a host only with one of these top-level labels, so file names (a `.ts` or
 * `.md` file) and property chains ending in `.at()`, `.ca` or `.store` stay out.
 */
const BARE_TLDS = new Set(
  "com net org io dev co info biz xyz ai uk de fr tr eu us au nl ru jp br es ch se pl cz dk fi ie nz za mx ar kr cn tw hk sg".split(
    " ",
  ),
);
/** In a quoted string and in any file that is not code, these count too (they collide with code only outside quotes). */
const WIDE_TLDS = new Set([
  ...BARE_TLDS,
  // Not "email" or "name": `gmail.email` and `extraMetadata.name` are field names in code and docs.
  ..."app me in it be at ca no store shop online site tech cloud page pro vip live mobi".split(" "),
]);
/** Files read as code: outside quotes only BARE_TLDS count. Every other text file (md, yml, json, html, txt, env) uses WIDE_TLDS. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|css)$/iu;
/** Lane ids put a provider suffix after the mailbox domain (`a@example.com.mxroute`); the domain before it is what is checked. */
const LANE_SUFFIX = /\.(?:mxroute|gmail)$/u;

/**
 * The address parser's hostile inputs (a Cyrillic letter, a percent-encoded letter, a `\t` escape inside a domain) would leave
 * the rest of the domain behind as a false host. Escapes, percent codes and non-ASCII letters, marks and format characters (soft
 * hyphen, zero-width, bidi) become U+FFFD, and no host may start right after one. Other non-ASCII (typographic quotes, NBSP,
 * dashes) becomes a space, so a host next to it is still read. A real Unicode-letter domain is missed (its ASCII tail is skipped); its punycode
 * form (`xn--…`) is checked.
 */
const ESCAPED =
  /\\(?:u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[nrtbfv0])|%[0-9A-Fa-f]{2}|(?![\t -~])[\p{L}\p{M}\p{Cf}]/gu;
// The section sign stays: an RFC section number after it (four dotted numbers) is not an address.
const OTHER_NON_ASCII = /[^\t -~�§]/gu;
const MARK = "�";

/** Binary files: the allowlist does not read them, the denylist still does (an ASCII term survives in a database or a document). */
const BINARY =
  /\.(?:png|ico|jpe?g|gif|webp|woff2?|ttf|zip|gz|exe|dll|node|pdf|docx|xlsx|pptx|db|sqlite3?|p12|pfx|jar|svgz)$/iu;
/** Generated: npm writes package maintainers' addresses into it. The denylist still reads it. */
const LOCKFILE = /(?:^|\/)package-lock\.json$/u;

/** Shortest denylist term: shorter ones would match ordinary words. A shorter term is reported, not dropped quietly. */
export const DENYLIST_TERM_MIN = 4;
/**
 * Longest line the host scan reads. The four host patterns are linear, but a minified or base64 line of megabytes is no place
 * for a hand-written fixture; it is reported as a finding (fail closed), not skipped. 100,000 characters is 20x the longest
 * line in the tree on 2026-10-28.
 */
export const LINE_MAX_CHARS = 100_000;

const LABEL_CHARS = "[A-Za-z0-9_-]";
const HOST = `(?:${LABEL_CHARS}+\\.)+(xn--[A-Za-z0-9-]+|[A-Za-z]{2,63})`;
// The local part may not continue left of the match: without this lookbehind the pattern is quadratic on a long run of letters.
const EMAIL = new RegExp(`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(${HOST})`, "gu");
// Any scheme (https, imaps, sieve, wss) or none (`//host`): matching from `//` keeps the pattern linear on long lines.
const URL_HOST = new RegExp(`\\/\\/(?:[^\\s/@]+@)?(${HOST})`, "gu");
const BARE_HOST = new RegExp(`(?<![\\w.@/\\-\\uFFFD])(${HOST})(?![\\w-])`, "gu");
const QUOTED_HOST = new RegExp(`["'\`](${HOST})(?::\\d{1,5})?["'\`]`, "gu");
// Not after "§" or "RFC 9051 ": four dotted numbers there are a section number.
const IPV4 = /(?<![\d.§])(?<!RFC ?\d{1,5} )((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/gu;
// A host label, or an underscore label (`_dmarc`, `_domainkey`, SRV) that only DNS records use. An underscore anywhere else
// makes it no host name at all: a parser test's input.
const LABEL = /^(?:_[a-z0-9-]{1,62}|(?!-)[a-z0-9-]{1,63}(?<!-))$/u;

export interface Finding {
  readonly file: string;
  readonly line: number;
  /** "host" for an allowlist miss, "denylist" for a known real identifier, "unscannable" for a line or file the scan cannot read. */
  readonly kind: "host" | "denylist" | "unscannable";
  /** The host or address for "host"; the term's 1-based position in the denylist for "denylist" (never the term); a reason otherwise. */
  readonly what: string;
}

function within(host: string, zone: string): boolean {
  return host === zone || host.endsWith(`.${zone}`);
}

/** Loopback, private and documentation ranges: RFC 1122, RFC 1918, RFC 3927, RFC 5737, RFC 6598, plus 0.0.0.0 and broadcast. */
function isReservedIpv4(address: string): boolean {
  const o = address.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n > 255)) return true; // a version number, not an address
  const [a = 0, b = 0, c = 0] = o;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    a === 255 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** True when `host` may appear in this repository. `exact` adds names allowed as exactly themselves (the freemail list). */
export function isAllowedHost(host: string, exact: ReadonlySet<string> = new Set()): boolean {
  const h = host.toLowerCase().replace(/\.$/u, "").replace(LANE_SUFFIX, "");
  if (/^[\d.]+$/u.test(h)) return isReservedIpv4(h);
  const labels = h.split(".");
  // Not a valid host name (a label starting with "-", an empty label): a parser test's input, not a real name.
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return true;
  if (RESERVED_TLDS.has(labels[labels.length - 1] ?? "")) return true;
  if (RESERVED_DOMAINS.some((d) => within(h, d)) || PUBLIC_ZONES.some((d) => within(h, d)))
    return true;
  return EXACT_HOSTS.includes(h) || exact.has(h);
}

/** Every allowlist miss and denylist hit in one text. `binary` skips the allowlist (it reads the denylist only). */
export function scanText(
  text: string,
  file: string,
  denylist: readonly string[],
  exact: ReadonlySet<string> = new Set(),
  binary = false,
): Finding[] {
  const found: Finding[] = [];
  const readHosts = !binary && !LOCKFILE.test(file);
  const bareTlds = CODE_FILE.test(file) ? BARE_TLDS : WIDE_TLDS;
  text.split(/\r?\n/u).forEach((raw, i) => {
    const line = i + 1;
    if (readHosts && raw.length > LINE_MAX_CHARS) {
      found.push({
        file,
        line,
        kind: "unscannable",
        what: `line longer than ${String(LINE_MAX_CHARS)} characters`,
      });
    } else if (readHosts) {
      const text = raw.replace(ESCAPED, MARK).replace(OTHER_NON_ASCII, " ");
      const hosts = new Set<string>();
      const take = (m: RegExpMatchArray, tlds?: ReadonlySet<string>) => {
        const h = m[1];
        if (h === undefined) return;
        const tld = (m[2] ?? "").toLowerCase();
        if (tlds === undefined || tld.startsWith("xn--") || tlds.has(tld))
          hosts.add(h.toLowerCase());
      };
      for (const m of text.matchAll(EMAIL)) take(m);
      for (const m of text.matchAll(URL_HOST)) take(m);
      for (const m of text.matchAll(BARE_HOST)) take(m, bareTlds);
      for (const m of text.matchAll(QUOTED_HOST)) take(m, WIDE_TLDS);
      for (const m of text.matchAll(IPV4)) if (m[1] !== undefined) hosts.add(m[1]);
      for (const host of hosts) {
        if (!isAllowedHost(host, exact)) found.push({ file, line, kind: "host", what: host });
      }
    }
    const lower = raw.toLowerCase();
    denylist.forEach((term, n) => {
      if (lower.includes(term))
        found.push({ file, line, kind: "denylist", what: `#${String(n + 1)}` });
    });
  });
  return found;
}

/**
 * Terms from SENDERBAN_DENYLIST (CI secret), else SENDERBAN_DENYLIST_FILE, else the per-user file; one per line or comma,
 * `#` comments. `short` counts the terms under DENYLIST_TERM_MIN, which are not used.
 */
export function loadDenylist(env: NodeJS.ProcessEnv = process.env): {
  terms: string[];
  short: number;
  source: string;
} {
  const parse = (raw: string) =>
    raw
      .split(/[\r\n,]+/u)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && !t.startsWith("#"));
  const pick = (all: string[], source: string) => ({
    terms: all.filter((t) => t.length >= DENYLIST_TERM_MIN),
    short: all.filter((t) => t.length < DENYLIST_TERM_MIN).length,
    source,
  });
  const fromEnv = env.SENDERBAN_DENYLIST;
  if (fromEnv !== undefined && fromEnv.trim() !== "")
    return pick(parse(fromEnv), "SENDERBAN_DENYLIST");
  const file =
    env.SENDERBAN_DENYLIST_FILE ??
    join(env.APPDATA ?? join(homedir(), ".config"), "senderban-dev", "denylist.txt");
  if (!existsSync(file)) return { terms: [], short: 0, source: "none" };
  return pick(parse(readFileSync(file, "utf8")), "file");
}

/** The freemail provider names, read from the source so the two lists cannot drift. */
export function freemailHosts(root: string): Set<string> {
  const path = join(root, FREEMAIL_FILE);
  if (!existsSync(path)) return new Set();
  return new Set(
    [...readFileSync(path, "utf8").matchAll(/"([a-z0-9.-]+\.[a-z]{2,})"/gu)].map((m) => m[1] ?? ""),
  );
}

function git(
  root: string,
  args: readonly string[],
  encoding: "utf8" | "buffer" = "utf8",
): string | Buffer {
  return execFileSync("git", args, {
    cwd: root,
    encoding: encoding === "utf8" ? "utf8" : "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** A file's text: UTF-16 (BOM) decoded as such, so a file saved by PowerShell's `>` is read, not skipped as noise. */
export function decode(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  return bytes.toString("utf8");
}

/** Tracked files read from the working tree, or staged blobs. A file that cannot be read is a finding, not a pass. */
export function scanRepo(root: string, denylist: readonly string[], staged = false): Finding[] {
  const exact = freemailHosts(root);
  const list = String(
    staged
      ? git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
      : git(root, ["ls-files", "-z"]),
  );
  const found: Finding[] = [];
  for (const file of list.split("\0").filter((f) => f !== "")) {
    let bytes: Buffer;
    try {
      bytes = staged
        ? (git(root, ["show", `:${file}`], "buffer") as Buffer)
        : readFileSync(join(root, file));
    } catch (error) {
      // Deleted in the working tree but still tracked: nothing on disk to publish. Anything else fails closed.
      if (!staged && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      found.push({ file, line: 0, kind: "unscannable", what: "could not be read" });
      continue;
    }
    const binary = BINARY.test(file);
    found.push(
      ...scanText(binary ? bytes.toString("latin1") : decode(bytes), file, denylist, exact, binary),
    );
  }
  return found;
}

/** A finding as printed. In CI the log is public: file and line only, the commit already holds the value. */
export function shown(f: Finding, masked: boolean): string {
  if (f.kind === "denylist") return `denylist item ${f.what}`;
  if (f.kind === "unscannable") return `unscannable: ${f.what}`;
  return masked ? "host not allowed" : f.what;
}

function main(argv: readonly string[]): number {
  const root = resolve(import.meta.dirname, "..");
  const { terms, short, source } = loadDenylist();
  const masked = process.env.CI === "true";
  if (short > 0) {
    console.error(
      `check-identifiers: ${String(short)} denylist term(s) shorter than ${String(DENYLIST_TERM_MIN)} characters are not used`,
    );
  }
  // A push to this repository or a pull request from a branch of it must have the denylist: without it CI would pass a known
  // real identifier. Only a fork's pull request (no secrets by GitHub's design) runs on the allowlist alone, and says so.
  if (source === "none" && process.env.SENDERBAN_REQUIRE_DENYLIST === "true") {
    console.error("check-identifiers: SENDERBAN_DENYLIST is required here and is not set");
    return 1;
  }
  if (masked && source === "none") {
    console.log("::warning::SENDERBAN_DENYLIST is not set: denylist SKIPPED, allowlist only");
  }
  let found: Finding[];
  const at = argv.indexOf("--message");
  if (at >= 0) {
    const file = argv[at + 1];
    if (file === undefined) {
      console.error("check-identifiers: --message needs a file");
      return 2;
    }
    found = scanText(readFileSync(file, "utf8"), "commit message", terms, freemailHosts(root));
  } else {
    found = scanRepo(root, terms, argv.includes("--staged"));
    if (argv.includes("--messages")) {
      // Every commit message of every ref: one `git log`, scanned as one text (a hit names the line, not the commit).
      const messages = String(git(root, ["log", "--all", "--format=%B"]));
      found.push(...scanText(messages, "commit messages", terms, freemailHosts(root)));
    }
  }
  for (const f of found) console.error(`${f.file}:${String(f.line)}: ${shown(f, masked)}`);
  if (found.length > 0) {
    console.error(
      `check-identifiers: ${String(found.length)} finding(s). Use reserved names (example.com, *.example, *.test, *.invalid, ` +
        "192.0.2.x) in tests and docs; a public provider the code needs goes into PUBLIC_ZONES or EXACT_HOSTS with a reason.",
    );
    return 1;
  }
  console.log(`check-identifiers: clean (denylist: ${source}, ${String(terms.length)} terms)`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
