import type { BlockEntry, Blocklist, MatchKind } from "./blocklist.js";

export const CAPABILITIES = [
  "serverBlock",
  "retroClean",
  "watch",
  "unsubscribe",
  "quota",
  "exactAddress",
  "exactDomain",
  "subdomains",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Capabilities = Readonly<Record<Capability, boolean>>;

export const ADAPTER_ERROR_CODES = [
  "CAPABILITY_NOT_SUPPORTED",
  "AUTH_REQUIRED",
  "QUOTA_EXCEEDED",
  "REMOTE_CHANGED",
  "REJECTED",
  "TRANSIENT",
] as const;
export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

/** Unsupported operations fail loudly; an adapter never emulates a match kind it cannot guarantee. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/** Provider state the core never inspects (Gmail filter ids, Sieve script version, ...). */
export interface OpaqueState {
  readonly adapterId: string;
  readonly data: unknown;
}

export interface PlannedChange {
  readonly kind: "create" | "remove";
  readonly entry: BlockEntry;
  readonly match: MatchKind;
}

/** What `apply` would write; also the dry-run output. */
export interface Plan {
  readonly accountId: string;
  readonly changes: readonly PlannedChange[];
  readonly basedOn: OpaqueState;
}

export interface ApplyResult {
  readonly applied: number;
  readonly failed: readonly { readonly entryId: string; readonly error: AdapterError }[];
  readonly state: OpaqueState;
}

/** One thing verify() looked at on the provider, and what it found. */
export interface DriftCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Result of reading the provider back: the "it is really blocked" evidence the UI shows, and the
 * signal that the remote rule was edited or deleted by someone else since we last wrote it.
 */
export interface Drift {
  readonly drifted: boolean;
  readonly detail: string;
  /** ISO 8601 time of the read-back. */
  readonly checkedAt: string;
  readonly checks: readonly DriftCheck[];
}

/**
 * The core knows nothing about providers: it only calls this contract. Every adapter touches
 * only rules it created itself (ownership marker) and never the user's own rules.
 */
export interface BlockAdapter {
  readonly id: string;
  capabilities(): Capabilities;
  plan(list: Blocklist, state: OpaqueState): Promise<Plan>;
  apply(plan: Plan): Promise<ApplyResult>;
  verify(state: OpaqueState): Promise<Drift>;
  cleanup?(selector: { readonly address: string }): Promise<ApplyResult>;
}
