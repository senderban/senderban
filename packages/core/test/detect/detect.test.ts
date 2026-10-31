import { describe, expect, it, vi } from "vitest";
import { detectProvider, type DetectFacts, type DetectTools } from "../../src/detect/detect.js";

const M365 = "protection.outlook.com";
const PROTON = "protonmail.ch";
const MXROUTE = "mxrouting.net";
const AOL = "gm0.yahoodns.net";
const YAHOO = "am0.yahoodns.net";
const GMX_EMIG = "emig.gmx.net";
const GMX = "gmx.net";
const ICLOUD = "mail.icloud.com";

const noData = (): Promise<never> =>
  Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));

/** A domain with nothing in DNS, and no server that answers; each test sets what it is about. */
function tools(over: Partial<DetectTools> = {}): DetectTools & {
  probe: ReturnType<typeof vi.fn>;
  findMx: ReturnType<typeof vi.fn>;
} {
  return {
    findMx: vi.fn(noData),
    findSrv: vi.fn(noRecord),
    probe: vi.fn(() => Promise.resolve(false)),
    ...over,
  } as never;
}

/** What the real resolver says of a name with no record (measured 2026-11-01). */
const noRecord = (): Promise<never> =>
  Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));

const probed = (net: { probe: ReturnType<typeof vi.fn> }): unknown[] =>
  net.probe.mock.calls.map((call: unknown[]) => call.slice(0, 2));

const mx = (...hosts: (readonly [string, number])[]) =>
  vi.fn(() => Promise.resolve(hosts.map(([exchange, priority]) => ({ exchange, priority }))));

const srv = (service: string, name: string, port: number, priority = 0) =>
  vi.fn((query: string) =>
    query.startsWith(service) ? Promise.resolve([{ name, port, priority }]) : noRecord(),
  );

describe("a domain Senderban knows", () => {
  it.each([
    ["gmail.com", { kind: "gmail" }],
    ["hotmail.com", { kind: "microsoft" }],
    ["proton.me", { kind: "unsupported", name: "Proton Mail" }],
    [
      "icloud.com",
      { kind: "clean", name: "iCloud", host: "imap.mail.me.com", port: 993, switchOn: false },
    ],
    ["gmx.de", { kind: "clean", name: "GMX", host: "imap.gmx.net", port: 993, switchOn: true }],
  ])("%s costs no query", async (domain, answer) => {
    const net = tools();
    expect(await detectProvider(domain, net)).toEqual(answer);
    expect(net.findMx).not.toHaveBeenCalled();
    expect(net.findSrv).not.toHaveBeenCalled();
    expect(net.probe).not.toHaveBeenCalled();
  });
});

describe("an MX record", () => {
  it.each([
    ["smtp.google.com", { kind: "gmail" }],
    ["aspmx.l.google.com", { kind: "gmail" }],
    ["aspmx2.googlemail.com", { kind: "gmail" }],
    [`tenant.${M365}`, { kind: "microsoft" }],
    ["contoso-com.a-v1.mx.microsoft", { kind: "microsoft" }],
    ["mx.migadu.com", { kind: "preset", provider: "migadu" }],
    ["mx1.mailbox.org", { kind: "preset", provider: "mailbox-org" }],
    ["mailserver.purelymail.com", { kind: "preset", provider: "purelymail" }],
    [`mail.${PROTON}`, { kind: "unsupported", name: "Proton Mail" }],
    [
      `server.${MXROUTE}`,
      { kind: "server", provider: "mxroute", host: `server.${MXROUTE}`, port: 4190 },
    ],
  ])("%s picks its provider and no probe runs", async (host, answer) => {
    const net = tools({ findMx: mx([host, 10]) });
    expect(await detectProvider("example.com", net)).toEqual(answer);
    expect(net.probe).not.toHaveBeenCalled();
  });

  it("tells AOL's zone from Yahoo's, and GMX's two hosts apart", async () => {
    const host = async (exchange: string): Promise<unknown> =>
      detectProvider("example.com", tools({ findMx: mx([exchange, 10]) }));
    expect(await host(`mx-aol.mail.${AOL}`)).toMatchObject({ host: "imap.aol.com" });
    expect(await host(`mta5.${YAHOO}`)).toMatchObject({ host: "imap.mail.yahoo.com" });
    expect(await host(`mx00.${GMX_EMIG}`)).toMatchObject({ host: "imap.gmx.net" });
    expect(await host(`mx00.${GMX}`)).toMatchObject({ host: "imap.gmx.com" });
  });

  it("matches whole labels, not the end of a name", async () => {
    const net = tools({ findMx: mx(["evilgoogle.com", 10]) });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "unknown" });
    expect(probed(net)).toContainEqual(["evilgoogle.com", 4190]);
  });

  it("reads the lowest preference only, in any order and any case", async () => {
    const net = tools({ findMx: mx(["backup.example.net", 20], ["MX.Migadu.COM.", 10]) });
    expect(await detectProvider("example.com", net)).toEqual({
      kind: "preset",
      provider: "migadu",
    });
  });

  it("does not take MXroute's relay for its server", async () => {
    const net = tools({ findMx: mx([`server-relay.${MXROUTE}`, 10]) });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "unknown" });
  });

  it("calls a domain split between two providers nobody's", async () => {
    const net = tools({ findMx: mx(["smtp.google.com", 10], ["mx.migadu.com", 10]) });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "unknown" });
    expect(net.probe).toHaveBeenCalled();
  });
});

describe("a domain's answer that is no answer", () => {
  it("reads a null MX as no mail (RFC 7505)", async () => {
    const net = tools({ findMx: mx(["", 0]) });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "no-mail" });
    expect(net.probe).not.toHaveBeenCalled();
  });

  it("calls a domain the resolver cannot find only that", async () => {
    const net = tools({
      findMx: vi.fn(() => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }))),
    });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "no-domain" });
    expect(net.probe).not.toHaveBeenCalled();
  });

  it("does not call a resolver that failed no mail, and spends no socket on it", async () => {
    const net = tools({
      findMx: vi.fn(() => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))),
    });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "dns-failed" });
    expect(net.probe).not.toHaveBeenCalled();
  });

  it("asks nothing about a private name", async () => {
    const net = tools();
    expect(await detectProvider("mail.local", net)).toEqual({ kind: "unknown" });
    expect(await detectProvider("example.internal", net)).toEqual({ kind: "unknown" });
    expect(net.findMx).not.toHaveBeenCalled();
  });
});

describe("a server the table does not know", () => {
  it("asks the SRV target, the primary mail host and the domain, each once", async () => {
    const net = tools({
      findMx: mx(["mail.example.net", 10], ["z.example.net", 20]),
      findSrv: srv("_sieve", "sieve.example.net", 4190),
    });
    await detectProvider("example.com", net);
    expect(probed(net)).toEqual([
      ["sieve.example.net", 4190],
      ["mail.example.net", 4190],
      ["example.com", 4190],
    ]);
  });

  it("never opens more than three sockets", async () => {
    const net = tools({
      findMx: mx(
        ...Array.from({ length: 64 }, (_, i) => [`m${String(i)}.example.net`, 10] as const),
      ),
    });
    await detectProvider("example.com", net);
    expect(net.probe.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("prefers the SRV record over a mail host that also answers", async () => {
    const net = tools({
      findMx: mx(["mail.example.net", 10]),
      findSrv: srv("_sieve", "sieve.example.com", 2000),
      probe: vi.fn(() => Promise.resolve(true)),
    });
    expect(await detectProvider("example.com", net)).toEqual({
      kind: "server",
      provider: "other",
      host: "sieve.example.com",
      port: 2000,
    });
  });

  it("does not ask the same host twice", async () => {
    const net = tools({
      findMx: mx(["example.com", 10]),
      findSrv: srv("_sieve", "example.com", 4190),
    });
    await detectProvider("example.com", net);
    expect(net.probe).toHaveBeenCalledTimes(1);
  });

  it("takes a probe that failed for a no", async () => {
    const net = tools({
      findMx: mx(["mail.example.net", 10]),
      probe: vi.fn(() => Promise.reject(new Error("refused"))),
    });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "unknown" });
  });

  it("falls back to the IMAP SRV record, for cleaning", async () => {
    const net = tools({
      findMx: mx(["mail.example.net", 10]),
      findSrv: srv("_imaps", "imap.example.com", 993),
    });
    expect(await detectProvider("example.com", net)).toEqual({
      kind: "clean",
      name: null,
      host: "imap.example.com",
      port: 993,
      switchOn: false,
    });
  });

  it("carries on when the MX query failed but the domain names its servers", async () => {
    const net = tools({
      findMx: vi.fn(() => Promise.reject(Object.assign(new Error("x"), { code: "ETIMEOUT" }))),
      findSrv: srv("_sieve", "sieve.example.net", 4190),
      probe: vi.fn(() => Promise.resolve(true)),
    });
    expect(await detectProvider("example.com", net)).toMatchObject({
      host: "sieve.example.net",
    });
  });
});

describe("a name outside the mail domain (RFC 6186 §6)", () => {
  it.each([
    ["an MX host that answers", { findMx: mx(["mail.attacker.example.net", 10]) }],
    [
      "a sieve SRV target that answers",
      { findSrv: srv("_sieve", "mail.attacker.example.net", 4190) },
    ],
  ])("%s is told, not offered for the form", async (_, over) => {
    const net = tools({
      ...over,
      probe: vi.fn((host: string) => Promise.resolve(host !== "example.com")),
    });
    expect(await detectProvider("example.com", net)).toEqual({
      kind: "named",
      service: "sieve",
      host: "mail.attacker.example.net",
      port: 4190,
    });
  });

  it("an IMAP SRV target, which no probe has seen, is told too", async () => {
    const net = tools({ findSrv: srv("_imaps", "imap.attacker.example.net", 993) });
    expect(await detectProvider("example.com", net)).toEqual({
      kind: "named",
      service: "imap",
      host: "imap.attacker.example.net",
      port: 993,
    });
  });

  it.each(["notexample.com", "example.com.attacker.example.net"])(
    "%s does not pass for the domain",
    async (host) => {
      const net = tools({
        findMx: mx([host, 10]),
        probe: vi.fn((name: string) => Promise.resolve(name === host)),
      });
      expect(await detectProvider("example.com", net)).toMatchObject({ kind: "named", host });
    },
  );

  it("a subdomain does", async () => {
    const net = tools({
      findMx: mx(["mail.eu.example.com", 10]),
      probe: vi.fn(() => Promise.resolve(true)),
    });
    expect(await detectProvider("example.com", net)).toMatchObject({
      kind: "server",
      host: "mail.eu.example.com",
    });
  });
});

describe("the wait", () => {
  it("does not wait for SRV queries the MX record makes useless", async () => {
    const net = tools({
      findMx: mx(["mx.migadu.com", 10]),
      findSrv: vi.fn(() => new Promise<never>(() => undefined)),
    });
    expect(await detectProvider("example.com", net)).toMatchObject({ kind: "preset" });
  });

  it("stops the probes behind the first that answers", async () => {
    const stopped: boolean[] = [];
    const net = tools({
      findMx: mx(["mail.example.com", 10]),
      probe: vi.fn((host: string, _: number, stop: AbortSignal) =>
        host === "mail.example.com"
          ? Promise.resolve(true)
          : new Promise<boolean>((resolve) => {
              stop.addEventListener("abort", () => {
                stopped.push(true);
                resolve(false);
              });
            }),
      ),
    });
    expect(await detectProvider("example.com", net)).toMatchObject({
      kind: "server",
      host: "mail.example.com",
    });
    expect(stopped).toEqual([true]);
  });

  it("keeps the order: a later probe does not beat an earlier one still running", async () => {
    let first: (answer: boolean) => void = () => undefined;
    const net = tools({
      findMx: mx(["mail.example.com", 10]),
      probe: vi.fn((host: string) =>
        host === "mail.example.com"
          ? new Promise<boolean>((resolve) => {
              first = resolve;
            })
          : Promise.resolve(true),
      ),
    });
    const found = detectProvider("example.com", net);
    await vi.waitFor(() => {
      expect(net.probe).toHaveBeenCalled();
    });
    first(true);
    expect(await found).toMatchObject({ host: "mail.example.com" });
  });
});

describe("what hostile DNS can do", () => {
  it.each([
    ["an address", "192.168.1.1"],
    ["a private name", "router.local"],
    ["an internal name", "mail.corp"],
    ["a name with a space", "mail example.net"],
    ["a line break", "mail.example.net\r\nNOOP"],
    ["a single label", "localhost"],
    ["an empty root", ""],
    ["an overlong name", `${"a".repeat(300)}.example.net`],
  ])("an MX record holding %s reaches no socket", async (_, exchange) => {
    const net = tools({ findMx: mx([exchange, 10]) });
    await detectProvider("example.com", net);
    expect(probed(net)).toEqual([["example.com", 4190]]);
  });

  it.each([
    ["an address", "10.0.0.1", 4190],
    ["no service (RFC 2782)", "", 0],
    ["a port no server runs ManageSieve on", "sieve.example.net", 25],
    ["a port out of range", "sieve.example.net", 70_000],
  ])("a sieve SRV record holding %s reaches no socket", async (_, name, port) => {
    const net = tools({ findSrv: srv("_sieve", name, port) });
    await detectProvider("example.com", net);
    expect(probed(net)).toEqual([["example.com", 4190]]);
  });

  it.each([
    ["a plain port", "imap.example.net", 143],
    ["an address", "10.0.0.1", 993],
  ])("an IMAP SRV record with %s is no suggestion", async (_, name, port) => {
    const net = tools({ findSrv: srv("_imaps", name, port) });
    expect(await detectProvider("example.com", net)).toEqual({ kind: "unknown" });
  });

  it("bounds a reply of any size", async () => {
    const net = tools({
      findMx: mx(...Array.from({ length: 100_000 }, () => ["m.example.net", 10] as const)),
    });
    const seen: DetectFacts[] = [];
    await detectProvider("example.com", net, (facts) => seen.push(facts));
    expect(seen[0]?.records).toBe(32);
  });

  it("cannot name its own server through a known provider's table entry", async () => {
    const net = tools({ findMx: mx([`attacker.${ICLOUD}`, 10]) });
    expect(await detectProvider("example.com", net)).toMatchObject({ host: "imap.mail.me.com" });
  });
});

describe("the log's facts", () => {
  it("carry counts and a code, and no name", async () => {
    const seen: DetectFacts[] = [];
    await detectProvider("example.com", tools({ findMx: mx(["mail.example.net", 10]) }), (facts) =>
      seen.push(facts),
    );
    expect(seen).toEqual([{ records: 1, probes: 2, dnsError: null }]);
  });
});
