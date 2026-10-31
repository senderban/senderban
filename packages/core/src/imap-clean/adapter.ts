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
import { CLEAN_UIDS_PER_COMMAND, UID_MAX } from "./session.js";
import type { CleanFolders, CleanLink, CleanMailbox } from "./session.js";

// Scale budget (per account): no connection of its own, the watcher's is shared. A new mail costs one UID MOVE when it is blocked.
// A retro round costs 2-10 window probes and, for a click, one SEARCH per RETRO_BATCH entries, then one ENVELOPE fetch and one MOVE
// per CLEAN_UIDS_PER_COMMAND messages found, within RETRO_ROUND_MS. A queue past RETRO_SCAN_ABOVE reads the window's envelopes once
// instead of searching: a first run costs what the month's mail costs, not what the list costs. RETRO_MAX_UIDS caps both.

export const IMAP_CLEAN_ADAPTER_ID = "imap-clean";

/** Unit: days back from now. A block also clears what already came in; older mail is left alone so a round stays bounded. */
export const RETRO_DAYS = 30;
/** Unit: UIDs. The most of a mailbox a retro pass reads: far above a month of mail, and it bounds a SEARCH answer. */
export const RETRO_MAX_UIDS = 50_000;
/** Unit: UIDs per SINCE probe. RETRO_MAX_UIDS is then at most 10 probes. */
export const RETRO_WINDOW_UIDS = 5_000;
/** Unit: entries in one SEARCH. At two terms each (a domain and its subdomains) an OR stays well under 8,000 octets (RFC 7162 §4). */
export const RETRO_BATCH = 8;
/**
 * Unit: entries queued. Past this a pass reads every sender in the window once instead of searching: 2,500 mails took 0.44 s of
 * ENVELOPE against 6.5 s of 313 SEARCHes on Dovecot (2026-10-31), and the two met at about 260 entries. A click stays a search.
 */
export const RETRO_SCAN_ABOVE = 256;
/** Unit: milliseconds. Well under the engine's 60 s deadline, and short because a round holds a slot a click may be waiting for. */
export const RETRO_ROUND_MS = 10_000;
/** Unit: entries named in one plan, which the journal keeps while the round runs. Apply works down the whole queue either way. */
export const RETRO_ENTRIES_PER_PLAN = 64;
/** Unit: rounds cut off in a row, by the engine's deadline or a lost connection. The fourth try of the same search would go the same way. */
export const RETRO_ABORTS_MAX = 3;
/** Unit: milliseconds. Past-mail clearing rests this long then: the rules go on working, and the abort costs a reconnect each time. */
export const RETRO_HOLD_MS = 1_800_000;
/** Unit: milliseconds. Each rest in a row doubles up to this: a provider that never finishes must not cost a reconnect every half hour for ever. */
export const RETRO_HOLD_MAX_MS = 21_600_000;
/** Unit: milliseconds. A mail flood repeats the gap on every drain; every rule walks the Inbox at most once in this time. */
export const SWEEP_ALL_GAP_MS = 3_600_000;
const DAY_MS = 86_400_000;

const StateSchema = z.strictObject({
  /** The rules this lane holds: what it moves on arrival. */
  applied: BlocklistSchema,
  /** Entries whose past mail is still to be cleared, oldest first. */
  retro: z.array(z.uuid()).max(MAX_ENTRIES),
  /** How far the pass over the first `size` entries of `retro` has read: only UIDs below `below` are left. */
  pass: z
    .strictObject({
      size: z.number().int().min(1).max(MAX_ENTRIES),
      below: z
        .number()
        .int()
        .min(1)
        .max(UID_MAX + 1),
      /** RFC 9051 §2.3.1.1: `below` means nothing once the mailbox has been renumbered. */
      validity: z.string().regex(/^\d{1,20}$/u),
    })
    .nullable()
    .default(null),
  /** A gap's sweep has not run yet. The watcher's cursor is already past that mail, so the request must outlive a restart. */
  sweepOwed: z.boolean().default(false),
});
type CleanState = z.infer<typeof StateSchema>;
type CleanPass = NonNullable<CleanState["pass"]>;

export function initialCleanState(): OpaqueState {
  const data: CleanState = { applied: [], retro: [], pass: null, sweepOwed: false };
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
export interface CleanPassEvent {
  readonly kind: "arrival" | "retro";
  readonly moved: number;
  /** Messages the server would not move (arrival), or read as too large (retro). */
  readonly failed: number;
  readonly ms: number;
  /** Retro only: entries still queued. */
  readonly left?: number;
}

/** The lane waits on purpose: without this line a rest of hours looks like an idle mailbox in the log. */
export interface CleanRestEvent {
  readonly kind: "rest";
  readonly reason: "aborts" | "sweep";
  readonly ms: number;
}

export type CleanEvent = CleanPassEvent | CleanRestEvent;

export interface ImapCleanAdapterOptions {
  readonly accountId: string;
  readonly link: CleanLink;
  /** The saved state: the rules hold from the first mail, before any round has run. */
  readonly initialState: OpaqueState;
  /** Changes the saved state outside a round: a gap comes with no round that could save it. */
  readonly updateState: (change: (state: OpaqueState) => OpaqueState) => void;
  readonly onClean?: (event: CleanEvent) => void;
  /** Past-mail clearing may go on after a rest: a round has to be asked for, nothing else would start one. */
  readonly onRested?: () => void;
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
 * Every UID that came in since `since`, highest first. UIDs grow with arrival, so a window with no hit ends the walk. Mail moved in
 * from elsewhere keeps its old date and sits above: it only widens what is read. A window whose UIDs were all removed ends it early.
 */
async function uidsInWindow(
  box: CleanMailbox,
  top: number,
  since: Date,
  signal?: AbortSignal,
): Promise<number[]> {
  const bottom = Math.max(1, top - RETRO_MAX_UIDS + 1);
  const found: number[] = [];
  // A sequential walk on purpose: each probe decides whether the next one is needed. At most 10.
  for (let hi = top; hi >= bottom; hi -= RETRO_WINDOW_UIDS) {
    signal?.throwIfAborted();
    const lo = Math.max(bottom, hi - RETRO_WINDOW_UIDS + 1);
    const uids = await box.uidsSince(`${String(lo)}:${String(hi)}`, since);
    if (uids.length === 0) break;
    found.push(...uids);
  }
  return found.sort((x, y) => y - x);
}

/**
 * What a FROM search looks for. A bare domain would also hit `booking.example` for `king.example`, and every such hit costs a read.
 * Whatever comes back is still only a candidate: FROM covers the display name too.
 */
function needlesOf(entry: BlockEntry): string[] {
  if (entry.match === "exactAddress") return [entry.value];
  if (entry.match === "exactDomain") return [`@${entry.value}`];
  return [`@${entry.value}`, `.${entry.value}`];
}

/**
 * IMAP cleaning for providers with no rule API (iCloud, Yahoo, AOL, GMX, Web.de). **Not a block on the server**: nothing is written
 * there, so a mail stays in the Inbox while the app is closed. The rules live in this lane's state; `screen` applies them to new
 * mail on the watcher's own connection, and each new entry also clears the last RETRO_DAYS days (ADR 0014).
 */
export class ImapCleanAdapter implements BlockAdapter {
  readonly id = IMAP_CLEAN_ADAPTER_ID;
  readonly #options: ImapCleanAdapterOptions;
  readonly #now: () => number;
  #rules: CleanRules;
  /** Mail came in that nothing looked at: every rule clears the Inbox again. */
  #sweepAll = false;
  /** The saved state says a sweep is owed: a flood of gaps writes it once. */
  #sweepOwed = false;
  /** Entries still queued, as of the last saved state. */
  #queued = 0;
  /** The server turned the last move down: rules are held, but mail is not moving, and `verify` must say so. */
  #moveRefused = false;
  #sweptAllAt = Number.NEGATIVE_INFINITY;
  #retroAborts = 0;
  #retroHeldUntil = 0;
  #retroRestMs = RETRO_HOLD_MS;
  #restTimer: ReturnType<typeof setTimeout> | null = null;
  #sweepTimer: ReturnType<typeof setTimeout> | null = null;
  #sweepDue: number | null = null;
  /** The last round threw, so nothing was saved: a new session is worth a round even with an empty queue. */
  #roundFailed = false;
  #retired = false;
  #folders: { readonly box: CleanMailbox; folders: CleanFolders } | null = null;

  constructor(options: ImapCleanAdapterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    const initial = parseState(options.initialState);
    this.#rules = compileRules(initial.applied);
    this.#queued = initial.retro.length;
    if (initial.sweepOwed) {
      this.#sweepOwed = true;
      this.#startSweep();
    }
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /** Past mail is waiting for a round. A new session with nothing queued needs none: a quiet plan costs 33-49 ms at 5,000 entries. */
  get hasWork(): boolean {
    return this.#queued > 0 || this.#sweepAll || this.#roundFailed;
  }

  /** The account was removed: nothing moves any more, and rounds have nothing to do for the rest of the session. */
  retire(): void {
    this.#retired = true;
    if (this.#restTimer !== null) clearTimeout(this.#restTimer);
    this.#restTimer = null;
    if (this.#sweepTimer !== null) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#sweepDue = null;
  }

  /**
   * Mail came in that `screen` never saw: the next round reads the Inbox for every rule. `force` is for a renumbered mailbox, whose
   * saved pass is void: it waits the shorter rest instead of the hourly limit, because a sweep restarts a pass. A request inside the
   * limit is not lost: that mail is still unread, so one sweep at the end of the limit answers every gap inside it, and a restart
   * before that end starts it at the first session.
   */
  sweepAll(force = false): void {
    if (this.#retired) return;
    const due = this.#sweptAllAt + (force ? RETRO_HOLD_MS : SWEEP_ALL_GAP_MS);
    if (this.#now() < due) this.#deferSweep(due);
    else this.#startSweep();
    if (!this.#sweepOwed) this.#saveSweepOwed();
  }

  #saveSweepOwed(): void {
    this.#options.updateState((state) => ({
      adapterId: IMAP_CLEAN_ADAPTER_ID,
      data: { ...parseState(state), sweepOwed: true },
    }));
    this.#sweepOwed = true;
  }

  /** A method, so the compiler does not assume the flag is still false after an await. */
  #owesSweep(): boolean {
    return this.#sweepAll || this.#sweepDue !== null;
  }

  #startSweep(): void {
    if (this.#sweepTimer !== null) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#sweepDue = null;
    this.#sweptAllAt = this.#now();
    this.#sweepAll = true;
  }

  #deferSweep(due: number): void {
    if (this.#sweepDue !== null && this.#sweepDue <= due) return;
    if (this.#sweepTimer !== null) clearTimeout(this.#sweepTimer);
    this.#sweepDue = due;
    const rest = due - this.#now();
    this.#sweepTimer = setTimeout(() => {
      this.#startSweep();
      this.#options.onRested?.();
    }, rest);
    this.#sweepTimer.unref();
    this.#options.onClean?.({ kind: "rest", reason: "sweep", ms: rest });
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
    // A save that failed at the gap is tried once a round: without it a restart loses a sweep the cursor has already gone past.
    if (this.#owesSweep() && !this.#sweepOwed) {
      try {
        this.#saveSweepOwed();
      } catch {
        // The request is still in memory, and the next round tries again.
      }
    }
    const wanted = new Map<string, BlockEntry>();
    for (const raw of list) {
      const checked = checkEntry(raw);
      if (!checked.ok) {
        throw new AdapterError("REJECTED", `entry ${raw.id} refused: ${checked.reason}`);
      }
      wanted.set(entryKey(checked.entry), checked.entry);
    }
    // The list decides, not the saved state: after a round that failed the two differ, and an Unblock must still stop the moving.
    this.#rules = compileRules([...wanted.values()]);
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

  /** As much of the past as the round allows (`plan` has set the rules). What is left is saved and goes on in a later round. */
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

    const stillThere = new Set(applied.map((e) => e.id));
    const added = created.filter((e) => !known.has(e.id)).map((e) => e.id);
    const sweepAll = this.#sweepAll;
    const queue = sweepAll
      ? applied.map((e) => e.id)
      : [...new Set([...state.retro, ...added])].filter((id) => stillThere.has(id));
    this.#sweepAll = false;

    // A pass stands for the entries it began with: a changed front of the queue starts it again.
    const held = state.pass;
    const sameFront =
      !sweepAll &&
      held !== null &&
      state.retro.length >= held.size &&
      state.retro.slice(0, held.size).every((id, at) => queue[at] === id);

    const box = this.#options.link.current;
    let left = queue;
    let pass = sameFront ? held : null;
    try {
      if (box !== null && this.#canSweep()) {
        ({ left, pass } = await this.#sweep(box, queue, pass, applied, signal));
      }
    } catch (error) {
      // No state is saved for a failed round, so the request must outlive it.
      if (sweepAll) this.#sweepAll = true;
      this.#roundFailed = true;
      throw error;
    }
    this.#roundFailed = false;
    this.#queued = left.length;
    // What this round took is in `left` now, and only a request made since is still owed.
    const sweepOwed = this.#owesSweep();
    this.#sweepOwed = sweepOwed;
    return {
      applied: plan.changes.length,
      failed: [],
      state: { adapterId: IMAP_CLEAN_ADAPTER_ID, data: { applied, retro: left, pass, sweepOwed } },
      // With the connection gone the link's `onOpen` starts the next round; a timer would only find it gone again.
      ...(left.length > 0 && this.#canSweep() ? { deferred: left.length } : {}),
    };
  }

  /**
   * Works down the queue, a pass at a time, and returns what is left. Each round gets through at least one step, however slow the
   * server, and the pass remembers how far it read, so a round never starts over and a queue always ends. The connection going away
   * is no failure of the round: the queue just waits.
   */
  async #sweep(
    box: CleanMailbox,
    queue: readonly string[],
    resume: CleanPass | null,
    applied: Blocklist,
    signal?: AbortSignal,
  ): Promise<{ readonly left: string[]; readonly pass: CleanPass | null }> {
    const left = [...queue];
    if (left.length === 0) return { left, pass: null };
    const top = box.topUid();
    if (top < 1) return { left: [], pass: null };

    const started = this.#now();
    const validity = box.uidValidity();
    let pass = resume?.validity === validity ? resume : null;
    let moved = 0;
    let failed = 0;
    let reading: readonly number[] = [];
    let progressed = false;
    const onAbort = (): void => {
      box.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const since = new Date(this.#now() - RETRO_DAYS * DAY_MS);
      const inWindow = await uidsInWindow(box, top, since, signal);
      const lowest = inWindow.at(-1);
      if (lowest === undefined) {
        left.length = 0;
        return { left, pass: null };
      }
      const entries = new Map(applied.map((e) => [e.id, e]));
      let steps = 0;
      const mayGoOn = (): boolean => steps === 0 || this.#now() - started < RETRO_ROUND_MS;
      // One at a time on purpose: all of this shares one connection, and the clock decides whether the next step runs.
      while (left.length > 0 && mayGoOn()) {
        signal?.throwIfAborted();
        const current: CleanPass = pass ?? {
          size: left.length > RETRO_SCAN_ABOVE ? left.length : Math.min(left.length, RETRO_BATCH),
          below: top + 1,
          validity,
        };
        pass = current;
        // A long queue reads the window's senders once, instead of one search per RETRO_BATCH entries over the same mail.
        const needles = left
          .slice(0, current.size)
          .flatMap((id) => entries.get(id))
          .flatMap((e) => (e === undefined ? [] : needlesOf(e)));
        let candidates: readonly number[] = inWindow;
        if (current.size <= RETRO_BATCH) {
          candidates =
            needles.length === 0
              ? []
              : await box.searchFrom(`${String(lowest)}:${String(top)}`, needles);
        }
        const todo = candidates.filter((uid) => uid < current.below).sort((x, y) => y - x);
        // A step is what cannot be lost: a read that moves the pass on, or a batch that ends. A search alone is not one, or a server
        // this slow would spend every round on the same search.
        if (todo.length === 0) steps += 1;
        let complete = true;
        for (const part of chunks(todo, CLEAN_UIDS_PER_COMMAND)) {
          if (!mayGoOn()) {
            complete = false;
            break;
          }
          signal?.throwIfAborted();
          reading = part;
          const rows = await box.readFrom(part);
          const hits = rows.flatMap((row) => {
            const target = this.#rules.targetFor(row.from);
            return target === null ? [] : [{ uid: row.uid, target }];
          });
          moved += await this.#move(box, hits);
          pass = { ...current, below: Math.min(...part) };
          steps += 1;
          progressed = true;
        }
        if (complete) {
          left.splice(0, current.size);
          pass = null;
          progressed = true;
        }
      }
    } catch (error) {
      if (error instanceof UnreadableMailError) {
        // The connection ended on it. The messages of this one read are given up; the next session goes on below them.
        failed += reading.length;
        if (pass !== null && reading.length > 0) {
          pass = { ...pass, below: Math.min(...reading) };
        }
      } else if (error instanceof AdapterError) {
        throw error;
      } else {
        // Progress first: with the connection simply gone this round's steps are saved below, and they count before the abort does.
        const stays = signal?.aborted === true || this.#options.link.current === box;
        if (progressed && !stays) this.#noteProgress();
        progressed = false;
        this.#noteAbort();
        if (signal?.aborted === true) throw error;
        // With the session still there this was no lost connection, and a round that did nothing must not read as done.
        if (this.#options.link.current === box) {
          throw new AdapterError("TRANSIENT", "the server did not finish the round", {
            cause: error,
          });
        }
      }
      // The connection went: the watcher reconnects, and the queue goes on when it does.
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
    // Only here: a round that throws saves nothing, so the next one passes the same step again and the rest would never begin.
    if (progressed) this.#noteProgress();
    return { left, pass };
  }

  #noteProgress(): void {
    this.#retroAborts = 0;
    this.#retroRestMs = RETRO_HOLD_MS;
  }

  #noteAbort(): void {
    this.#retroAborts += 1;
    if (this.#retroAborts < RETRO_ABORTS_MAX) return;
    this.#retroAborts = 0;
    const rest = this.#retroRestMs;
    this.#retroRestMs = Math.min(rest * 2, RETRO_HOLD_MAX_MS);
    this.#retroHeldUntil = this.#now() + rest;
    if (this.#restTimer !== null) clearTimeout(this.#restTimer);
    this.#restTimer = setTimeout(() => {
      this.#restTimer = null;
      this.#options.onRested?.();
    }, rest);
    this.#restTimer.unref();
    this.#options.onClean?.({ kind: "rest", reason: "aborts", ms: rest });
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
