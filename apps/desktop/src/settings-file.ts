import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, SettingsSchema } from "@senderban/core";
import type { Settings } from "@senderban/core";

// A valid settings file is a few dozen bytes; anything bigger is not ours.
const FILE_MAX_BYTES = 4096;

/** Missing file = defaults. A file that fails validation throws without echoing its content. */
export async function loadSettings(path: string): Promise<Settings> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw error;
  }
  if (size > FILE_MAX_BYTES) throw new Error("settings file is larger than any valid one");
  const parsed = SettingsSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error("settings file failed validation");
  return parsed.data;
}

/** Writes beside the target and renames over it, so a crash never leaves a half-written file. */
export async function saveSettings(path: string, settings: Settings): Promise<void> {
  const file = SettingsSchema.parse(settings);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(file, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
