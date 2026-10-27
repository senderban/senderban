import { createHash } from "node:crypto";
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
import { MAX_ENTRIES, checkEntry } from "../blocklist.js";
import type { BlockEntry, Blocklist } from "../blocklist.js";
import {
  FilterExistsError,
  GMAIL_FILTER_ID,
  GMAIL_FILTER_LABEL,
  type GmailFilter,
  type GmailFilterClient,
} from "./client.js";
import { GmailBudgetError } from "./budget.js";
import { GMAIL_ADDRESSES_PER_FILTER, compileFromQuery, isGmailMirrorable } from "./query.js";

export const GMAIL_ADAPTER_ID = "gmail";

const LANE_SUFFIX = ".gmail";
/** The engine lane of a Gmail account's filters: its own queue, journal and state. */
export function gmailLaneId(accountId: string): string {
  // The engine caps lane ids at 64 characters (ACCOUNT_ID); a long account id is cut so the suffix always fits.
  return accountId.length + LANE_SUFFIX.length <= 64
    ? `${accountId}${LANE_SUFFIX}`
    : `${accountId.slice(0, 64 - LANE_SUFFIX.length)}${LANE_SUFFIX}`;
}

/**
 * Filters rewritten in one round, at most. Unit: filters. A rewrite is one `create` and one `delete` (5 + 5 quota units),
 * so 10 filters are about 100 units and 20 requests plus the one `list`: far under the 6,000 units a minute Google gives
 * a user, and a backlog (right after the person turns this on) goes out over the next rounds as `deferred`.
 */
export const GMAIL_MAX_REWRITES_PER_ROUND = 10;
/**
 * Time after which a round stops STARTING new rewrites. Unit: milliseconds. It is not the round's limit (that is
 * GMAIL_ROUND_DEADLINE_MS): a rewrite is up to three creates, two recovery reads and three deletes, not one request.
 */
export const GMAIL_ROUND_BUDGET_MS = 20_000;
/**
 * Hard limit of one round. Unit: milliseconds. The engine abandons a round at 60 s (DEFAULT_TIMEOUT_MS) and drops what it
 * returned; at this limit every call still in flight is cut off, so the round ends by itself before the engine does, and
 * what the `checkpoint` saved is found again by the next round. 15 s of margin under the engine's 60 s.
 */
export const GMAIL_ROUND_DEADLINE_MS = 45_000;
/** The same limit for removing the lane's filters (`uninstall`), which a person starts. Unit: milliseconds. */
export const GMAIL_UNINSTALL_DEADLINE_MS = 120_000;
/** Retries of a write that answered 5xx or timed out, at most (ADR 0009 "Budget lines"). Unit: retries; so at most 3 attempts. */
export const GMAIL_WRITE_RETRIES = 2;
/** Wait before the n-th retry is `n` times this. Unit: milliseconds. */
export const GMAIL_RETRY_DELAY_MS = 1_000;
/**
 * Longest `suspend` waits for a running round. Unit: milliseconds. A round ends by its own deadline (GMAIL_ROUND_DEADLINE_MS);
 * 15 s more are for the answer to be handled. Past it the removal answers "filters left" instead of waiting for ever.
 */
export const GMAIL_SUSPEND_WAIT_MS = GMAIL_ROUND_DEADLINE_MS + 15_000;
/** Filters this lane holds, at most. Unit: filters. 5,000 entries (MAX_ENTRIES) at 50 a filter is 100; twice that leaves room for holes after removals. */
export const GMAIL_MAX_FILTERS = (MAX_ENTRIES / GMAIL_ADDRESSES_PER_FILTER) * 2;

/**
 * `exactAddress` + Trash only (ADR 0009 points 4 and 6): a Gmail filter cannot add `SPAM`, and domain terms are not
 * declared until the match of `from:` on a domain is measured.
 */
const CAPABILITIES: Capabilities = {
  serverBlock: true,
  retroClean: false,
  watch: false,
  unsubscribe: false,
  quota: false,
  exactAddress: true,
  exactDomain: false,
  subdomains: false,
};

/**
 * What the state keeps of a block: its id and its address, about 75 bytes (a whole entry is about 160). The rest of an
 * entry is always the same for this lane (an exact address, Trash), and a plan rebuilds it.
 */
const Held = z.strictObject({ id: z.uuid(), value: z.string().min(3).max(254) });
type Held = z.infer<typeof Held>;
const toHeld = (entry: BlockEntry): Held => ({ id: entry.id, value: entry.value });
const toEntry = (held: Held): BlockEntry => ({
  id: held.id,
  match: "exactAddress",
  value: held.value,
  action: "trash",
  createdAt: "1970-01-01T00:00:00.000Z",
});

const FilterRecord = z.strictObject({
  id: z.string().regex(GMAIL_FILTER_ID),
  /** What this filter blocks, in the order of its query. The query is derived from these, never stored. */
  entries: z.array(Held).min(1).max(GMAIL_ADDRESSES_PER_FILTER),
});
type FilterRecord = z.infer<typeof FilterRecord>;

/** An address that an identical filter the person has already covers, and the id of that filter. */
const Refusal = z.strictObject({
  value: z.string().min(3).max(254),
  by: z.string().regex(GMAIL_FILTER_ID),
  /** The block-list entry it was for, so an Unblock of it can be answered; absent in a state written before this existed. */
  id: z.uuid().optional(),
});
type Refusal = z.infer<typeof Refusal>;

/** A create that was about to be sent: written to the state first, so a filter Gmail made but never answered for is found again. */
const Intent = z.strictObject({
  entries: z.array(Held).min(1).max(GMAIL_ADDRESSES_PER_FILTER),
  /** The filter this one replaces, or null for a new filter. */
  replaces: z.string().regex(GMAIL_FILTER_ID).nullable(),
});
type Intent = z.infer<typeof Intent>;

const StateSchema = z
  .strictObject({
    filters: z.array(FilterRecord).max(GMAIL_MAX_FILTERS),
    /** Filters a newer version replaced but that could not be deleted yet: the next round deletes them first. */
    stale: z.array(FilterRecord).max(GMAIL_MAX_FILTERS),
    /** Creates not yet confirmed (a round that died between the request and the answer). One round has at most 10 at a time. */
    intent: z.array(Intent).max(GMAIL_MAX_REWRITES_PER_ROUND * 2),
    /**
     * Addresses an identical filter that Senderban did not write already covers: left out of the plan so one of them cannot
     * stop the rest (the same idea as MXroute's `rejected`). They are blocked, by that filter, but are not ours to remove.
     * A refusal ends when that filter is gone: the next round drops it and the plan puts the address back.
     */
    refused: z.array(Refusal).max(MAX_ENTRIES),
  })
  .superRefine((state, ctx) => {
    const addresses = new Set<string>();
    const ids = new Set<string>();
    for (const record of [...state.filters, ...state.stale]) {
      if (ids.has(record.id)) ctx.addIssue({ code: "custom", message: "duplicate filter id" });
      ids.add(record.id);
    }
    for (const record of state.filters) {
      for (const entry of record.entries) {
        if (!isGmailMirrorable(entry.value) || addresses.has(entry.value)) {
          ctx.addIssue({ code: "custom", message: "address not allowed or repeated" });
        }
        addresses.add(entry.value);
      }
    }
    for (const record of [...state.stale, ...state.intent]) {
      for (const entry of record.entries) {
        if (!isGmailMirrorable(entry.value))
          ctx.addIssue({ code: "custom", message: "address not allowed" });
      }
    }
  });
type GmailState = z.infer<typeof StateSchema>;

export function initialGmailState(): OpaqueState {
  const data: GmailState = { filters: [], stale: [], intent: [], refused: [] };
  return { adapterId: GMAIL_ADAPTER_ID, data };
}

/**
 * Whether the state records anything in Gmail that Senderban wrote or may have written: a filter, one left to delete, or a
 * create whose answer never came back. Used before an account is removed: only an empty state means nothing is left to delete.
 * A state that cannot be read counts as holding filters (nothing is assumed gone).
 */
export function gmailStateHoldsFilters(state: OpaqueState): boolean {
  const parsed = StateSchema.safeParse(state.data);
  if (state.adapterId !== GMAIL_ADAPTER_ID || !parsed.success) return true;
  const { filters, stale, intent } = parsed.data;
  return filters.length + stale.length + intent.length > 0;
}

function parseState(state: OpaqueState): GmailState {
  if (state.adapterId !== GMAIL_ADAPTER_ID) {
    throw new AdapterError("REJECTED", "state belongs to another adapter");
  }
  const parsed = StateSchema.safeParse(state.data);
  if (!parsed.success) throw new AdapterError("REJECTED", "gmail state failed validation");
  return parsed.data;
}

const queryOf = (entries: readonly Held[]): string => compileFromQuery(entries.map((e) => e.value));

const sameKeys = (value: Record<string, unknown> | undefined, keys: readonly string[]): boolean =>
  value !== undefined && Object.keys(value).length === keys.length && keys.every((k) => k in value);

/**
 * Ownership read-back (ADR 0009 point 4): a remote filter is ours only when its criteria are exactly `{ query }` with the
 * query we compiled and its action exactly `{ addLabelIds: ["TRASH"] }`: no other key, nothing the person added.
 */
function matchesQuery(remote: GmailFilter, query: string): boolean {
  const labels = remote.action?.addLabelIds;
  return (
    sameKeys(remote.criteria, ["query"]) &&
    remote.criteria?.query === query &&
    sameKeys(remote.action, ["addLabelIds"]) &&
    labels?.length === 1 &&
    labels[0] === GMAIL_FILTER_LABEL
  );
}
const matches = (remote: GmailFilter, record: FilterRecord): boolean =>
  matchesQuery(remote, queryOf(record.entries));

/**
 * The entries this lane mirrors: single addresses the person blocked with Trash that the query contract lets through.
 * Anything else is left to the other lanes.
 */
function mirrored(
  list: Blocklist,
  exclude?: (address: string) => boolean,
): Map<string, BlockEntry> {
  const out = new Map<string, BlockEntry>();
  for (const raw of list) {
    // The cheap test first: a Junk or a domain entry is nobody's business here, and a list holds thousands.
    if (raw.match !== "exactAddress" || raw.action !== "trash") continue;
    const checked = checkEntry(raw);
    if (!checked.ok) continue;
    const { entry } = checked;
    if (entry.match !== "exactAddress" || entry.action !== "trash") continue;
    if (!isGmailMirrorable(entry.value)) continue;
    if (exclude?.(entry.value) === true) continue;
    out.set(entry.value, entry);
  }
  return out;
}

/**
 * Trash blocks of single addresses that the Gmail query contract refuses (a local part with `-`, `{}`, `*` or other
 * symbols at an edge or inside). They are never written and never dropped silently: the result toast says "not blocked
 * on Gmail" for exactly these (ADR 0009 point 4, contract 2).
 */
export function gmailUnsupported(list: Blocklist): BlockEntry[] {
  const out: BlockEntry[] = [];
  for (const raw of list) {
    const checked = checkEntry(raw);
    if (!checked.ok) continue;
    const { entry } = checked;
    if (
      entry.match === "exactAddress" &&
      entry.action === "trash" &&
      !isGmailMirrorable(entry.value)
    ) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * One filter rewrite: Gmail has no update, so a changed filter is a new filter (`next`) created first and the old one
 * (`old`) deleted after, which never leaves an address unblocked in between. `takes` are the plan changes it carries out.
 */
interface Rewrite {
  readonly old: FilterRecord | null;
  readonly next: readonly Held[];
  readonly takes: readonly PlannedChange[];
}

/**
 * The marked `remove` change that carries "clean up" into a round when nothing else is planned. A real entry never has
 * this id: ids are made with `randomUUID`, and the address below is a placeholder, never a person's.
 */
export const GMAIL_CLEANUP_ENTRY_ID = "00000000-0000-4000-8000-00000000fff1";
const CLEANUP_ENTRY: BlockEntry = {
  id: GMAIL_CLEANUP_ENTRY_ID,
  match: "exactAddress",
  value: "cleanup@senderban.invalid",
  action: "trash",
  createdAt: "1970-01-01T00:00:00.000Z",
};

const change = (kind: "create" | "remove", entry: BlockEntry): PlannedChange => ({
  kind,
  entry,
  match: entry.match,
});

/**
 * Which filters change, from the filters now and the addresses to take off and put on. Append-only: an address that is
 * already in a filter never moves (so one added address rewrites one filter, never all of them); a new address goes to
 * the first filter with room, then to new filters of GMAIL_ADDRESSES_PER_FILTER. Removals come first (an Unblock is the
 * urgent one). At most `cap` rewrites; the changes of the others are not in `takes` and come back as `left`.
 */
function schedule(
  filters: readonly FilterRecord[],
  removes: readonly Held[],
  adds: readonly Held[],
  cap: number,
): { rewrites: Rewrite[]; left: number } {
  const removeValues = new Set(removes.map((e) => e.value));
  const kept = new Map<string, Held[]>();
  const taken = new Map<string, PlannedChange[]>();
  for (const record of filters) {
    kept.set(
      record.id,
      record.entries.filter((e) => !removeValues.has(e.value)),
    );
    taken.set(
      record.id,
      record.entries
        .filter((e) => removeValues.has(e.value))
        .map((e) => change("remove", toEntry(e))),
    );
  }
  const pending = [...adds];
  for (const record of filters) {
    const free = GMAIL_ADDRESSES_PER_FILTER - (kept.get(record.id)?.length ?? 0);
    if (free <= 0 || pending.length === 0) continue;
    for (const entry of pending.splice(0, free)) {
      kept.get(record.id)?.push(entry);
      taken.get(record.id)?.push(change("create", toEntry(entry)));
    }
  }
  const rewrites: Rewrite[] = [];
  const touched = (record: FilterRecord): boolean => (taken.get(record.id)?.length ?? 0) > 0;
  const hasRemoval = (record: FilterRecord): boolean =>
    (taken.get(record.id) ?? []).some((c) => c.kind === "remove");
  for (const pass of [true, false]) {
    for (const record of filters) {
      if (!touched(record) || hasRemoval(record) !== pass) continue;
      rewrites.push({
        old: record,
        next: kept.get(record.id) ?? [],
        takes: taken.get(record.id) ?? [],
      });
    }
  }
  while (pending.length > 0) {
    const chunk = pending.splice(0, GMAIL_ADDRESSES_PER_FILTER);
    rewrites.push({
      old: null,
      next: chunk,
      takes: chunk.map((e) => change("create", toEntry(e))),
    });
  }
  const chosen = rewrites.slice(0, cap);
  const all = rewrites.reduce((sum, r) => sum + r.takes.length, 0);
  const done = chosen.reduce((sum, r) => sum + r.takes.length, 0);
  return { rewrites: chosen, left: all - done };
}

export interface GmailAdapterOptions {
  /** The engine lane this adapter serves; it names the journal rows. */
  readonly accountId: string;
  readonly client: GmailFilterClient;
  /**
   * Saves the state in the middle of a round (the app binds it to `store.setState` for this lane). The engine drops a
   * round at 60 s together with everything `apply` returned, so a filter written to Gmail before then is only known
   * if it was saved here first: the intent before each create, the new filter right after (ADR 0009 point 4).
   * Required: without it a dropped round can leave a filter Senderban no longer knows (a wiring that forgets it must not
   * compile). Tests that do not care pass a function that does nothing.
   */
  readonly checkpoint: (state: OpaqueState) => void;
  /** Injectable for tests. Milliseconds. */
  readonly now?: () => number;
  readonly roundDeadlineMs?: number;
  readonly uninstallDeadlineMs?: number;
  readonly roundBudgetMs?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Addresses the lane never mirrors (the person's own mailboxes): a forged own address that was blocked would send the
   * person's own mail to Trash. An address already in a filter that becomes excluded is taken out like an Unblock.
   */
  readonly exclude?: (address: string) => boolean;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const asAdapterError = (error: unknown, fallback: string): AdapterError =>
  error instanceof AdapterError ? error : new AdapterError("TRANSIENT", fallback);

/** The state while a round runs: every step changes it and, when a `checkpoint` is set, saves it. */
interface Work {
  filters: FilterRecord[];
  stale: FilterRecord[];
  intent: Intent[];
  refused: Refusal[];
}
const snapshot = (work: Work): OpaqueState => {
  const data: GmailState = {
    filters: [...work.filters],
    stale: [...work.stale],
    intent: [...work.intent],
    refused: [...work.refused],
  };
  return { adapterId: GMAIL_ADAPTER_ID, data };
};

/**
 * Mirrors the block list's Trash blocks of single addresses onto Gmail filters, so the mail goes to Trash at Gmail
 * (reversible, K7). Up to 50 addresses share one filter. Ownership is the filter id in this lane's state plus an exact
 * read-back of its criteria and action; a filter we did not write is never touched (ADR 0009 point 4).
 */
export class GmailAdapter implements BlockAdapter {
  readonly id = GMAIL_ADAPTER_ID;
  readonly #client: GmailFilterClient;
  readonly #accountId: string;
  readonly #checkpoint: (state: OpaqueState) => void;
  readonly #roundDeadlineMs: number;
  readonly #uninstallDeadlineMs: number;
  readonly #now: () => number;
  readonly #budgetMs: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #exclude: ((address: string) => boolean) | undefined;
  /** The inputs of the last plan that had nothing to do: the same inputs have nothing to do again (see `plan`). */
  #idleKey: string | null = null;
  /** Set while the account's filters are being taken out: no round starts (see `suspend`). */
  #suspended = false;
  /** Set once the account is gone for good (see `retire`). */
  #retired = false;
  #active = 0;
  #idle: (() => void)[] = [];

  constructor(options: GmailAdapterOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#checkpoint = options.checkpoint;
    this.#roundDeadlineMs = options.roundDeadlineMs ?? GMAIL_ROUND_DEADLINE_MS;
    this.#uninstallDeadlineMs = options.uninstallDeadlineMs ?? GMAIL_UNINSTALL_DEADLINE_MS;
    this.#now = options.now ?? Date.now;
    this.#budgetMs = options.roundBudgetMs ?? GMAIL_ROUND_BUDGET_MS;
    this.#retryDelayMs = options.retryDelayMs ?? GMAIL_RETRY_DELAY_MS;
    this.#exclude = options.exclude;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /**
   * Stops writing: a round that is running finishes (it ends by its own deadline), a new one does not start. While
   * suspended `plan` and `apply` answer TRANSIENT, never "nothing to do": the engine must not read the pause as a clean
   * round (an Unblock would be shown as confirmed while its filter is still in Gmail, a block as done while it was never
   * written) and keeps its retry timer. Resolves true when no round is running, false when one is still running after
   * `timeoutMs`. `resume` ends the pause (the removal did not finish).
   */
  suspend(timeoutMs: number = GMAIL_SUSPEND_WAIT_MS): Promise<boolean> {
    this.#suspended = true;
    if (this.#active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  resume(): void {
    this.#suspended = false;
  }

  /**
   * The account is gone for good (removed, or signed out): the lane stays in the engine, which cannot drop one, but has
   * nothing to do for the rest of the session. Unlike a pause this is a clean "nothing to do".
   */
  retire(): void {
    this.#retired = true;
  }

  /** What a plan depends on, as one short value: the mirrorable part of the list (which addresses) and the whole state. */
  #planKey(list: Blocklist, state: OpaqueState): string {
    const hash = createHash("sha256");
    for (const raw of list) {
      if (raw.match !== "exactAddress" || raw.action !== "trash") continue;
      if (this.#exclude?.(raw.value) === true) continue;
      hash.update(raw.value).update("\n");
    }
    return hash.update("\0").update(JSON.stringify(state.data)).digest("base64");
  }

  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    if (this.#retired) {
      return Promise.resolve({ accountId: this.#accountId, changes: [], basedOn: state });
    }
    if (this.#suspended) {
      return Promise.reject(new AdapterError("TRANSIENT", "Gmail filters are being removed"));
    }
    try {
      // A block click plans every lane, and a list holds thousands: the same list over the same state that had nothing to
      // do last time has nothing to do now (a plan is a pure function of the two), and is answered without parsing either.
      const key = this.#planKey(list, state);
      if (key === this.#idleKey) {
        return Promise.resolve({ accountId: this.#accountId, changes: [], basedOn: state });
      }
      const current = parseState(state);
      const wanted = mirrored(list, this.#exclude);
      const refused = new Set(current.refused.map((r) => r.value));
      // An address in an unconfirmed create is not added a second time until a round has settled that create.
      const pending = new Set(current.intent.flatMap((i) => i.entries.map((e) => e.value)));
      const have = new Map(current.filters.flatMap((f) => f.entries).map((e) => [e.value, e]));
      const removes = [...have.values()].filter((e) => !wanted.has(e.value));
      const adds = [...wanted.values()]
        .filter((e) => !have.has(e.value) && !refused.has(e.value) && !pending.has(e.value))
        .map(toHeld);
      const { rewrites, left } = schedule(
        current.filters,
        removes,
        adds,
        GMAIL_MAX_REWRITES_PER_ROUND,
      );
      // An Unblock of an address that an identical filter Senderban did not write holds (a refusal): there is nothing of ours
      // to delete, and the round says so instead of looking done.
      const heldByOthers = current.refused.flatMap((r) =>
        r.id !== undefined && !wanted.has(r.value)
          ? [change("remove", toEntry({ id: r.id, value: r.value }))]
          : [],
      );
      const changes = [...rewrites.flatMap((r) => r.takes), ...heldByOthers];
      // Stale filters (a delete that failed after its replacement was created) and unresolved intents (a create whose
      // answer never came back) must be dealt with by a round, and the engine only runs a round that has changes: one
      // marked change, with a placeholder address, carries that, and `apply` reads it as "clean up".
      // A refusal ends when the filter behind it is gone, and only a round (one list) can see that.
      const pendingWork =
        current.stale.length > 0 || current.intent.length > 0 || current.refused.length > 0;
      this.#idleKey = changes.length === 0 && !pendingWork && left === 0 ? key : null;
      return Promise.resolve({
        accountId: this.#accountId,
        changes: changes.length === 0 && pendingWork ? [change("remove", CLEANUP_ENTRY)] : changes,
        basedOn: state,
        ...(left > 0 ? { deferred: left } : {}),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async apply(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    if (this.#suspended || this.#retired) {
      throw new AdapterError("TRANSIENT", "Gmail filters are being removed");
    }
    this.#active += 1;
    try {
      return await this.#round(plan, signal);
    } finally {
      this.#active -= 1;
      if (this.#active === 0) for (const resolve of this.#idle.splice(0)) resolve();
    }
  }

  async #round(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    const state = parseState(plan.basedOn);
    const removes = plan.changes
      .filter((c) => c.kind === "remove" && c.entry.id !== GMAIL_CLEANUP_ENTRY_ID)
      .map((c) => toHeld(c.entry));
    const adds = plan.changes.filter((c) => c.kind === "create").map((c) => toHeld(c.entry));
    const started = this.#now();
    // One clock for the whole round, under the engine's 60 s: whatever is in flight when it runs out is cut off, and
    // what was saved before then is found again by the next round.
    const deadline = AbortSignal.timeout(this.#roundDeadlineMs);
    const roundSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const work: Work = {
      filters: [...state.filters],
      stale: [...state.stale],
      intent: [...state.intent],
      refused: [...state.refused],
    };
    // A save after a step may fail without stopping the round (the state is still returned at the end); the save of an
    // intent may not: a create must never go out without its intent on disk.
    const save = (strict = false): void => {
      try {
        this.#checkpoint(snapshot(work));
      } catch {
        if (strict) throw new AdapterError("TRANSIENT", "the state could not be saved");
      }
    };
    const failed: { entryId: string; error: AdapterError }[] = [];

    let firstList: readonly GmailFilter[];
    let lost = 0;
    let settledLater: number;
    // Our own limit (budget.ts) says which one; Google's says only that it asked to slow down.
    const rateLimited = (cause: AdapterError): AdapterError =>
      new AdapterError(
        "TRANSIENT",
        cause instanceof GmailBudgetError ? cause.message : "Google asked to slow down, later",
      );
    const stuckStale: FilterRecord[] = [];
    try {
      // One read of the mailbox: what is really there decides what is ours, lost or changed (1 quota unit).
      const listing = await this.#client.list(roundSignal);
      firstList = listing.filters;
      const remote = new Map(listing.filters.map((f) => [f.id, f]));

      // Writes of an earlier round whose answer never came back: the filter is there or it never was.
      const settled = this.#resolveIntents(work, listing.filters);
      // What was taken in or dropped was settled without the plan knowing: one more round compares it with the list.
      settledLater = settled.adopted + settled.dropped;
      if (settled.changed) save();

      // A refusal ends with the filter behind it: the address is put back by the next plan.
      const refusedBefore = work.refused.length;
      work.refused = work.refused.filter((r) => remote.has(r.by));
      settledLater += refusedBefore - work.refused.length;
      if (work.refused.length !== refusedBefore) save();

      for (const record of [...work.filters]) {
        const found = remote.get(record.id);
        if (found === undefined || !matches(found, record)) {
          // Deleted in Gmail, or no longer reading as written (Gmail has no update, so this is a filter someone made in its
          // place): forgotten here and never edited or deleted. The next plan puts back what is still wanted in a new
          // filter, and that follow-up is `deferred`.
          lost += record.entries.length;
          work.filters = work.filters.filter((f) => f.id !== record.id);
        }
      }
      // The filters a newer version replaced: delete them first, they are ours by id. One that is gone, or that no longer
      // reads as written, is simply forgotten. A delete that fails for a reason that may pass fails the round (nothing is
      // written on top of it); one that Gmail refuses for good stays, and the Unblocks that depend on it are reported.
      for (const record of [...work.stale]) {
        const found = remote.get(record.id);
        if (found !== undefined && matches(found, record)) {
          try {
            await this.#remove(record.id, roundSignal);
          } catch (error) {
            const adapterError = asAdapterError(error, "Gmail filter delete failed");
            if (adapterError.code !== "REJECTED") throw adapterError;
            stuckStale.push(record);
          }
        }
        work.stale = work.stale.filter((s) => s.id !== record.id);
      }
      work.stale = [...work.stale, ...stuckStale];
      if (lost > 0 || state.stale.length > 0) save();
    } catch (error) {
      const adapterError = asAdapterError(error, "Gmail call failed");
      // Google asked to slow down before anything was written. Every change of the plan is reported as failed (TRANSIENT),
      // not only deferred: the engine then backs off instead of asking again every 30 s, and an Unblock is not shown as
      // done while the filter that trashes the sender is still in Gmail.
      if (adapterError.code === "QUOTA_EXCEEDED") {
        return {
          applied: 0,
          failed: [
            ...failed,
            // The plan's own changes, the cleanup placeholder included: a cleanup-only round with nothing in `failed` would be
            // recorded as applied and the engine would not ask again (a stale filter or an unsettled write would wait for chance).
            ...plan.changes.map((c) => ({ entryId: c.entry.id, error: rateLimited(adapterError) })),
          ],
          state: snapshot(work),
        };
      }
      throw adapterError;
    }
    const stuckValues = new Set(stuckStale.flatMap((r) => r.entries.map((e) => e.value)));
    for (const entry of removes.filter((e) => stuckValues.has(e.value))) {
      failed.push({
        entryId: entry.id,
        error: new AdapterError("TRANSIENT", "still in a Gmail filter"),
      });
    }

    // An Unblock of an address that an identical filter of someone else's holds: nothing of ours to delete, and the sender
    // is still trashed. Said once (the refusal ends with the report), never as done.
    const heldByOthers = removes.filter((e) => work.refused.some((r) => r.value === e.value));
    if (heldByOthers.length > 0) {
      for (const entry of heldByOthers) {
        failed.push({
          entryId: entry.id,
          error: new AdapterError(
            "REMOTE_CHANGED",
            "a Gmail filter that Senderban did not write still trashes this sender",
          ),
        });
      }
      const values = new Set(heldByOthers.map((e) => e.value));
      work.refused = work.refused.filter((r) => !values.has(r.value));
      save();
    }

    // What an earlier round's intent took in may already hold some of these addresses: never a second copy of one.
    const inFilters = new Set(work.filters.flatMap((f) => f.entries.map((e) => e.value)));
    const { rewrites, left } = schedule(
      work.filters,
      removes,
      adds.filter((e) => !inFilters.has(e.value)),
      GMAIL_MAX_REWRITES_PER_ROUND,
    );

    let applied = 0;
    let handled = 0;
    let stopped: AdapterError | null = null;
    for (const [index, rewrite] of rewrites.entries()) {
      if (handled > 0 && this.#now() - started >= this.#budgetMs) break;
      try {
        roundSignal.throwIfAborted();
        const outcome = await this.#rewrite(rewrite, work, firstList, roundSignal, save);
        if (outcome.kind === "foreign") {
          // The addresses an identical filter of the person's already covers are not tried again every round.
          work.refused = [
            ...work.refused,
            ...rewrite.takes
              .filter((c) => c.kind === "create")
              .map((c) => ({ value: c.entry.value, by: outcome.by, id: c.entry.id })),
          ].slice(-MAX_ENTRIES);
          save();
          for (const c of rewrite.takes) {
            failed.push({
              entryId: c.entry.id,
              error: new AdapterError(
                "REMOTE_CHANGED",
                "an identical filter that Senderban did not create is already in Gmail",
              ),
            });
          }
        } else if (outcome.kind === "stale") {
          // The new filter is in place and recorded; the old one is deleted by the next round. An Unblock is not done yet.
          for (const c of rewrite.takes) {
            if (c.kind === "remove") {
              failed.push({
                entryId: c.entry.id,
                error: new AdapterError("TRANSIENT", "still in a Gmail filter"),
              });
            } else applied += 1;
          }
        } else applied += rewrite.takes.length;
        handled = index + 1;
      } catch (error) {
        const adapterError = asAdapterError(error, "Gmail call failed");
        const quota = adapterError.code === "QUOTA_EXCEEDED";
        // Nothing handled yet: the whole round failed for this reason (a rate limit is reported below, not thrown: the
        // engine would not try again by itself).
        if (handled === 0 && !quota) throw adapterError;
        stopped = quota ? rateLimited(adapterError) : adapterError;
        break;
      }
    }

    const unprocessed = rewrites.slice(handled);
    const unprocessedChanges = unprocessed.reduce((sum, r) => sum + r.takes.length, 0);
    const later = left + lost + settledLater + (stopped === null ? unprocessedChanges : 0);
    const stopError = stopped;
    return {
      applied,
      failed: [
        ...failed,
        // After an error or a rate limit the rest is reported as failed (the engine backs off and tries again); a stop for time
        // is only deferred.
        ...(stopError === null
          ? []
          : unprocessed.flatMap((r) =>
              r.takes.map((c) => ({ entryId: c.entry.id, error: stopError })),
            )),
      ],
      ...(later > 0 ? { deferred: later } : {}),
      state: snapshot(work),
    };
  }

  /**
   * Intents left by an earlier round: a filter with exactly that content that is not in the state is the create that
   * landed, so it is taken in (and the filter it was to replace becomes stale); none means it never landed, and its
   * addresses come back through the next plan (`dropped` counts them, so the round says there is more to do).
   */
  #resolveIntents(
    work: Work,
    remote: readonly GmailFilter[],
  ): { changed: boolean; dropped: number; adopted: number } {
    if (work.intent.length === 0) return { changed: false, dropped: 0, adopted: 0 };
    let dropped = 0;
    let adopted = 0;
    const known = new Set([...work.filters, ...work.stale].map((r) => r.id));
    for (const item of work.intent) {
      const query = queryOf(item.entries);
      const found = remote.find((f) => !known.has(f.id) && matchesQuery(f, query));
      if (found === undefined) {
        dropped += item.entries.length;
        continue;
      }
      known.add(found.id);
      adopted += item.entries.length;
      const old =
        item.replaces === null ? undefined : work.filters.find((f) => f.id === item.replaces);
      if (old !== undefined) {
        work.filters = work.filters.filter((f) => f.id !== old.id);
        if (remote.some((f) => f.id === old.id)) work.stale.push(old);
      }
      work.filters.push({ id: found.id, entries: [...item.entries] });
    }
    work.intent = [];
    return { changed: true, dropped, adopted };
  }

  /** Creates the new version first, then deletes the old one; the state is saved before the create and after each step. */
  async #rewrite(
    rewrite: Rewrite,
    work: Work,
    firstList: readonly GmailFilter[],
    signal: AbortSignal,
    save: (strict?: boolean) => void,
  ): Promise<{ kind: "done" | "stale" } | { kind: "foreign"; by: string }> {
    let record: FilterRecord | null = null;
    if (rewrite.next.length > 0) {
      const query = queryOf(rewrite.next);
      // A filter with exactly this content that the round's first list already held and the state does not know is not
      // ours: Gmail would answer "exists" to the create. Decided here, before anything is saved or sent, so an intent can
      // only ever match a filter this lane wrote (or one written in the seconds since the list).
      const known = new Set([...work.filters, ...work.stale].map((r) => r.id));
      const twin = firstList.find((f) => !known.has(f.id) && matchesQuery(f, query));
      if (twin !== undefined) return { kind: "foreign", by: twin.id };

      const intent: Intent = { entries: [...rewrite.next], replaces: rewrite.old?.id ?? null };
      work.intent.push(intent);
      save(true);
      // No error clears the intent: after a 5xx or a timeout the filter may exist, and a refusal that came from the read
      // that followed says nothing about the create. The next round finds the filter, or drops the intent with a follow-up.
      const created = await this.#create(query, new Set(firstList.map((f) => f.id)), signal);
      work.intent = work.intent.filter((i) => i !== intent);
      record = { id: created.id, entries: [...rewrite.next] };
    }
    const old = rewrite.old;
    if (old !== null) {
      // The old filter is stale from here on, until it is really deleted.
      work.filters = work.filters.filter((f) => f.id !== old.id);
      work.stale.push(old);
    }
    if (record !== null) work.filters.push(record);
    save();
    if (old === null) return { kind: "done" };
    try {
      await this.#remove(old.id, signal);
    } catch {
      return { kind: "stale" };
    }
    work.stale = work.stale.filter((s) => s.id !== old.id);
    save();
    return { kind: "done" };
  }

  /** A filter with exactly this query that was not in the round's first list: ours from a lost answer. */
  async #findNew(
    query: string,
    initialIds: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<GmailFilter | null> {
    const fresh = await this.#client.list(signal);
    return fresh.filters.find((f) => !initialIds.has(f.id) && matchesQuery(f, query)) ?? null;
  }

  /**
   * Gmail holds no two identical filters (measured), so a create whose answer was lost cannot make a duplicate: after a
   * 5xx or a timeout the list is read before anything else, the last attempt included, and "already exists" is resolved
   * the same way. A match that was not in the round's first list is ours. "Exists" with nothing new in the list is not
   * decided either way (the list may lag): the round fails and the intent stays for the next one.
   */
  async #create(
    query: string,
    initialIds: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<GmailFilter> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#client.create(query, signal);
      } catch (error) {
        if (error instanceof FilterExistsError) {
          const found = await this.#findNew(query, initialIds, signal);
          if (found !== null) return found;
          throw new AdapterError("TRANSIENT", "Gmail says the filter exists but does not list it");
        }
        if (!(error instanceof AdapterError) || error.code !== "TRANSIENT") throw error;
        if (attempt < GMAIL_WRITE_RETRIES) {
          await this.#sleep(this.#retryDelayMs * (attempt + 1), signal);
        }
        const found = await this.#findNew(query, initialIds, signal);
        if (found !== null) return found;
        if (attempt >= GMAIL_WRITE_RETRIES) throw error;
      }
    }
  }

  async #remove(id: string, signal?: AbortSignal): Promise<"removed" | "gone"> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#client.remove(id, signal);
      } catch (error) {
        if (
          !(error instanceof AdapterError) ||
          error.code !== "TRANSIENT" ||
          attempt >= GMAIL_WRITE_RETRIES
        ) {
          throw error;
        }
        await this.#sleep(this.#retryDelayMs * (attempt + 1), signal);
      }
    }
  }

  async verify(state: OpaqueState, signal?: AbortSignal): Promise<Drift> {
    const current = parseState(state);
    if (
      current.filters.length === 0 &&
      current.stale.length === 0 &&
      current.intent.length === 0 &&
      current.refused.length === 0
    ) {
      return {
        drifted: false,
        detail: "nothing mirrored",
        checkedAt: new Date().toISOString(),
        checks: [],
      };
    }
    const listing = await this.#client.list(signal);
    const remote = new Map(listing.filters.map((f) => [f.id, f]));
    let missing = 0;
    let changed = 0;
    for (const record of current.filters) {
      const found = remote.get(record.id);
      if (found === undefined) missing += 1;
      else if (!matches(found, record)) changed += 1;
    }
    const inPlace = current.filters.length - missing - changed;
    const staleLeft = current.stale.filter((s) => remote.has(s.id)).length;
    const unresolved = current.intent.length;
    const refusalsGone = current.refused.filter((r) => !remote.has(r.by)).length;
    return {
      drifted: missing + changed > 0 || staleLeft > 0 || unresolved > 0 || refusalsGone > 0,
      detail:
        missing + changed === 0 && staleLeft === 0 && unresolved === 0 && refusalsGone === 0
          ? "Gmail filters in place"
          : `${String(missing)} missing, ${String(changed)} changed, ${String(staleLeft)} left to delete, ${String(unresolved)} writes not confirmed, ${String(refusalsGone)} addresses no longer covered`,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          name: "gmail-filters",
          ok: missing + changed === 0,
          detail: `${String(inPlace)} of ${String(current.filters.length)} exactly as written`,
        },
        {
          name: "stale-filters",
          ok: staleLeft === 0,
          detail: `${String(staleLeft)} left to delete`,
        },
        {
          name: "pending-writes",
          ok: unresolved === 0,
          detail: `${String(unresolved)} not confirmed`,
        },
        {
          name: "refused-addresses",
          ok: refusalsGone === 0,
          detail: `${String(refusalsGone)} no longer covered by the filter behind them`,
        },
      ],
    };
  }

  /**
   * Deletes every filter this lane wrote, each only when it still reads exactly as written. Returns the state of what is
   * LEFT: empty when all are gone. A caller must not go on to revoke the token or forget the account while it is not empty.
   */
  async uninstall(state: OpaqueState): Promise<OpaqueState> {
    const current = parseState(state);
    if (current.filters.length === 0 && current.stale.length === 0 && current.intent.length === 0) {
      return initialGmailState();
    }
    // A person starts this, so it is not cut at the engine's 60 s, but it does end: what is not deleted by then is returned.
    const signal = AbortSignal.timeout(this.#uninstallDeadlineMs);
    const listing = await this.#client.list(signal);
    const work: Work = {
      filters: [...current.filters],
      stale: [...current.stale],
      intent: [...current.intent],
      refused: [],
    };
    this.#resolveIntents(work, listing.filters);
    const remote = new Map(listing.filters.map((f) => [f.id, f]));
    const left: GmailState = { filters: [], stale: [], intent: [], refused: [] };
    for (const [group, records] of [
      ["filters", work.filters],
      ["stale", work.stale],
    ] as const) {
      for (const record of records) {
        const found = remote.get(record.id);
        // Gone, or changed by someone else (no longer ours): nothing for us to delete, and nothing to keep.
        if (found === undefined || !matches(found, record)) continue;
        try {
          await this.#remove(record.id, signal);
        } catch {
          left[group].push(record);
        }
      }
    }
    return { adapterId: GMAIL_ADAPTER_ID, data: left };
  }
}
