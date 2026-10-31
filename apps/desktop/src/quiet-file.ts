import { readFile, rename, stat } from "node:fs/promises";
import { QUIET_ENTRY_MAX, QUIET_MAX, QuietFileSchema } from "@senderban/core";
import { writeJsonAtomic } from "./accounts-file.js";

// Every entry at its longest, with its indent, quotes, comma and line end. Unit: bytes.
const FILE_MAX_BYTES = QUIET_MAX * (QUIET_ENTRY_MAX + 8) + 64;

/**
 * The "Don't ask again" list (ADR 0016). Scale: one read at start, one write per click, a lookup in memory per announced mail. Saves
 * wait for each other, so two quick clicks cannot lose one.
 */
export class QuietStore {
  readonly #path: string;
  #entries: ReadonlySet<string> = new Set();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  get entries(): ReadonlySet<string> {
    return this.#entries;
  }

  /**
   * A missing file is a first start. A file that cannot be used means notifications show, the safe side, and it is kept under another
   * name, so the next click does not write over a list the person may want back. `onUnreadable` gets a fixed reason, never the content.
   */
  async load(onUnreadable: (reason: string) => void): Promise<void> {
    try {
      if ((await stat(this.#path)).size > FILE_MAX_BYTES) {
        await this.#setAside(onUnreadable, "too-large");
        return;
      }
      const parsed = QuietFileSchema.safeParse(JSON.parse(await readFile(this.#path, "utf8")));
      if (parsed.success) this.#entries = new Set(parsed.data.entries);
      else await this.#setAside(onUnreadable, "invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.#setAside(onUnreadable, "unreadable");
    }
  }

  /** False when the list is full. A value already there is a success with no write. */
  add(value: string): Promise<boolean> {
    return this.#change((current) => {
      if (current.has(value)) return { next: null, result: true };
      if (current.size >= QUIET_MAX) return { next: null, result: false };
      return { next: new Set([...current, value]), result: true };
    });
  }

  remove(value: string): Promise<boolean> {
    return this.#change((current) => {
      if (!current.has(value)) return { next: null, result: true };
      const next = new Set(current);
      next.delete(value);
      return { next, result: true };
    });
  }

  /** The new list takes effect once it is on disk, so a failed save never shows as a choice that a restart would lose. */
  #change(
    plan: (current: ReadonlySet<string>) => {
      next: ReadonlySet<string> | null;
      result: boolean;
    },
  ): Promise<boolean> {
    const write = async (): Promise<boolean> => {
      const { next, result } = plan(this.#entries);
      if (next !== null) {
        await writeJsonAtomic(this.#path, { version: 1, entries: [...next] });
        this.#entries = next;
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
