import { isPublicHostName } from "../accounts.js";
import { MANAGESIEVE_PORT } from "../mail-server.js";
import { answerForMailHost, DOMAIN_ANSWERS, IMAPS_PORT, type Detection } from "./providers.js";

/** Unit: records. A DNS answer holds thousands at most, and no mail domain has more than a handful. */
export const DNS_RECORDS_MAX = 32;
/** The port RFC 5804 registers, and the one older servers kept (mailbox.org documents both). DNS names no other. */
const SIEVE_PORTS: readonly number[] = [MANAGESIEVE_PORT, 2000];
/** RFC 2782: a priority and a port are 16-bit. */
const WORD_MAX = 65_535;

/** The fields of Node's replies that are read. Node adds more; they are ignored, and the values below are still checked. */
export interface MxRecord {
  readonly exchange: string;
  readonly priority: number;
}
export interface SrvRecord {
  readonly name: string;
  readonly port: number;
  readonly priority: number;
}

/** The network, behind the decisions. Only a fake in a test replaces the live ones. */
export interface DetectTools {
  readonly findMx: (domain: string) => Promise<readonly MxRecord[]>;
  readonly findSrv: (name: string) => Promise<readonly SrvRecord[]>;
  /** True when a usable ManageSieve answers there behind verified TLS. Sends nothing of the person's. */
  readonly probe: (host: string, port: number) => Promise<boolean>;
}

/** What a detection cost, for the log: never the domain or a server. */
export interface DetectFacts {
  readonly records: number;
  readonly probes: number;
  /** The error code of the MX query, if it failed. */
  readonly dnsError: string | null;
}

interface Asked<T> {
  readonly records: readonly T[];
  readonly code: string | null;
}

const asked = async <T>(query: Promise<readonly T[]>): Promise<Asked<T>> => {
  try {
    return { records: (await query).slice(0, DNS_RECORDS_MAX), code: null };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { records: [], code: typeof code === "string" ? code : "UNKNOWN" };
  }
};

/** A host name from DNS, or null. Same rule as a typed one: an address or a private name goes nowhere. */
function usableHost(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const host = name.replace(/\.$/u, "").toLowerCase();
  return isPublicHostName(host) ? host : null;
}

const isWord = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= WORD_MAX;

/** RFC 7505 §3: preference 0 and an empty exchange. Node gives the root as an empty string. */
const isNullMx = (records: readonly MxRecord[]): boolean =>
  records.length === 1 &&
  records[0]?.priority === 0 &&
  (records[0].exchange === "" || records[0].exchange === ".");

/** The hosts of the lowest preference: the rest are backups, and a provider's backup can sit anywhere. */
function primaryHosts(records: readonly MxRecord[]): readonly string[] {
  const valid = records.filter((record) => isWord(record.priority));
  const lowest = Math.min(...valid.map((record) => record.priority));
  return valid
    .filter((record) => record.priority === lowest)
    .map((record) => usableHost(record.exchange))
    .filter((host) => host !== null)
    .sort();
}

/** The provider all primary hosts agree on; a domain split between two is nobody's. */
function agreedProvider(hosts: readonly string[]): Detection | null {
  const answers = hosts.map(answerForMailHost);
  const first = answers[0];
  if (first === undefined || first === null) return null;
  return answers.every((answer) => JSON.stringify(answer) === JSON.stringify(first)) ? first : null;
}

const bySrvOrder = (records: readonly SrvRecord[]): readonly SrvRecord[] =>
  records.filter((record) => isWord(record.priority)).toSorted((a, b) => a.priority - b.priority);

/** RFC 5804 §1.8: the SRV record, then the name itself on 4190. The primary mail host stands between them: most servers run both. */
function sieveCandidates(
  srv: readonly SrvRecord[],
  primary: readonly string[],
  domain: string,
): readonly { readonly host: string; readonly port: number }[] {
  const listed = bySrvOrder(srv)
    .filter((record) => SIEVE_PORTS.includes(record.port))
    .flatMap((record) => {
      const host = usableHost(record.name);
      return host === null ? [] : [{ host, port: record.port }];
    });
  const seen = new Set<string>();
  return [
    ...listed.slice(0, 1),
    ...primary.slice(0, 1).map((host) => ({ host, port: MANAGESIEVE_PORT })),
    { host: domain, port: MANAGESIEVE_PORT },
  ].filter(({ host, port }) => {
    const key = `${host}:${String(port)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imapFromSrv(srv: readonly SrvRecord[]): Detection | null {
  for (const record of bySrvOrder(srv)) {
    const host = usableHost(record.name);
    if (host !== null && record.port === IMAPS_PORT) {
      return { kind: "clean", name: null, host, port: IMAPS_PORT, switchOn: false };
    }
  }
  return null;
}

/**
 * Who runs a mail domain (the form's own check of the address comes first). A domain Senderban knows costs nothing; otherwise the
 * MX record picks from a fixed table, and only a mail host the table does not know is asked what it is. The three queries and the
 * probes run side by side: their wait is the longest of them, not the sum, and the live tools end all of them at one deadline.
 */
export async function detectProvider(
  domain: string,
  tools: DetectTools,
  report?: (facts: DetectFacts) => void,
): Promise<Detection> {
  const known = DOMAIN_ANSWERS.get(domain);
  if (known !== undefined) return known;
  if (!isPublicHostName(domain)) return { kind: "unknown" };

  const [mx, sieve, imaps] = await Promise.all([
    asked(tools.findMx(domain)),
    asked(tools.findSrv(`_sieve._tcp.${domain}`)),
    asked(tools.findSrv(`_imaps._tcp.${domain}`)),
  ]);
  const facts = { records: mx.records.length, dnsError: mx.code };
  const done = (probes: number, detection: Detection): Detection => {
    report?.({ ...facts, probes });
    return detection;
  };

  if (isNullMx(mx.records)) return done(0, { kind: "no-mail" });
  const nothingListed = sieve.records.length === 0 && imaps.records.length === 0;
  // ENOTFOUND is the domain's own no; ENODATA a domain with no MX, which may still name its servers. Anything else: no answer at all.
  if (nothingListed && mx.code === "ENOTFOUND") return done(0, { kind: "no-mail" });
  if (nothingListed && mx.code !== null && mx.code !== "ENODATA") {
    return done(0, { kind: "dns-failed" });
  }

  const primary = primaryHosts(mx.records);
  const provider = agreedProvider(primary);
  if (provider !== null) return done(0, provider);

  const candidates = sieveCandidates(sieve.records, primary, domain);
  const answers = await Promise.all(
    candidates.map(({ host, port }) => tools.probe(host, port).catch(() => false)),
  );
  const found = candidates[answers.indexOf(true)];
  if (found !== undefined) {
    return done(candidates.length, { kind: "server", provider: "other", ...found });
  }
  return done(candidates.length, imapFromSrv(imaps.records) ?? { kind: "unknown" });
}
