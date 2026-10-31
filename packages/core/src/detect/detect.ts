import { isPublicHostName } from "../accounts.js";
import { MANAGESIEVE_PORT } from "../mail-server.js";
import {
  answerForMailHost,
  DOMAIN_ANSWERS,
  IMAPS_PORT,
  inZone,
  type Detection,
} from "./providers.js";

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
  /** True when a usable ManageSieve answers there behind verified TLS. Sends nothing of the person's. `stop`: the answer is known. */
  readonly probe: (host: string, port: number, stop: AbortSignal) => Promise<boolean>;
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

/**
 * What may be put in front of a password. An attacker can forge a DNS answer but cannot get a public certificate for a name inside
 * the person's domain, so inside is evidence and outside is none (RFC 6186 §6): an outside name is told, and typed by the person.
 */
const sieveAnswer = (domain: string, host: string, port: number): Detection =>
  inZone(host, domain)
    ? { kind: "server", provider: "other", host, port }
    : { kind: "named", service: "sieve", host, port };

function imapFromSrv(srv: readonly SrvRecord[], domain: string): Detection | null {
  for (const record of bySrvOrder(srv)) {
    const host = usableHost(record.name);
    if (host !== null && record.port === IMAPS_PORT) {
      return inZone(host, domain)
        ? { kind: "clean", name: null, host, port: IMAPS_PORT, switchOn: false }
        : { kind: "named", service: "imap", host, port: IMAPS_PORT };
    }
  }
  return null;
}

/**
 * The first candidate in the list that answers: side by side, read in order, so one that is known stops the ones behind it and the
 * click waits for a filtered port only in front of it.
 */
async function firstAnswering<T extends { readonly host: string; readonly port: number }>(
  candidates: readonly T[],
  tools: DetectTools,
): Promise<T | undefined> {
  const stop = new AbortController();
  const answers = candidates.map(({ host, port }) =>
    tools.probe(host, port, stop.signal).catch(() => false),
  );
  try {
    for (const [index, answer] of answers.entries()) {
      if (await answer) return candidates[index];
    }
    return undefined;
  } finally {
    stop.abort();
  }
}

/**
 * Who runs a mail domain (the form's own check of the address comes first). A domain Senderban knows costs nothing; otherwise the
 * MX record picks from a fixed table, and only a mail host the table does not know is asked what it is. The three queries go out
 * side by side, but the MX answer alone can end it; the live tools end the rest at one deadline.
 */
export async function detectProvider(
  domain: string,
  tools: DetectTools,
  report?: (facts: DetectFacts) => void,
): Promise<Detection> {
  const known = DOMAIN_ANSWERS.get(domain);
  if (known !== undefined) return known;
  if (!isPublicHostName(domain)) return { kind: "unknown" };

  const mxAnswer = asked(tools.findMx(domain));
  const sieveAnswered = asked(tools.findSrv(`_sieve._tcp.${domain}`));
  const imapsAnswered = asked(tools.findSrv(`_imaps._tcp.${domain}`));
  const mx = await mxAnswer;
  const facts = { records: mx.records.length, dnsError: mx.code };
  const done = (probes: number, detection: Detection): Detection => {
    report?.({ ...facts, probes });
    return detection;
  };

  if (isNullMx(mx.records)) return done(0, { kind: "no-mail" });
  const primary = primaryHosts(mx.records);
  const provider = agreedProvider(primary);
  if (provider !== null) return done(0, provider);

  const [sieve, imaps] = await Promise.all([sieveAnswered, imapsAnswered]);
  const nothingListed = sieve.records.length === 0 && imaps.records.length === 0;
  // ENOTFOUND is the resolver's no; ENODATA a domain with no MX, which may still name its servers. Anything else: no answer at all.
  if (nothingListed && mx.code === "ENOTFOUND") return done(0, { kind: "no-domain" });
  if (nothingListed && mx.code !== null && mx.code !== "ENODATA") {
    return done(0, { kind: "dns-failed" });
  }

  const candidates = sieveCandidates(sieve.records, primary, domain);
  const found = await firstAnswering(candidates, tools);
  if (found !== undefined) {
    return done(candidates.length, sieveAnswer(domain, found.host, found.port));
  }
  return done(candidates.length, imapFromSrv(imaps.records, domain) ?? { kind: "unknown" });
}
