import { lookup as dnsLookup, promises as dns } from "node:dns";
import { BlockList, type LookupFunction } from "node:net";
import { sieveFit } from "../sieve/adapter.js";
import { probeManageSieve } from "../sieve/managesieve.js";
import { detectProvider, type DetectFacts, type DetectTools } from "./detect.js";
import type { Detection } from "./providers.js";

/** Unit: milliseconds. One click waits this long at most, and every query and socket ends with it. */
export const DETECT_DEADLINE_MS = 10_000;
/** Unit: milliseconds, and tries per name server: one dead server costs about 6 s (measured 2026-11-01); two or more meet the deadline. */
const DNS_QUERY = { timeoutMs: 2_000, tries: 2 } as const;
/**
 * Unit: milliseconds, for a whole probe. Real ManageSieve servers answered in 294 to 1,229 ms (five, 2026-11-01); a port behind a
 * firewall never answers, and most mail hosts have one, so waiting the full deadline would be the usual case.
 */
export const DETECT_PROBE_MS = 5_000;

/**
 * Addresses no public mail server has: RFC 1918, 6598, 6890, 3927, 4193, 4291, the multicast and reserved ranges, and the IPv6 forms
 * that carry an IPv4 address to a translator (RFC 6052, 8215, 3056, 4380, 6145). The documentation ranges stay open: nothing routes them.
 */
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
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
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

/** What is used of Node's resolver; only a fake in a test replaces it. */
export type DetectResolver = Pick<dns.Resolver, "resolveMx" | "resolveSrv" | "cancel">;

/** Plain DNS to the servers the system lists, and to no service of ours. Not `dns.lookup`: that one cannot ask for an MX record. */
const systemResolver = (): DetectResolver =>
  new dns.Resolver({ timeout: DNS_QUERY.timeoutMs, tries: DNS_QUERY.tries });

function liveTools(resolver: DetectResolver, deadline: AbortSignal): DetectTools {
  return {
    findMx: (domain) => resolver.resolveMx(domain),
    findSrv: (name) => resolver.resolveSrv(name),
    probe: async (host, port, stop) => {
      const server = await probeManageSieve({
        host,
        port,
        signal: AbortSignal.any([deadline, stop, AbortSignal.timeout(DETECT_PROBE_MS)]),
        timeoutMs: DETECT_PROBE_MS,
        lookup: publicAddressLookup,
      });
      return server.plain && sieveFit(server.extensions, []) === "ok";
    },
  };
}

/** One detection under DETECT_DEADLINE_MS. `signal`: the person gave up (the window closed). */
export async function detectMailProvider(
  domain: string,
  signal: AbortSignal,
  report?: (facts: DetectFacts) => void,
  resolver: DetectResolver = systemResolver(),
): Promise<Detection> {
  if (signal.aborted) return { kind: "dns-failed" };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(DETECT_DEADLINE_MS)]);
  const cancel = (): void => {
    resolver.cancel();
  };
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    return await detectProvider(domain, liveTools(resolver, deadline), report);
  } finally {
    deadline.removeEventListener("abort", cancel);
    // Queries the answer did not need.
    cancel();
  }
}
