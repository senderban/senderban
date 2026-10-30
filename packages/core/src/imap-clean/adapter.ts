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
import {
  BlocklistSchema,
  MAX_ENTRIES,
  checkEntry,
  type BlockEntry,
  type Blocklist,
} from "../blocklist.js";
import { UnreadableMailError } from "../watcher/watcher.js";
import type { IncomingMessage } from "../watcher/watcher.js";
import { compileRules } from "./rules.js";
import type { CleanRules, CleanTarget } from "./rules.js";
import { CLEAN_UIDS_PER_COMMAND } from "./session.js";
import type { CleanFolders, CleanLink, CleanMailbox } from "./session.js";

// Scale budget (per account): no connection of its own, the watcher's is shared. A new mail costs one UID MOVE when it is blocked.
// A retro round costs 2-10 window probes, one SEARCH per RETRO_TERMS new entries and, for what those find, one ENVELOPE fetch and
// one MOVE per CLEAN_UIDS_PER_COMMAND messages, within RETRO_ROUND_MS. A click is one round; a first run over 5,000 entries is
// 313 SEARCHes, spread over rounds 30-60 s apart. Linear in entries, not in mailbox size: RETRO_MAX_UIDS caps that.

export const IMAP_CLEAN_ADAPTER_ID = "imap-clean";

/** Unit: days back from now. A block also clears what already came in; older mail is left alone so a round stays bounded. */
export const RETRO_DAYS = 30;
/** Unit: UIDs. The most of a mailbox a retro pass reads: far above a month of mail, and it bounds a SEARCH answer. */
export const RETRO_MAX_UIDS = 50_000;
/** Unit: UIDs per SINCE probe. RETRO_MAX_UIDS is then at most 10 probes. */
export const RETRO_WINDOW_UIDS = 5_000;
/** Unit: FROM terms in one SEARCH. An OR of 16 stays well under 8,000 octets (RFC 7162 §4) at the longest address, 254 characters. */
export const RETRO_TERMS = 16;
/** Unit: milliseconds. Well under the engine's 60 s deadline, and short because a round holds a slot a click may be waiting for. */
export const RETRO_ROUND_MS = 10_000;
/** Unit: entries named in one plan, which the journal keeps while the round runs. Apply works down the whole queue either way. */
export const RETRO_ENTRIES_PER_PLAN = 64;
/** Unit: rounds the engine gave up on in a row. A provider this slow will not answer the same search on the fourth try either. */
export const RETRO_ABORTS_MAX = 3;
/** Unit: milliseconds. Past-mail clearing rests this long then: the rules go on working, and the abort costs a reconnect each time. */
export const RETRO_HOLD_MS = 1_800_000;
/** Unit: milliseconds. A mail flood repeats the gap on every drain; every rule walks the Inbox at most once in this time. */
export const SWEEP_ALL_GAP_MS = 3_600_000;
const DAY_MS = 86_400_000;

const StateSchema = z.strictObject({
  /** The rules this lane holds: what it moves on arrival. */
  applied: BlocklistSchema,
  /** Entries whose past mail is still to be cleared, oldest first. */
  retro: z.array(z.uuid()).max(MAX_ENTRIES),
});
type CleanState = z.infer<typeof StateSchema>;

export function initialCleanState(): OpaqueState {
  const data: CleanState = { applied: [], retro: [] };
  return { adapterId: IMAP_CLEAN_ADAPTER_ID, data };
}

function parseState(state: OpaqueState): CleanState {
  if (state.adapterId !== IMAP_CLEAN_ADAPTER_ID) {
    throw new AdapterError("REJECTED", "state belongs to another adapter");
  }
  const parsed = StateSchema.safeParse(state.data);
  if (!parsed.success) throw new AdapterError("REJECTED", "cleaning state failed validation");
  return parsed.data;
}

/** What one pass did, for the log: counts and times only. */
export interface CleanEvent {
  readonly kind: "arrival" | "retro";
  readonly moved: number;
  /** Messages the server would not move (arrival), or read as too large (retro). */
  readonly failed: number;
  readonly ms: number;
  /** Retro only: entries still queued. */
  readonly left?: number;
}

export interface ImapCleanAdapterOptions {
  readonly accountId: string;
  readonly link: CleanLink;
  /** The saved state: the rules hold from the first mail, before any round has run. */
  readonly initialState: OpaqueState;
  readonly onClean?: (event: CleanEvent) => void;
  readonly now?: () => number;
}

const CAPABILITIES: Capabilities = {
  serverBlock: false,
  retroClean: true,
  watch: true,
  unsubscribe: false,
  quota: false,
  exactAddress: true,
  exactDomain: true,
  subdomains: true,
};

const entryKey = (e: BlockEntry): string => JSON.stringify([e.id, e.match, e.value, e.action]);

/** `items` in runs of at most `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/**
 * The lowest UID that came in since `since`, or null when nothing did. UIDs grow with arrival, so a window with no hit ends the walk.
 * Mail moved in from elsewhere keeps its old date and sits above: it only widens the range the searches read.
 */
async function floorSince(
  box: CleanMailbox,
  top: number,
  since: Date,
  signal?: AbortSignal,
): Promise<number | null> {
  const bottom = Math.max(1, top - RETRO_MAX_UIDS + 1);
  let floor: number | null = null;
  // A sequential walk on purpose: each probe decides whether the next one is needed. At most 10.
  for (let hi = top; hi >= bottom; hi -= RETRO_WINDOW_UIDS) {
    signal?.throwIfAborted();
    const lo = Math.max(bottom, hi - RETRO_WINDOW_UIDS + 1);
    const uids = await box.uidsSince(`${String(lo)}:${String(hi)}`, since);
    const lowest = uids.reduce((low, uid) => Math.min(low, uid), Number.POSITIVE_INFINITY);
    if (lowest === Number.POSITIVE_INFINITY) return floor;
    floor = lowest;
  }
  return floor;
}

/**
 * IMAP cleaning for providers with no rule API (iCloud, Yahoo, AOL, GMX, Web.de). **Not a block on the server**: nothing is written
 * there, so a mail stays in the Inbox while the app is closed. The rules live in this lane's state; `screen` applies them to new
 * mail on the watcher's own connection, and each new entry also clears the last RETRO_DAYS days (ADR 0012).
 */
export class ImapCleanAdapter implements BlockAdapter {
  readonly id = IMAP_CLEAN_ADAPTER_ID;
  readonly #options: ImapCleanAdapterOptions;
  readonly #now: () => number;
  #rules: CleanRules;
  /** Mail came in that nothing looked at: every rule clears the Inbox again. */
  #sweepAll = false;
  /** The server turned the last move down: rules are held, but mail is not moving, and `verify` must say so. */
  #moveRefused = false;
  #sweptAllAt = Number.NEGATIVE_INFINITY;
  #retroAborts = 0;
  #retroHeldUntil = 0;
  #retired = false;
  #folders: { readonly box: CleanMailbox; folders: CleanFolders } | null = null;

  constructor(options: ImapCleanAdapterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#rules = compileRules(parseState(options.initialState).applied);
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /** The account was removed: nothing moves any more, and rounds have nothing to do for the rest of the session. */
  retire(): void {
    this.#retired = true;
  }

  /** Mail came in that `screen` never saw (more in one gap than the watcher fetches): the next round reads the Inbox for every rule. */
  sweepAll(): void {
    if (this.#now() - this.#sweptAllAt < SWEEP_ALL_GAP_MS) return;
    this.#sweptAllAt = this.#now();
    this.#sweepAll = true;
  }

  /** Whether a round may read the Inbox now. A reconnect must not restart a search the provider just could not finish. */
  #canSweep(): boolean {
    return this.#options.link.current !== null && this.#now() >= this.#retroHeldUntil;
  }

  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    if (this.#retired) {
      return Promise.resolve({ accountId: this.#options.accountId, changes: [], basedOn: state });
    }
    try {
      return Promise.resolve(this.#plan(list, state));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #plan(list: Blocklist, state: OpaqueState): Plan {
    const current = parseState(state);
    const wanted = new Map<string, BlockEntry>();
    for (const raw of list) {
      const checked = checkEntry(raw);
      if (!checked.ok) {
        throw new AdapterError("REJECTED", `entry ${raw.id} refused: ${checked.reason}`);
      }
      wanted.set(entryKey(checked.entry), checked.entry);
    }
    const have = new Map(current.applied.map((e) => [entryKey(e), e]));

    const changes: PlannedChange[] = [];
    for (const [key, entry] of have) {
      if (!wanted.has(key)) changes.push({ kind: "remove", entry, match: entry.match });
    }
    for (const [key, entry] of wanted) {
      if (!have.has(key)) changes.push({ kind: "create", entry, match: entry.match });
    }
    // Clearing waits for the connection: a round with nothing else to do starts only when there is one (the link's `onOpen`).
    if (this.#canSweep()) {
      const queued = new Set(current.retro);
      const waiting = current.applied.filter(
        (e) => wanted.has(entryKey(e)) && (this.#sweepAll || queued.has(e.id)),
      );
      for (const entry of waiting.slice(0, RETRO_ENTRIES_PER_PLAN)) {
        changes.push({ kind: "create", entry, match: entry.match });
      }
    }
    return { accountId: this.#options.accountId, changes, basedOn: state };
  }

  /** Rules first and at once, then as much of the past as the round allows. What is left is saved and goes on in a later round. */
  async apply(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    if (this.#retired) throw new AdapterError("TRANSIENT", "the account was removed");
    const state = parseState(plan.basedOn);
    const removed = new Set(plan.changes.filter((c) => c.kind === "remove").map((c) => c.entry.id));
    const created = plan.changes.filter((c) => c.kind === "create").map((c) => c.entry);
    const known = new Set(state.applied.map((e) => e.id));
    const fresh = new Set(created.map((e) => e.id));
    const applied = BlocklistSchema.parse([
      ...state.applied.filter((e) => !removed.has(e.id) && !fresh.has(e.id)),
      ...created,
    ]);
    this.#rules = compileRules(applied);

    const stillThere = new Set(applied.map((e) => e.id));
    const added = created.filter((e) => !known.has(e.id)).map((e) => e.id);
    const sweepAll = this.#sweepAll;
    const queue = sweepAll
      ? applied.map((e) => e.id)
      : [...new Set([...state.retro, ...added])].filter((id) => stillThere.has(id));
    this.#sweepAll = false;

    const box = this.#options.link.current;
    let left = queue;
    try {
      if (box !== null && this.#canSweep()) left = await this.#sweep(box, queue, applied, signal);
    } catch (error) {
      // No state is saved for a failed round, so the request must outlive it.
      if (sweepAll) this.#sweepAll = true;
      throw error;
    }
    return {
      applied: plan.changes.length,
      failed: [],
      state: { adapterId: IMAP_CLEAN_ADAPTER_ID, data: { applied, retro: left } },
      // With the connection gone the link's `onOpen` starts the next round; a timer would only find it gone again.
      ...(left.length > 0 && this.#canSweep() ? { deferred: left.length } : {}),
    };
  }

  /** Works down the queue and returns what is left; the connection going away is no failure of the round, the queue just waits. */
  async #sweep(
    box: CleanMailbox,
    queue: readonly string[],
    applied: Blocklist,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const left = [...queue];
    const started = this.#now();
    const top = box.topUid();
    if (left.length === 0) return left;
    if (top < 1) return [];

    const onAbort = (): void => {
      box.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let moved = 0;
    let failed = 0;
    try {
      const since = new Date(this.#now() - RETRO_DAYS * DAY_MS);
      const floor = await floorSince(box, top, since, signal);
      if (floor === null) {
        left.length = 0;
        return left;
      }
      const values = new Map(applied.map((e) => [e.id, e.value]));
      const range = `${String(floor)}:${String(top)}`;
      const inTime = (): boolean => this.#now() - started < RETRO_ROUND_MS;
      // One at a time on purpose: all of this shares one connection, and the clock decides whether the next step runs.
      while (left.length > 0 && inTime()) {
        signal?.throwIfAborted();
        const batch = left.slice(0, RETRO_TERMS);
        const needles = batch.flatMap((id) => values.get(id) ?? []);
        const uids = needles.length === 0 ? [] : await box.searchFrom(range, needles);
        let complete = true;
        for (const part of chunks(uids, CLEAN_UIDS_PER_COMMAND)) {
          if (!inTime()) {
            complete = false;
            break;
          }
          signal?.throwIfAborted();
          const rows = await box.readFrom(part);
          const hits = rows.flatMap((row) => {
            const target = this.#rules.targetFor(row.from);
            return target === null ? [] : [{ uid: row.uid, target }];
          });
          moved += await this.#move(box, hits);
        }
        if (complete) {
          left.splice(0, batch.length);
          this.#retroAborts = 0;
        }
      }
    } catch (error) {
      if (error instanceof UnreadableMailError) {
        // The connection ended on it. These senders' past mail is given up, not the whole queue.
        left.splice(0, RETRO_TERMS);
        failed += 1;
      } else if (error instanceof AdapterError) {
        throw error;
      } else if (signal?.aborted === true) {
        this.#noteAbort();
        throw error;
      }
      // Anything else is the connection going: the watcher reconnects, and the queue goes on when it does.
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#options.onClean?.({
        kind: "retro",
        moved,
        failed,
        ms: this.#now() - started,
        left: left.length,
      });
    }
    return left;
  }

  #noteAbort(): void {
    this.#retroAborts += 1;
    if (this.#retroAborts < RETRO_ABORTS_MAX) return;
    this.#retroAborts = 0;
    this.#retroHeldUntil = this.#now() + RETRO_HOLD_MS;
  }

  async #foldersOf(box: CleanMailbox): Promise<CleanFolders> {
    if (this.#folders?.box === box) return this.#folders.folders;
    if (!box.canMove()) {
      throw new AdapterError(
        "CAPABILITY_NOT_SUPPORTED",
        "this server cannot move mail by UID, so Senderban leaves it alone",
      );
    }
    const folders = await box.folders();
    this.#folders = { box, folders };
    return folders;
  }

  /** The folder for `target`, made if the server has none yet (RFC 6154 names the role, a new mailbox simply takes the usual name). */
  async #folderFor(box: CleanMailbox, target: CleanTarget): Promise<string> {
    const folders = await this.#foldersOf(box);
    const found = folders[target];
    if (found !== null) return found;
    const path = target === "junk" ? "Junk" : "Trash";
    await box.createFolder(path);
    if (this.#folders?.box === box) {
      this.#folders.folders = { ...this.#folders.folders, [target]: path };
    }
    return path;
  }

  async #move(
    box: CleanMailbox,
    hits: readonly { readonly uid: number; readonly target: CleanTarget }[],
  ): Promise<number> {
    let moved = 0;
    try {
      // At most two targets, one UID MOVE each per CLEAN_UIDS_PER_COMMAND: never one command per mail.
      for (const target of ["junk", "trash"] as const) {
        const uids = hits.filter((h) => h.target === target).map((h) => h.uid);
        if (uids.length === 0) continue;
        const folder = await this.#folderFor(box, target);
        for (const part of chunks(uids, CLEAN_UIDS_PER_COMMAND)) {
          await box.move(part, folder);
          moved += part.length;
        }
      }
    } catch (error) {
      if (error instanceof AdapterError) {
        this.#moveRefused = true;
        // The folder may be what went: the next move looks again instead of trusting this session's list.
        this.#folders = null;
      }
      throw error;
    }
    if (moved > 0) this.#moveRefused = false;
    return moved;
  }

  /**
   * Sees every new mail before anything is announced, and returns the mail left to announce. A refusal by the server leaves those
   * messages where they are and says so; a connection that went throws, so the cursor stays and the next session tries again.
   */
  async screen(fresh: readonly IncomingMessage[]): Promise<readonly IncomingMessage[]> {
    if (this.#retired) return fresh;
    const rules = this.#rules;
    const hits = fresh.flatMap((message) => {
      const target = rules.targetFor(message.from);
      return target === null ? [] : [{ uid: message.uid, target }];
    });
    if (hits.length === 0) return fresh;
    const box = this.#options.link.current;
    if (box === null) throw new Error("mailbox not connected");

    const started = this.#now();
    const blocked = new Set(hits.map((h) => h.uid));
    const rest = fresh.filter((message) => !blocked.has(message.uid));
    let moved = 0;
    try {
      moved = await this.#move(box, hits);
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      // A blocked sender's mail gets no Block button either way.
    }
    this.#options.onClean?.({
      kind: "arrival",
      moved,
      failed: hits.length - moved,
      ms: this.#now() - started,
    });
    return rest;
  }

  /**
   * There is no rule on the server to read back. What can be said is whether anything is moving mail right now, and when the
   * mailbox is away that is a difference the person must hear about.
   */
  verify(state: OpaqueState): Promise<Drift> {
    if (this.#retired) {
      return Promise.reject(new AdapterError("TRANSIENT", "the account was removed"));
    }
    try {
      const current = parseState(state);
      const held = current.applied.length === this.#rules.size;
      const connected = this.#options.link.current !== null;
      const moving = !this.#moveRefused;
      const checks = [
        { name: "rules-held", ok: held, detail: held ? "held on this device" : "rules differ" },
        {
          name: "mailbox-connected",
          ok: connected,
          detail: connected ? "connected" : "the mailbox is not connected, so nothing moves now",
        },
        {
          name: "moves-accepted",
          ok: moving,
          detail: moving ? "accepted" : "the server refused the last move",
        },
      ];
      const failed = checks.filter((c) => !c.ok);
      return Promise.resolve({
        drifted: failed.length > 0,
        detail:
          failed.length === 0
            ? "held on this device, moving mail while Senderban runs"
            : failed.map((c) => c.detail).join("; "),
        checkedAt: new Date(this.#now()).toISOString(),
        checks,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
