import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  ACTIVATION_KEY_BYTES,
  createActivationSigner,
  parseActivationKeyFile,
} from "@senderban/core";
import type { ActivationSigner } from "@senderban/core";
import { writeJsonAtomic } from "./accounts-file.js";

// One small file, read once at start. Unit: bytes. The ciphertext of 32 key bytes in hex is well under a kilobyte.
const FILE_MAX_BYTES = 4096;
const KEY_HEX = new RegExp(`^[0-9a-f]{${String(ACTIVATION_KEY_BYTES * 2)}}$`, "u");

/** What the key needs from the OS: `safeStorage` on the desktop, a stand-in in a test. */
export interface KeyVault {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<string>;
}

/** Why a new key was made: none existed yet, or the file could not be used (damaged, too big, or a ciphertext this account cannot open). */
export type NewKeyReason = "first" | "replaced";

async function readKey(path: string, vault: KeyVault): Promise<Buffer | "missing" | "bad"> {
  try {
    if ((await stat(path)).size > FILE_MAX_BYTES) return "bad";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "bad";
  }
  try {
    const cipher = parseActivationKeyFile(JSON.parse(await readFile(path, "utf8")));
    if (cipher === null) return "bad";
    const hex = await vault.decrypt(Buffer.from(cipher, "base64"));
    return KEY_HEX.test(hex) ? Buffer.from(hex, "hex") : "bad";
  } catch {
    // Unreadable, or a ciphertext this account cannot open: a new key then. The tails of toasts still on screen no longer verify, and a
    // click on one says "expired" (`tail-refused`, ignored-click.ts).
    return "bad";
  }
}

/**
 * The signer for the tails of toast clicks, from a key that lives only on this machine (ADR 0019). Made the first time and kept with the OS
 * (`safeStorage`, like the account passwords). Null when the OS cannot keep it or the file cannot be written: no toast then carries a
 * sender and none is taken back, the same as before a toast outlived the app.
 */
export async function loadActivationSigner(
  path: string,
  vault: KeyVault,
  onNewKey: (reason: NewKeyReason) => void = () => undefined,
): Promise<ActivationSigner | null> {
  try {
    if (!(await vault.available())) return null;
    const existing = await readKey(path, vault);
    if (Buffer.isBuffer(existing)) return createActivationSigner(existing);
    const key = randomBytes(ACTIVATION_KEY_BYTES);
    const cipher = await vault.encrypt(key.toString("hex"));
    await writeJsonAtomic(path, { version: 1, key: cipher.toString("base64") });
    onNewKey(existing === "missing" ? "first" : "replaced");
    return createActivationSigner(key);
  } catch {
    return null;
  }
}
