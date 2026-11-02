import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { ACTIVATION_KEY_BYTES, createActivationSigner } from "@senderban/core";
import type { ActivationSigner } from "@senderban/core";
import { writeJsonAtomic } from "./accounts-file.js";

// One small file, read once at start. Unit: bytes. The ciphertext of 32 key bytes in hex is well under a kilobyte.
const FILE_MAX_BYTES = 4096;
/** Unit: characters of base64 ciphertext. A hex key of 64 characters encrypts to about 100 on Windows (DPAPI); anything past this is not ours. */
const CIPHERTEXT_MAX = 2048;
const KEY_HEX = new RegExp(`^[0-9a-f]{${String(ACTIVATION_KEY_BYTES * 2)}}$`, "u");

/** The ciphertext (base64) of a well-formed key file, or null. The file is ours, but it sits in a folder other software can write to. */
function ciphertextOf(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const { version, key } = json as { version?: unknown; key?: unknown };
  if (version !== 1 || typeof key !== "string") return null;
  return key.length > 0 && key.length <= CIPHERTEXT_MAX ? key : null;
}

/** What the key needs from the OS: `safeStorage` on the desktop, a stand-in in a test. */
export interface KeyVault {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<string>;
}

async function readKey(path: string, vault: KeyVault): Promise<Buffer | null> {
  try {
    if ((await stat(path)).size > FILE_MAX_BYTES) return null;
    const cipher = ciphertextOf(JSON.parse(await readFile(path, "utf8")));
    if (cipher === null) return null;
    const hex = await vault.decrypt(Buffer.from(cipher, "base64"));
    return KEY_HEX.test(hex) ? Buffer.from(hex, "hex") : null;
  } catch {
    // Missing, unreadable, or a ciphertext this account cannot open: a new key then. The old toasts answer "expired".
    return null;
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
): Promise<ActivationSigner | null> {
  try {
    if (!(await vault.available())) return null;
    const existing = await readKey(path, vault);
    if (existing !== null) return createActivationSigner(existing);
    const key = randomBytes(ACTIVATION_KEY_BYTES);
    const cipher = await vault.encrypt(key.toString("hex"));
    await writeJsonAtomic(path, { version: 1, key: cipher.toString("base64") });
    return createActivationSigner(key);
  } catch {
    return null;
  }
}
