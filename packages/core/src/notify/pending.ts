import { randomUUID } from "node:crypto";

// Scale budget: one entry per announced message, at most 5 announcements per drain per account
// (watcher DEFAULT_MAX_PER_DRAIN), plus one entry per toast of an earlier run that is clicked (`restore`). One table for all accounts:
// 50 accounts x 5 = 250 in one burst is above the cap, so the 50 oldest toasts lose their button. `#slots` is bounded by PENDING_MAX
// regardless of accounts or mail volume. `#spent` holds only answered toasts of an earlier run (a person's clicks after a restart; the busiest
// measured day had 9 answered toasts of any kind, real log 2026-11-03) and is capped at PENDING_SPENT_MAX.

/** Live entries kept. Oldest is evicted first; a toast older than this loses its button. */
export const PENDING_MAX = 200;
/** Bounds an id nobody ever answered. A toast can outlive it (Action Center, "Until I close them"): the click then says the mail expired. */
export const PENDING_TTL_MS = 24 * 60 * 60_000;
/**
 * Answered restored ids remembered so eviction cannot make them claimable again. 5,000 is over 500 times the busiest measured day; past it the
 * oldest is forgotten first (it could then be claimed once more, the same as after a restart, ADR 0019). About 121 bytes each, measured.
 */
export const PENDING_SPENT_MAX = 5_000;
/** `#spent` is swept at most this often: a scan per call cost 145 us at 5,000 entries (performance review 2026-11-10). */
const SPENT_SWEEP_MS = 60_000;
/** The tail carries whole seconds, so a spent mark outlives the restore window by this margin. */
const SPENT_SLACK_MS = 1_000;

const TAG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PendingBlock {
  readonly accountId: string;
  /** Validated lowercase `local@domain`. */
  readonly sender: string;
}

export type ConsumeResult =
  | { readonly status: "ok"; readonly block: PendingBlock }
  /** Same id already handled: a double click, or the popup repeating itself. */
  | { readonly status: "duplicate" }
  /** Never issued, evicted or older than the TTL. */
  | { readonly status: "unknown" };

interface Slot {
  readonly block: PendingBlock;
  readonly createdAt: number;
  spent: boolean;
}

export interface PendingOptions {
  readonly max?: number;
  readonly spentMax?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * Maps a notification id to the sender it announced. The popup window only sends the id back, never
 * our data, so this table is the only link from a click to a sender. In memory: after an app restart
 * every id is unknown. A native toast outlives the process (Action Center), so its button also carries the sender and
 * the account, signed with a key of this machine (`ActivationSigner`), and `restore` takes that back for a toast of an earlier
 * run. The caller only calls it for a tail whose signature held. What is not kept across a restart is which ids were already answered, so a
 * click delivered a second time to a new process is claimable once more within the TTL (ADR 0019).
 */
export class PendingBlocks {
  readonly #slots = new Map<string, Slot>();
  /**
   * Restored ids already answered, by creation time: eviction from `#slots` must not make a spent id claimable again by `restore`. Only ids
   * issued before this process started are kept, because `restore` refuses every other one anyway. Capped at `#spentMax`, oldest first.
   */
  readonly #spent = new Map<string, number>();
  #spentSweptAt = Number.NEGATIVE_INFINITY;
  readonly #max: number;
  readonly #spentMax: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #newId: () => string;
  /** When this table was made; a toast announced before that came from an earlier run. */
  readonly #startedAt: number;

  constructor(options: PendingOptions = {}) {
    this.#max = options.max ?? PENDING_MAX;
    this.#spentMax = options.spentMax ?? PENDING_SPENT_MAX;
    this.#ttlMs = options.ttlMs ?? PENDING_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#startedAt = this.#now();
  }

  get size(): number {
    return this.#slots.size;
  }

  /** Answered ids of an earlier run still remembered; read by tests to pin the sweep and the cap. */
  get spentSize(): number {
    return this.#spent.size;
  }

  /** Returns the notification id to put on the toast. */
  add(block: PendingBlock): string {
    this.#expire();
    const id = this.#newId();
    if (!TAG.test(id)) throw new Error("notification id must be a lowercase UUID");
    this.#slots.set(id, { block, createdAt: this.#now(), spent: false });
    this.#evict();
    return id;
  }

  #evict(): void {
    while (this.#slots.size > this.#max) {
      const oldest = this.#slots.keys().next();
      if (oldest.done) break;
      this.#slots.delete(oldest.value);
    }
  }

  /**
   * A click on a toast that an earlier run of the app announced: the process that issued the id is gone, so the table cannot know it. The
   * toast carries the sender and the account, and `issuedAtMs` is when it was announced. Only an id this table does not hold, issued before this
   * process started and still inside the TTL, is taken back; a warm id that was evicted, expired or dropped with its account stays `unknown`.
   * The caller has already checked the account exists. Returns true when the block is now claimable.
   */
  restore(id: string, block: PendingBlock, issuedAtMs: number): boolean {
    this.#expire();
    if (!TAG.test(id) || this.#slots.has(id) || this.#spent.has(id)) return false;
    if (issuedAtMs > this.#startedAt || issuedAtMs <= this.#now() - this.#ttlMs) return false;
    this.#slots.set(id, { block, createdAt: issuedAtMs, spent: false });
    this.#evict();
    return true;
  }

  /** Hands the block out once per id; every later call with the same id is a `duplicate`. */
  consume(id: string): ConsumeResult {
    this.#expire();
    const slot = this.#slots.get(id);
    if (slot === undefined) return { status: "unknown" };
    if (slot.spent) return { status: "duplicate" };
    slot.spent = true;
    if (slot.createdAt <= this.#startedAt) {
      this.#spent.set(id, slot.createdAt);
      while (this.#spent.size > this.#spentMax) {
        const oldest = this.#spent.keys().next();
        if (oldest.done) break;
        this.#spent.delete(oldest.value);
      }
    }
    return { status: "ok", block: slot.block };
  }

  /** What `consume` would answer, without spending the id: a toast shown again still has its one click. */
  peek(id: string): ConsumeResult {
    this.#expire();
    const slot = this.#slots.get(id);
    if (slot === undefined) return { status: "unknown" };
    return slot.spent ? { status: "duplicate" } : { status: "ok", block: slot.block };
  }

  /** Forgets every announcement of one account (it was removed): a click on one of its toasts answers `unknown`. */
  dropAccount(accountId: string): void {
    for (const [id, slot] of this.#slots) {
      if (slot.block.accountId === accountId) this.#slots.delete(id);
    }
  }

  #expire(): void {
    const cutoff = this.#now() - this.#ttlMs;
    // A whole scan (at most `max` entries, 30 ms for 20,000 adds at the cap): `restore` appends an entry issued before the ones
    // already here, so insertion order is no longer creation order.
    for (const [id, slot] of this.#slots) {
      if (slot.createdAt <= cutoff) this.#slots.delete(id);
    }
    const now = this.#now();
    if (now - this.#spentSweptAt < SPENT_SWEEP_MS) return;
    this.#spentSweptAt = now;
    const spentCutoff = cutoff - SPENT_SLACK_MS;
    for (const [id, createdAt] of this.#spent) {
      if (createdAt < spentCutoff) this.#spent.delete(id);
    }
  }
}

/**
 * True only for a lowercase UUID. The id comes back from the popup window (a renderer, so untrusted)
 * and is still just a lookup key, but nothing else is accepted.
 */
export function isNotificationId(raw: unknown): raw is string {
  return typeof raw === "string" && TAG.test(raw);
}
