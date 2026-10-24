import { randomUUID } from "node:crypto";

// Scale budget: one entry per announced message, at most 5 announcements per drain per account
// (watcher DEFAULT_MAX_PER_DRAIN). Memory is bounded by PENDING_MAX regardless of accounts or mail volume.

/** Entries kept (spent ones included). Oldest is evicted first; a toast older than this loses its button. */
export const PENDING_MAX = 200;
/** A toast stays in the Action Center until dismissed; after this long its button stops working. */
export const PENDING_TTL_MS = 24 * 60 * 60_000;

const TAG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PendingBlock {
  readonly accountId: string;
  /** Validated lowercase `local@domain`. */
  readonly sender: string;
}

export type ConsumeResult =
  | { readonly status: "ok"; readonly block: PendingBlock }
  /** Same id already handled: Windows delivers one click as two activations (~60 ms apart, measured). */
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
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * Maps a notification id to the sender it announced. The Windows activation callback only returns
 * the id (as `tag=<id>`), never our data, so this table is the only link from a click back to a
 * sender. In memory: after an app restart the ids of toasts still sitting in the Action Center are
 * unknown (ADR 0003, measure item 4).
 */
export class PendingBlocks {
  readonly #slots = new Map<string, Slot>();
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(options: PendingOptions = {}) {
    this.#max = options.max ?? PENDING_MAX;
    this.#ttlMs = options.ttlMs ?? PENDING_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
  }

  get size(): number {
    return this.#slots.size;
  }

  /** Returns the notification id to put on the toast. */
  add(block: PendingBlock): string {
    this.#expire();
    const id = this.#newId();
    if (!TAG.test(id)) throw new Error("notification id must be a lowercase UUID");
    this.#slots.set(id, { block, createdAt: this.#now(), spent: false });
    while (this.#slots.size > this.#max) {
      const oldest = this.#slots.keys().next();
      if (oldest.done) break;
      this.#slots.delete(oldest.value);
    }
    return id;
  }

  /** Hands the block out once per id; every later call with the same id is a `duplicate`. */
  consume(id: string): ConsumeResult {
    this.#expire();
    const slot = this.#slots.get(id);
    if (slot === undefined) return { status: "unknown" };
    if (slot.spent) return { status: "duplicate" };
    slot.spent = true;
    return { status: "ok", block: slot.block };
  }

  #expire(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, slot] of this.#slots) {
      // Insertion order is creation order, so the first live entry ends the sweep.
      if (slot.createdAt > cutoff) break;
      this.#slots.delete(id);
    }
  }
}

/**
 * Extracts our notification id from Windows' raw activation string (`type=action&action=0&tag=<id>`).
 * The string is untrusted: only a lowercase UUID is accepted, and it is still just a lookup key.
 */
export function activationTag(raw: string): string | null {
  if (raw.length > 512) return null;
  const tag = new URLSearchParams(raw).get("tag");
  return tag !== null && TAG.test(tag) ? tag : null;
}
