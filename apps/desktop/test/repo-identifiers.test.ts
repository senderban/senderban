import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXACT_HOSTS,
  LINE_MAX_CHARS,
  decode,
  isAllowedHost,
  loadDenylist,
  scanRepo,
  scanText,
  shown,
} from "../../../scripts/check-identifiers.js";

// The repository is public: no real mail identity may be in a tracked file (incident 2026-10-28, scripts/check-identifiers.ts).
// Hosts that must be caught are built at run time with join("."), so this file passes its own scan.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const host = (...labels: string[]) => labels.join(".");
const real = host("acmecorp", "com");
const hosts = (text: string, file = "t.ts") => scanText(text, file, []).map((f) => f.what);

describe("the tracked tree", () => {
  it("has no host outside the allowlist and no denylist term", () => {
    const found = scanRepo(root, loadDenylist().terms);
    expect(found.map((f) => `${f.file}:${String(f.line)} ${shown(f, true)}`)).toEqual([]);
  });
});

describe("the ignore rules", () => {
  it("keep every app data file out of a commit, with its temporary copy", () => {
    const files = ["accounts.json", "google-client.json", "settings.json", "mxroute-keys.json"];
    const names = files.flatMap((f) => [f, `${f}.0a1b.tmp`]);
    const ignored = execFileSync("git", ["check-ignore", ...names], {
      cwd: root,
      encoding: "utf8",
    });
    expect(ignored.trim().split(/\r?\n/)).toEqual(names);
  });
});

describe("scanText: what is caught", () => {
  it("an address, a URL host and a quoted server name", () => {
    const text = [
      `const owner = "info@${real}";`,
      `fetch("https://${host("panel", real)}/login");`,
      `server: "${host("fusion", "mxhost", "net")}",`,
    ].join("\n");
    expect(scanText(text, "t.ts", []).map((f) => [f.line, f.what])).toEqual([
      [1, real],
      [2, host("panel", real)],
      [3, host("fusion", "mxhost", "net")],
    ]);
  });

  it("the domain of a lane id (provider suffix after the mailbox domain)", () => {
    expect(hosts(`const LANE = "info@${real}.mxroute";`)).toEqual([`${real}.mxroute`]);
  });

  it("a subdomain of a public suffix or a legacy test string (those are allowed as exactly themselves only)", () => {
    for (const h of [
      host("acmecorp", "com", "tr"),
      host("acmecorp", "co", "uk"),
      host("acmecorp", "x", "com"),
      host("me", "github", "io"),
    ]) {
      expect(hosts(`"${h}"`)).toEqual([h]);
    }
  });

  it("other schemes, scheme-less URLs, upper case, DNS record labels and a port in quotes", () => {
    expect(hosts(`imaps://${host("imap", real)}:993`)).toEqual([host("imap", real)]);
    expect(hosts(`sieve://${real}`)).toEqual([real]);
    expect(hosts(`HTTPS://${real.toUpperCase()}/x`)).toEqual([real]);
    expect(hosts(`see //${real}/x`)).toEqual([real]);
    expect(hosts(`"${host("_dmarc", real)}"`)).toEqual([host("_dmarc", real)]);
    expect(hosts(`"${host("acmecorp", "me")}:993"`)).toEqual([host("acmecorp", "me")]);
  });

  it("a host next to typographic quotes, a no-break space or a dash", () => {
    expect(hosts(`see \u201c${real}\u201d`, "doc.md")).toEqual([real]);
    expect(hosts(`host\u00a0${real}`, "doc.md")).toEqual([real]);
    expect(hosts(`host\u2014${real}`, "doc.md")).toEqual([real]);
  });

  it("outside code, a bare host with a top-level label that collides with code (it would be missed in a .ts file)", () => {
    const pro = host("acmecorp", "pro");
    expect(hosts(`SERVER=${pro}`, "notes.md")).toEqual([pro]);
    expect(hosts(`SERVER=${pro}`, "x.ts")).toEqual([]);
  });

  it("a punycode top-level label", () => {
    expect(hosts(`see ${host("acmecorp", "xn--p1ai")}`)).toEqual([host("acmecorp", "xn--p1ai")]);
  });

  it("a public IPv4 address, not a documentation, private or loopback one, nor an RFC section number", () => {
    expect(hosts(`dns ${host("8", "8", "8", "8")}`)).toEqual([host("8", "8", "8", "8")]);
    expect(
      hosts("192.0.2.1 198.51.100.7 203.0.113.5 10.0.0.1 127.0.0.1 192.168.1.1 0.0.0.0"),
    ).toEqual([]);
    expect(hosts("RFC 9051 2.3.1.1 and §4.5.3.1")).toEqual([]);
  });

  it("a line too long to scan is a finding, not a pass", () => {
    expect(scanText("a".repeat(LINE_MAX_CHARS + 1), "x.ts", []).map((f) => f.kind)).toEqual([
      "unscannable",
    ]);
  });
});

describe("scanText: what passes", () => {
  it("reserved names, listed public hosts and the freemail list", () => {
    const text = [
      'const a = "info@example.com"; const b = "mx.example.net"; const c = "a@x.example";',
      'const d = "a@b.test"; const e = "a@b.invalid"; const f = "https://gmail.googleapis.com/x";',
      'const g = "a@example.com.mxroute"; const h = "web.de"; const i = "co.uk";',
    ].join("\n");
    expect(scanText(text, "t.ts", [], new Set(["web.de"]))).toEqual([]);
  });

  it("file names, code paths and the address parser's hostile inputs", () => {
    const text = [
      'import { x } from "./main.ts"; write("summary.md"); t.polls.at(-1); options.tls.ca; users.history.list;',
      'parse("noreply@%62ank.com"); parse("noreply@ba\\u0430nk.com"); parse("a@x\\t.com");',
      'parse("noreply@ba\u00adnk.com"); parse("noreply@ba\u200bnk.com"); parse("noreply@b\u0430nk.com"); parse("ba_nk.com");',
    ].join("\n");
    expect(scanText(text, "t.ts", [])).toEqual([]);
  });

  it("the lockfile and binary files are not read for hosts, but the denylist reads them", () => {
    expect(scanText(`"author": "x@${real}"`, "package-lock.json", [])).toEqual([]);
    expect(scanText(`"author": "x@${real}"`, "package-lock.json", ["acmecorp"])).toHaveLength(1);
    expect(scanText(`\u0000x@${real}`, "data.db", [], new Set(), true)).toEqual([]);
    expect(scanText(`\u0000x@${real}`, "data.db", ["acmecorp"], new Set(), true)).toHaveLength(1);
  });

  it("is linear on long lines (a quadratic pattern took 46 s on 200,000 characters)", () => {
    const started = performance.now();
    for (const piece of ["a", "ab.", "a@", "//a.", "x.y@"]) {
      scanText(piece.repeat(Math.floor(LINE_MAX_CHARS / piece.length)), "x.ts", []);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("denylist", () => {
  it("finds a term in any case and reports its position, never the term", () => {
    const found = scanText("username: 'SomeLogin'", "t.ts", ["somelogin"]);
    expect(found).toEqual([{ file: "t.ts", line: 1, kind: "denylist", what: "#1" }]);
    const [f] = found;
    if (f !== undefined) expect(shown(f, false)).toBe("denylist item #1");
  });

  it("reads the CI secret first, one term per line or comma, comments and blanks dropped, lower case; counts short terms", () => {
    const env = { SENDERBAN_DENYLIST: "# real ones\nAlpha1\n\n beta22 ,gamma333, abc" };
    expect(loadDenylist(env)).toEqual({
      terms: ["alpha1", "beta22", "gamma333"],
      short: 1,
      source: "SENDERBAN_DENYLIST",
    });
  });

  it("is empty, not an error, when neither the secret nor the file exists", () => {
    const env = {
      SENDERBAN_DENYLIST_FILE: fileURLToPath(new URL("./no-such-file.txt", import.meta.url)),
    };
    expect(loadDenylist(env)).toEqual({ terms: [], short: 0, source: "none" });
  });
});

describe("printing and decoding", () => {
  it("a public log gets file and line only", () => {
    const [f] = scanText(`"info@${real}"`, "t.ts", []);
    expect(f).toBeDefined();
    if (f === undefined) return;
    expect(shown(f, true)).toBe("host not allowed");
    expect(shown(f, false)).toBe(real);
  });

  it("a UTF-16 file (PowerShell `>`) is read as text", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`x@${real}`, "utf16le")]);
    expect(hosts(decode(le))).toEqual([real]);
    const be = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(`x@${real}`, "utf16le").swap16(),
    ]);
    expect(hosts(decode(be))).toEqual([real]);
  });
});

describe("isAllowedHost", () => {
  it("allows subdomains of a public zone but not a look-alike", () => {
    expect(isAllowedHost("mail.google.com")).toBe(true);
    expect(isAllowedHost(host("google", "com", "evil", "com"))).toBe(false);
    expect(isAllowedHost(host("notgoogle", "com"))).toBe(false);
  });

  it("keeps the exact-only list from growing (new tests use reserved names)", () => {
    expect(EXACT_HOSTS.length).toBeLessThanOrEqual(23);
  });
});

// The script end to end, in a throwaway git repository: tree mode, staged mode, commit messages and exit codes.
describe("check-identifiers.ts in a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "senderban-ids-"));
  // Outside the repository, as in real use: a tracked denylist would find its own terms.
  const outside = mkdtempSync(join(tmpdir(), "senderban-ids-deny-"));
  const denylist = join(outside, "denylist.txt");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=", ...args],
      {
        cwd: dir,
        stdio: "ignore",
      },
    );
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [join(dir, "scripts", "check-identifiers.ts"), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "",
        SENDERBAN_DENYLIST: "",
        SENDERBAN_DENYLIST_FILE: denylist,
        ...env,
      },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    join(root, "scripts", "check-identifiers.ts"),
    join(dir, "scripts", "check-identifiers.ts"),
  );
  writeFileSync(denylist, "somelogin\n");
  git("init", "-q");
  writeFileSync(join(dir, "ok.ts"), 'export const a = "info@example.com";\n');
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", "init");

  it("passes a clean tree", () => {
    expect(run([])).toMatchObject({ code: 0 });
  });

  it("fails a staged file with a real host or a denylist term, and names file and line", () => {
    writeFileSync(
      join(dir, "bad.ts"),
      `// note\nexport const u = "SomeLogin"; const h = "x@${real}";\n`,
    );
    git("add", "bad.ts");
    const r = run(["--staged"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bad.ts:2: denylist item #1");
    expect(r.out).toContain(`bad.ts:2: ${real}`);
    expect(r.out).not.toContain("somelogin");
    git("rm", "-q", "--cached", "bad.ts");
    rmSync(join(dir, "bad.ts"));
  });

  it("fails a commit message with a real host, and every message in history with --messages", () => {
    const message = join(dir, "MSG");
    writeFileSync(message, `fix: x\n\nseen on mail.${real}\n`);
    expect(run(["--message", message]).code).toBe(1);
    git("commit", "-q", "--no-verify", "--allow-empty", "-m", `chore: seen at ${real}`);
    expect(run([]).code).toBe(0);
    const r = run(["--messages"], { CI: "true" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("commit messages:");
    expect(r.out).not.toContain(real);
    // Many git processes: past the default 5 s when a full run loads the machine.
  }, 30_000);

  it("fails when the denylist is required (a push to this repository) and missing", () => {
    const r = run([], {
      SENDERBAN_DENYLIST_FILE: join(dir, "missing.txt"),
      SENDERBAN_REQUIRE_DENYLIST: "true",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("SENDERBAN_DENYLIST is required");
  });
});
