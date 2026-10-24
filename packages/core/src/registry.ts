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

/** `documented` = read in official docs only; `measured` = exercised against a real account. */
export type Evidence = "documented" | "measured";

export interface ProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly level: SupportLevel;
  readonly evidence: Evidence;
  readonly release: "v0.1" | "v0.2" | "later";
}

// Single source for the runtime and the README support table. Nothing here is "measured" yet:
// no provider path has been run against a live account.
export const PROVIDERS: readonly ProviderEntry[] = [
  { id: "mxroute", name: "MXroute", level: "sieve", evidence: "documented", release: "v0.1" },
  {
    id: "gmail",
    name: "Gmail / Google Workspace",
    level: "native-rule",
    evidence: "documented",
    release: "v0.1",
  },
  {
    id: "outlook",
    name: "Outlook.com / Microsoft 365",
    level: "native-rule",
    evidence: "documented",
    release: "v0.2",
  },
];
