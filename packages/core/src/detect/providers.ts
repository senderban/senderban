import { MANAGESIEVE_PORT, type PresetServer } from "../mail-server.js";

/** Implicit TLS (RFC 8314 §5.1): the only IMAP port a suggestion carries. */
export const IMAPS_PORT = 993;

/**
 * What an address's mail domain says about who runs it. A suggestion only: it fills the add form, and the person's Add and the
 * main process's dialog stay in front of any password. `server` and a nameless `clean` carry a name read from DNS, the rest
 * names from this file.
 */
export type Detection =
  | { readonly kind: "gmail" }
  | { readonly kind: "microsoft" }
  | { readonly kind: "preset"; readonly provider: PresetServer }
  | {
      readonly kind: "server";
      readonly provider: "mxroute" | "other";
      readonly host: string;
      readonly port: number;
    }
  | {
      readonly kind: "clean";
      /** Null when the server came from the domain's own SRV record. */
      readonly name: string | null;
      readonly host: string;
      readonly port: number;
      /** IMAP is off until the person switches it on in the provider's settings. */
      readonly switchOn: boolean;
    }
  | { readonly kind: "unsupported"; readonly name: string }
  /** The domain does not exist, or says it takes no mail (RFC 7505). */
  | { readonly kind: "no-mail" }
  | { readonly kind: "dns-failed" }
  | { readonly kind: "unknown" };

const clean = (name: string, host: string, switchOn = false): Detection => ({
  kind: "clean",
  name,
  host,
  port: IMAPS_PORT,
  switchOn,
});

const GOOGLE: Detection = { kind: "gmail" };
const MICROSOFT: Detection = { kind: "microsoft" };
const ICLOUD = clean("iCloud", "imap.mail.me.com");
const YAHOO = clean("Yahoo", "imap.mail.yahoo.com");
const AOL = clean("AOL", "imap.aol.com");
const GMX_NET = clean("GMX", "imap.gmx.net", true);
const GMX_COM = clean("GMX", "imap.gmx.com", true);
const WEB_DE = clean("WEB.DE", "imap.web.de", true);
const PROTON: Detection = { kind: "unsupported", name: "Proton Mail" };

/** Addresses that need no lookup: the domain is the answer, so no DNS answer can change it. */
export const DOMAIN_ANSWERS: ReadonlyMap<string, Detection> = new Map([
  ["gmail.com", GOOGLE],
  ["googlemail.com", GOOGLE],
  ["outlook.com", MICROSOFT],
  ["hotmail.com", MICROSOFT],
  ["live.com", MICROSOFT],
  ["msn.com", MICROSOFT],
  ["icloud.com", ICLOUD],
  ["me.com", ICLOUD],
  ["mac.com", ICLOUD],
  ["yahoo.com", YAHOO],
  ["ymail.com", YAHOO],
  ["rocketmail.com", YAHOO],
  ["aol.com", AOL],
  ["gmx.net", GMX_NET],
  ["gmx.de", GMX_NET],
  ["gmx.com", GMX_COM],
  ["web.de", WEB_DE],
  ["proton.me", PROTON],
  ["protonmail.com", PROTON],
  ["pm.me", PROTON],
]);

/**
 * Zones of the hosts a provider receives mail on, longest first where one holds another. An MX record chooses one of these
 * answers and writes no server of its own, so a forged record reaches a known provider at worst. Read from public MX records
 * on 2026-11-01 and from Google's and Microsoft's setup pages; IMAP hosts from each provider's help page and from their
 * greetings over verified TLS, without signing in (ADR 0018).
 */
const MX_ZONES: readonly (readonly [zone: string, answer: Detection])[] = [
  ["google.com", GOOGLE],
  ["googlemail.com", GOOGLE],
  ["protection.outlook.com", MICROSOFT],
  ["mx.microsoft", MICROSOFT],
  ["mail.icloud.com", ICLOUD],
  ["am0.yahoodns.net", YAHOO],
  ["gm0.yahoodns.net", AOL],
  ["emig.gmx.net", GMX_NET],
  ["gmx.net", GMX_COM],
  ["web.de", WEB_DE],
  ["protonmail.ch", PROTON],
  ["migadu.com", { kind: "preset", provider: "migadu" }],
  ["mailbox.org", { kind: "preset", provider: "mailbox-org" }],
  ["purelymail.com", { kind: "preset", provider: "purelymail" }],
];

const MXROUTE_ZONE = "mxrouting.net";

const inZone = (host: string, zone: string): boolean => host === zone || host.endsWith(`.${zone}`);

/** MXroute's mail host is the mailbox's server too (measured 2026-10-24); the relay behind it is not. */
function isMxrouteServer(host: string): boolean {
  const name = host.slice(0, -`.${MXROUTE_ZONE}`.length);
  return inZone(host, MXROUTE_ZONE) && /^[a-z0-9-]+$/u.test(name) && !name.endsWith("-relay");
}

/** The provider this mail host belongs to, or null. A zone matches whole labels: `evilgoogle.com` is not `google.com`. */
export function answerForMailHost(host: string): Detection | null {
  const zone = MX_ZONES.find(([name]) => inZone(host, name));
  if (zone !== undefined) return zone[1];
  return isMxrouteServer(host)
    ? { kind: "server", provider: "mxroute", host, port: MANAGESIEVE_PORT }
    : null;
}
