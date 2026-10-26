import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { AccountsFileSchema } from "@senderban/core";
import type { AccountConfig } from "@senderban/core";
import { safeStorage } from "electron";

// 50 accounts x ~8 KiB of ciphertext is the worst case the schema allows; anything bigger is not ours.
const FILE_MAX_BYTES = 1_048_576;

/** Missing file = no accounts yet. A file that fails validation throws without echoing its content. */
export async function loadAccounts(path: string): Promise<AccountConfig[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (size > FILE_MAX_BYTES) throw new Error("accounts file is larger than any valid one");
  const parsed = AccountsFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error("accounts file failed validation");
  return parsed.data.accounts;
}

/** Writes beside the target and renames over it, so a crash never leaves a half-written file. */
export async function saveAccounts(
  path: string,
  accounts: readonly AccountConfig[],
): Promise<void> {
  await writeJsonAtomic(path, AccountsFileSchema.parse({ version: 1, accounts }));
}

/** The caller has validated `value`; this only writes it so that a crash never leaves half a file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    // Flushed before the rename: a power cut right after a save must not leave a renamed, empty file.
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

// Reading, changing and writing accounts.json is one step; two clicks must not interleave and lose one.
// One queue for every writer of the file (an MXroute key, a Gmail sign-in), or the two would lose each other's change.
let queue: Promise<unknown> = Promise.resolve();
export function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function requireEncryption(): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("OS-backed encryption is not available; refusing to store a password");
  }
}

export async function encryptPassword(plain: string): Promise<string> {
  await requireEncryption();
  return (await safeStorage.encryptStringAsync(plain)).toString("base64");
}

/** Called just before connecting; the result is never stored or logged. */
export async function decryptPassword(cipherBase64: string): Promise<string> {
  await requireEncryption();
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(cipherBase64, "base64"));
  return result;
}
