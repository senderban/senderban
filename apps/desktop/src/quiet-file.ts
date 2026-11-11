import { readFile, rename, stat } from "node:fs/promises";
import {
  QUIET_ENTRY_MAX,
  QUIET_MAX,
  QuietFileSchema,
  SOURCE_MAX,
  quietRows,
} from "@senderban/core";
import type { QuietRow } from "@senderban/core";
import { writeJsonAtomic } from "./accounts-file.js";

// Every row at its longest: the value and the mailbox name at up to 4 UTF-8 bytes a character, plus the indent, keys, quotes,
// commas and line ends of a pretty-printed row (about 51; 64 kept). Unit: bytes.
const FILE_MAX_BYTES = QUIET_MAX * ((QUIET_ENTRY_MAX + SOURCE_MAX) * 4 + 64) + 64;

type Rows = ReadonlyMap<string, string | undefined>;

/**
 * The "Don't ask again" list (ADR 0016). Scale: one read at start, one write per click, a lookup in memory per announced mail. Saves
 * wait for each other, so two quick clicks cannot lose one. Each value keeps the mailbox it was chosen in, for the page's filter only.
 */
export class QuietStore {
  readonly #path: string;
  #rows: Rows = new Map();
  #entries: ReadonlySet<string> = new Set();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  /** The values, for the lookup on every announced mail. */
  get entries(): ReadonlySet<string> {
    return this.#entries;
  }

  /** What the page lists, in the order they were added. */
  get rows(): QuietRow[] {
    return [...this.#rows].map(([value, source]) =>
      source === undefined ? { value } : { value, source },
    );
  }

  /**
   * A missing file is a first start. A file that cannot be used means notifications show, the safe side, and it is kept under another
   * name, so the next click does not write over a list the person may want back. `onUnreadable` gets a fixed reason, never the content.
   * A version-1 file (0.2) is read as rows with no mailbox; the next change writes version 2.
   */
  async load(onUnreadable: (reason: string) => void): Promise<void> {
    try {
      if ((await stat(this.#path)).size > FILE_MAX_BYTES) {
        await this.#setAside(onUnreadable, "too-large");
        return;
      }
      const parsed = QuietFileSchema.safeParse(JSON.parse(await readFile(this.#path, "utf8")));
      if (parsed.success)
        this.#set(new Map(quietRows(parsed.data).map((row) => [row.value, row.source])));
      else await this.#setAside(onUnreadable, "invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.#setAside(onUnreadable, "unreadable");
    }
  }

  /** False when the list is full. A value already there is a success with no write, and keeps the mailbox it was first chosen in. */
  add(value: string, source?: string): Promise<boolean> {
    return this.#change((current) => {
      if (current.has(value)) return { next: null, result: true };
      if (current.size >= QUIET_MAX) return { next: null, result: false };
      return { next: new Map([...current, [value, source]]), result: true };
    });
  }

  remove(value: string): Promise<boolean> {
    return this.#change((current) => {
      if (!current.has(value)) return { next: null, result: true };
      const next = new Map(current);
      next.delete(value);
      return { next, result: true };
    });
  }

  #set(rows: Rows): void {
    this.#rows = rows;
    this.#entries = new Set(rows.keys());
  }

  /** The new list takes effect once it is on disk, so a failed save never shows as a choice that a restart would lose. */
  #change(plan: (current: Rows) => { next: Rows | null; result: boolean }): Promise<boolean> {
    const write = async (): Promise<boolean> => {
      const { next, result } = plan(this.#rows);
      if (next !== null) {
        const entries = [...next].map(([value, source]) =>
          source === undefined ? { value } : { value, source },
        );
        await writeJsonAtomic(this.#path, { version: 2, entries });
        this.#set(next);
      }
      return result;
    };
    const run = this.#queue.then(write, write);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #setAside(onUnreadable: (reason: string) => void, reason: string): Promise<void> {
    onUnreadable(reason);
    await rename(this.#path, `${this.#path}.unreadable`).catch(() => undefined);
  }
}
