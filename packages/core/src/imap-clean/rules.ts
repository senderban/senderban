import { folderAction } from "../blocklist.js";
import type { Blocklist } from "../blocklist.js";

export type CleanTarget = "junk" | "trash";

/** Where this sender's mail goes, or null when no rule reaches it. */
export interface CleanRules {
  readonly size: number;
  targetFor(address: string): CleanTarget | null;
}

/** Junk wins, as it does on Sieve, where Junk rules are written first and each one stops. */
function better(a: CleanTarget | null, b: CleanTarget | undefined): CleanTarget | null {
  if (a === "junk" || b === "junk") return "junk";
  return b ?? a;
}

function put(map: Map<string, CleanTarget>, key: string, target: CleanTarget): void {
  map.set(key, better(map.get(key) ?? null, target) ?? target);
}

/**
 * The list as three lookups, built once per round instead of walking 5,000 entries per mail. A lookup costs one read per label of
 * the sender's domain, at most 127 (RFC 1035: 253 characters). Input is `parseAddress` output: lowercase, punycode, one `@`.
 */
export function compileRules(list: Blocklist): CleanRules {
  const addresses = new Map<string, CleanTarget>();
  const domains = new Map<string, CleanTarget>();
  const trees = new Map<string, CleanTarget>();
  for (const entry of list) {
    const target = folderAction(entry.action);
    if (entry.match === "exactAddress") put(addresses, entry.value, target);
    else if (entry.match === "exactDomain") put(domains, entry.value, target);
    else put(trees, entry.value, target);
  }
  return {
    size: list.length,
    targetFor(address) {
      const domain = address.slice(address.lastIndexOf("@") + 1);
      let found = better(addresses.get(address) ?? null, domains.get(domain));
      for (let at = -1; found !== "junk"; at = domain.indexOf(".", at + 1)) {
        found = better(found, trees.get(domain.slice(at + 1)));
        if (domain.indexOf(".", at + 1) === -1) break;
      }
      return found;
    },
  };
}
