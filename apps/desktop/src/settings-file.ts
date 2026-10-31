import { readFile, stat } from "node:fs/promises";
import { DEFAULT_SETTINGS, SettingsFileSchema } from "@senderban/core";
import type { Settings } from "@senderban/core";
import { writeJsonAtomic } from "./accounts-file.js";

// Four short keys; anything bigger is not ours. Unit: bytes.
const FILE_MAX_BYTES = 4_096;

/**
 * The Settings page's choices (ADR 0015). Scale: one read at start, one write per click, no provider call; a toast reads the copy in
 * memory. Saves wait for each other, so two quick clicks cannot land out of order.
 */
export class SettingsStore {
  readonly #path: string;
  #current: Settings = DEFAULT_SETTINGS;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  get current(): Settings {
    return this.#current;
  }

  /**
   * A missing file is a first start. A file that cannot be used is not worth stopping for: the page still works, so the defaults
   * apply, and `onUnreadable` gets a fixed reason, never the content.
   */
  async load(onUnreadable: (reason: string) => void): Promise<void> {
    try {
      if ((await stat(this.#path)).size > FILE_MAX_BYTES) {
        onUnreadable("too-large");
        return;
      }
      const parsed = SettingsFileSchema.safeParse(JSON.parse(await readFile(this.#path, "utf8")));
      if (parsed.success) this.#current = parsed.data.settings;
      else onUnreadable("invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      onUnreadable("unreadable");
    }
  }

  /** The new values take effect once they are on disk, so a failed save never shows as a choice that a restart would lose. */
  save(next: Settings): Promise<void> {
    const write = async (): Promise<void> => {
      await writeJsonAtomic(this.#path, { version: 1, settings: next });
      this.#current = next;
    };
    const run = this.#queue.then(write, write);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
