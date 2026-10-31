/** Support levels from the architecture notes (K4). */
export const SUPPORT_LEVELS = [
  "native-rule",
  "sieve",
  "panel",
  "imap-clean",
  "sidecar",
  "unavailable",
] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

/**
 * `documented` = read in official docs only; `measured` = exercised against a real account; `dovecot` = the same code path
 * measured on a local Dovecot + Pigeonhole, never on the provider's own servers.
 */
export type Evidence = "documented" | "measured" | "dovecot";

export interface ProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly level: SupportLevel;
  readonly evidence: Evidence;
  readonly release: "v0.1" | "v0.2" | "later";
}

// Single source for the runtime and the README support table. "measured" only where the adapter
// itself ran against a live account (MXroute: install, in-place update, read-back, uninstall).
export const PROVIDERS: readonly ProviderEntry[] = [
  { id: "mxroute", name: "MXroute", level: "sieve", evidence: "measured", release: "v0.1" },
  {
    id: "gmail",
    name: "Gmail / Google Workspace",
    level: "native-rule",
    evidence: "documented",
    release: "v0.1",
  },
  {
    id: "migadu",
    name: "Migadu",
    level: "sieve",
    evidence: "dovecot",
    release: "v0.2",
  },
  {
    id: "mailbox-org",
    name: "mailbox.org",
    level: "sieve",
    evidence: "dovecot",
    release: "v0.2",
  },
  {
    id: "purelymail",
    name: "Purelymail",
    level: "sieve",
    evidence: "dovecot",
    release: "v0.2",
  },
  {
    id: "managesieve",
    name: "Other ManageSieve server",
    level: "sieve",
    evidence: "dovecot",
    release: "v0.2",
  },
  {
    id: "outlook",
    name: "Outlook.com / Microsoft 365",
    level: "native-rule",
    evidence: "documented",
    release: "v0.2",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    level: "imap-clean",
    evidence: "documented",
    release: "v0.2",
  },
  { id: "yahoo", name: "Yahoo Mail", level: "imap-clean", evidence: "documented", release: "v0.2" },
  { id: "aol", name: "AOL Mail", level: "imap-clean", evidence: "documented", release: "v0.2" },
  { id: "gmx", name: "GMX / Web.de", level: "imap-clean", evidence: "documented", release: "v0.2" },
  { id: "proton", name: "Proton Mail", level: "sidecar", evidence: "documented", release: "later" },
];
