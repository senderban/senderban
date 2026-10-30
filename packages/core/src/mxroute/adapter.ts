import { z } from "zod";
import {
  AdapterError,
  type ApplyResult,
  type BlockAdapter,
  type Capabilities,
  type Drift,
  type OpaqueState,
  type Plan,
  type PlannedChange,
} from "../adapter.js";
import { validateDomain } from "../address.js";
import {
  BlockEntrySchema,
  BlocklistSchema,
  MAX_ENTRIES,
  checkEntry,
  type BlockEntry,
  type Blocklist,
} from "../blocklist.js";
import {
  EntryRefusedError,
  canRefuseAtServer,
  RateLimitedError,
  type MxrouteClient,
} from "./client.js";

export const MXROUTE_ADAPTER_ID = "mxroute";

const LANE_SUFFIX = ".mxroute";
/** The engine lane of an account's MXroute blacklist: its own queue, journal and state next to the account's Sieve lane. */
export function mxrouteLaneId(accountId: string): string {
  // The engine caps lane ids at 64 characters (ACCOUNT_ID); a long account id is cut so the suffix always fits.
  return accountId.length + LANE_SUFFIX.length <= 64
    ? `${accountId}${LANE_SUFFIX}`
    : `${accountId.slice(0, 64 - LANE_SUFFIX.length)}${LANE_SUFFIX}`;
}

/**
 * Changes sent in one round, at most. MXroute allows 60 writes a minute per key (read from the
 * `x-ratelimit-limit` answer header, 2026-10-25); half of that leaves room for an Unblock pressed in the same
 * minute. A bigger backlog (right after the person turns this on) goes out over the next rounds.
 */
export const MXROUTE_MAX_CHANGES_PER_ROUND = 30;
/**
 * Time after which a round stops starting new changes. Unit: milliseconds. The engine abandons a round at
 * 60 s and drops what it returned. After the budget come at most one more request (15 s) and the read-back of
 * removals (15 s), so 20 + 15 + 15 = 50 s leaves a margin and keeps the progress made: a slow API cannot make
 * every round start over from the same first changes.
 */
export const MXROUTE_ROUND_BUDGET_MS = 20_000;

const StateSchema = z.strictObject({
  /** The mail domain whose blacklist this lane writes to. */
  domain: z.string().min(3).max(253),
  /** What we put on the blacklist (addresses only), as of the last successful round. */
  applied: z.array(BlockEntrySchema).max(MAX_ENTRIES),
  /** Addresses MXroute refused for good (400/422): left out of the plan so one of them cannot stop the rest. */
  rejected: z.array(z.string().max(254)).max(MAX_ENTRIES).default([]),
});
type MxrouteState = z.infer<typeof StateSchema>;

export function initialMxrouteState(domain: string): OpaqueState {
  const error = validateDomain(domain);
  if (error !== null) throw new Error("invalid mail domain for the MXroute blacklist");
  const data: MxrouteState = { domain, applied: [], rejected: [] };
  return { adapterId: MXROUTE_ADAPTER_ID, data };
}

/** True when the lane put this address on the blacklist. A state that cannot be read counts as true: it may have. */
export function mxrouteStateHolds(state: OpaqueState, value: string): boolean {
  try {
    return parseState(state).applied.some((e) => e.value === value);
  } catch {
    return true;
  }
}

function parseState(state: OpaqueState): MxrouteState {
  if (state.adapterId !== MXROUTE_ADAPTER_ID) {
    throw new AdapterError("REJECTED", "state belongs to another adapter");
  }
  const parsed = StateSchema.safeParse(state.data);
  if (!parsed.success) throw new AdapterError("REJECTED", "mxroute state failed validation");
  return parsed.data;
}

const CAPABILITIES: Capabilities = {
  serverBlock: true,
  retroClean: false,
  watch: false,
  unsubscribe: false,
  quota: false,
  exactAddress: true,
  // Domain entries (`@domain`, `*@domain`) are in use on real blacklists but their reach (subdomains?) is not
  // measured, so they are not mirrored: the Sieve lane still blocks them.
  exactDomain: false,
  subdomains: false,
};

/**
 * The entries this lane mirrors: single addresses the person chose to refuse at the server (`reject`) that the
 * blacklist API accepts. A Junk or Trash choice never reaches MXroute; everything else stays with Sieve.
 */
function mirrored(list: Blocklist): Map<string, BlockEntry> {
  const out = new Map<string, BlockEntry>();
  for (const raw of list) {
    const checked = checkEntry(raw);
    if (!checked.ok || checked.entry.match !== "exactAddress") continue;
    if (checked.entry.action !== "reject") continue;
    // Also leaves out `*` (legal in a mail address, a wildcard on the blacklist: `*@gmail.com` would refuse every Gmail sender).
    if (!canRefuseAtServer(checked.entry.value)) continue;
    out.set(checked.entry.value, checked.entry);
  }
  return out;
}

export interface MxrouteAdapterOptions {
  /** The engine lane this adapter serves; it names the journal rows. */
  readonly accountId: string;
  readonly client: MxrouteClient;
  /**
   * False while the person has the blacklist switched off: the lane then only takes back what it put there
   * (nothing, and no request, when it never put anything), so switching off cannot leave an address rejected
   * after it was unblocked. Default true.
   */
  readonly mirror?: boolean;
  readonly roundBudgetMs?: number;
  /** Injectable clock for tests; milliseconds. */
  readonly now?: () => number;
}

/**
 * Mirrors the block list's `reject` addresses onto the MXroute spam blacklist, so the server refuses the mail
 * at the door (measured 2026-10-25: `550 High scoring spam message has been dropped`). The blacklist belongs
 * to the whole mail domain, so the address is refused for every mailbox on it. An address that was already
 * on the blacklist counts as added (409) and is taken off again on Unblock; any other entry of the person
 * is never touched.
 */
export class MxrouteAdapter implements BlockAdapter {
  readonly id = MXROUTE_ADAPTER_ID;
  readonly #client: MxrouteClient;
  readonly #accountId: string;
  readonly #mirror: boolean;
  readonly #budgetMs: number;
  readonly #now: () => number;
  /** The account that held the key was removed: rounds have nothing to do for the rest of the session. */
  #retired = false;

  constructor(options: MxrouteAdapterOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#mirror = options.mirror ?? true;
    this.#budgetMs = options.roundBudgetMs ?? MXROUTE_ROUND_BUDGET_MS;
    this.#now = options.now ?? Date.now;
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /** The lane stays in the engine, which cannot drop one, but its key must not be used again. */
  retire(): void {
    this.#retired = true;
  }

  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    if (this.#retired) {
      return Promise.resolve({ accountId: this.#accountId, changes: [], basedOn: state });
    }
    try {
      const current = parseState(state);
      const refused = new Set(current.rejected);
      const wanted = new Map(
        this.#mirror ? [...mirrored(list)].filter(([value]) => !refused.has(value)) : [],
      );
      const have = new Map(current.applied.map((e) => [e.value, e]));
      const all: PlannedChange[] = [];
      for (const [value, entry] of have) {
        if (!wanted.has(value)) all.push({ kind: "remove", entry, match: entry.match });
      }
      for (const [value, entry] of wanted) {
        if (!have.has(value)) all.push({ kind: "create", entry, match: entry.match });
      }
      // Removals first (an Unblock is the urgent one), then at most one round's worth. The journal keeps the plan
      // of every round, so a backlog of thousands must not be written out each time: the rest is `deferred`.
      const changes = all.slice(0, MXROUTE_MAX_CHANGES_PER_ROUND);
      const deferred = all.length - changes.length;
      return Promise.resolve({
        accountId: this.#accountId,
        changes,
        basedOn: state,
        ...(deferred > 0 ? { deferred } : {}),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * One request per change, removals first (an Unblock is the urgent one). Every request is idempotent
   * (409 and 404 count as done), so a round that dies half way is simply run again. A round stops starting
   * changes after MXROUTE_ROUND_BUDGET_MS and returns the progress made.
   */
  async apply(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    const state = parseState(plan.basedOn);
    const ordered = [
      ...plan.changes.filter((c) => c.kind === "remove"),
      ...plan.changes.filter((c) => c.kind === "create"),
    ];
    const todo = ordered.slice(0, MXROUTE_MAX_CHANGES_PER_ROUND);
    const started = this.#now();
    let applied: BlockEntry[] = [...state.applied];
    const refused: string[] = [...state.rejected];
    const refusedNow: BlockEntry[] = [];
    const removedNow: BlockEntry[] = [];
    let sent = 0;
    let handled = 0;
    let stopped: AdapterError | null = null;

    for (const [index, change] of todo.entries()) {
      if (this.#retired) break;
      if (handled > 0 && this.#now() - started >= this.#budgetMs) break;
      try {
        signal?.throwIfAborted();
        if (change.kind === "remove") {
          await this.#client.remove(state.domain, change.entry.value, signal);
          applied = applied.filter((e) => e.value !== change.entry.value);
          removedNow.push(change.entry);
        } else {
          await this.#client.add(state.domain, change.entry.value, signal);
          applied = [...applied, change.entry];
        }
        sent += 1;
        handled = index + 1;
      } catch (error) {
        if (error instanceof EntryRefusedError && change.kind === "create") {
          // MXroute refuses this one address for good: remember it and carry on with the others.
          refused.push(change.entry.value);
          refusedNow.push(change.entry);
          handled = index + 1;
          continue;
        }
        const adapterError =
          error instanceof AdapterError
            ? error
            : new AdapterError("TRANSIENT", "MXroute call failed");
        // Nothing handled yet: the whole round failed for this reason. Otherwise keep the progress made.
        if (handled === 0) throw adapterError;
        // The provider asked to slow down: the rest is simply later, not a failure.
        if (!(error instanceof RateLimitedError)) stopped = adapterError;
        break;
      }
    }

    // Every address of the round refused: that points at the lane (the key's rights, the domain), not at the
    // addresses, so nothing is recorded as refused and the round fails.
    if (sent === 0 && refusedNow.length > 0 && refusedNow.length === handled) {
      throw new AdapterError("REJECTED", "MXroute refused every address of this round");
    }
    // A removal counts once the entry is gone from the list: a 404 can also mean MXroute spells it differently.
    const unconfirmed = await this.#stillListed(state.domain, removedNow, signal);
    applied = [...applied, ...unconfirmed];

    const left = ordered.slice(handled);
    const next: MxrouteState = {
      ...state,
      applied: BlocklistSchema.parse(applied),
      rejected: refused.slice(-MAX_ENTRIES),
    };
    return {
      applied: sent - unconfirmed.length,
      failed: [
        ...unconfirmed.map((e) => ({
          entryId: e.id,
          error: new AdapterError("TRANSIENT", "still on the MXroute blacklist"),
        })),
        ...refusedNow.map((e) => ({
          entryId: e.id,
          error: new AdapterError("REJECTED", "MXroute does not accept this address"),
        })),
        // After an error the rest is reported as failed (the engine tries again later). Without one (time budget,
        // rate limit) it is only deferred.
        ...left.flatMap((c) => (stopped === null ? [] : [{ entryId: c.entry.id, error: stopped }])),
      ],
      ...(stopped === null && left.length > 0 ? { deferred: left.length } : {}),
      state: { adapterId: MXROUTE_ADAPTER_ID, data: next },
    };
  }

  /** Of the entries just removed, the ones the blacklist still lists (all of them when it cannot be read). */
  async #stillListed(
    domain: string,
    removed: readonly BlockEntry[],
    signal: AbortSignal | undefined,
  ): Promise<BlockEntry[]> {
    if (removed.length === 0) return [];
    try {
      const listed = new Set(await this.#client.list(domain, signal));
      return removed.filter((e) => listed.has(e.value));
    } catch {
      return [...removed];
    }
  }

  async verify(state: OpaqueState, signal?: AbortSignal): Promise<Drift> {
    // No round runs for a retired lane, so a clean read here would confirm a change nothing wrote; and the key is not used again.
    if (this.#retired) throw new AdapterError("TRANSIENT", "the account was removed");
    const current = parseState(state);
    // Nothing of ours is on the blacklist (never switched on, or taken back): there is nothing to read back.
    if (current.applied.length === 0) {
      return {
        drifted: false,
        detail: "nothing mirrored",
        checkedAt: new Date().toISOString(),
        checks: [],
      };
    }
    const listed = new Set(await this.#client.list(current.domain, signal));
    const missing = current.applied.filter((e) => !listed.has(e.value));
    return {
      drifted: missing.length > 0,
      detail:
        missing.length === 0
          ? "blacklist entries in place"
          : `${String(missing.length)} blacklist entr${missing.length === 1 ? "y" : "ies"} missing`,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          name: "blacklist-entries",
          ok: missing.length === 0,
          detail: `${String(current.applied.length - missing.length)} of ${String(current.applied.length)} present`,
        },
      ],
    };
  }
}
