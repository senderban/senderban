import { lookup as dnsLookup, promises as dns } from "node:dns";
import { BlockList, type LookupFunction } from "node:net";
import { sieveFit } from "../sieve/adapter.js";
import { probeManageSieve } from "../sieve/managesieve.js";
import { detectProvider, type DetectFacts, type DetectTools } from "./detect.js";
import type { Detection } from "./providers.js";

/** Unit: milliseconds. One click waits this long at most, and every query and socket ends with it. */
export const DETECT_DEADLINE_MS = 10_000;
/** Unit: milliseconds, and tries (one query, resent once): a dead resolver answers inside the deadline. */
const DNS_QUERY = { timeoutMs: 2_000, tries: 2 } as const;
/**
 * Unit: milliseconds, for a whole probe. Real ManageSieve servers answered in 294 to 1,229 ms (five, 2026-11-01); a port behind a
 * firewall never answers, and most mail hosts have one, so waiting the full deadline would be the usual case.
 */
export const DETECT_PROBE_MS = 5_000;

/** Addresses no public mail server has: RFC 1918, 6598, 6890, 3927, 4193, 4291 and the multicast and reserved ranges. */
const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export const isPublicAddress = (address: string, family: number): boolean =>
  !PRIVATE_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");

/**
 * A DNS answer chooses where the probe connects, so it must not reach the person's own network. The check sits in the socket's one
 * lookup, not before it: a name that answers one thing to a check and another to the connection has no second answer to give.
 */
export const publicAddressLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, "", 0);
      return;
    }
    const open = addresses.filter(({ address, family }) => isPublicAddress(address, family));
    const first = open[0];
    if (first === undefined) {
      callback(Object.assign(new Error("no public address"), { code: "ENOTFOUND" }), "", 0);
    } else if (options.all === true) {
      callback(null, open);
    } else {
      callback(null, first.address, first.family);
    }
  });
};

/** The system's own resolver: the domain goes where the person's other lookups go, and to no service of ours. */
function liveTools(signal: AbortSignal): DetectTools {
  const resolver = new dns.Resolver({ timeout: DNS_QUERY.timeoutMs, tries: DNS_QUERY.tries });
  signal.addEventListener(
    "abort",
    () => {
      resolver.cancel();
    },
    { once: true },
  );
  return {
    findMx: (domain) => resolver.resolveMx(domain),
    findSrv: (name) => resolver.resolveSrv(name),
    probe: async (host, port) => {
      const server = await probeManageSieve({
        host,
        port,
        signal: AbortSignal.any([signal, AbortSignal.timeout(DETECT_PROBE_MS)]),
        timeoutMs: DETECT_PROBE_MS,
        lookup: publicAddressLookup,
      });
      return server.plain && sieveFit(server.extensions, []) === "ok";
    },
  };
}

/** One detection under DETECT_DEADLINE_MS. `signal`: the person gave up (the window closed). */
export function detectMailProvider(
  domain: string,
  signal: AbortSignal,
  report?: (facts: DetectFacts) => void,
): Promise<Detection> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(DETECT_DEADLINE_MS)]);
  return detectProvider(domain, liveTools(deadline), report);
}
