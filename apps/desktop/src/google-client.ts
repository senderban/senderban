import { readFile, stat } from "node:fs/promises";
import { GoogleClientFileSchema } from "@senderban/core";
import type { GoogleClientFile } from "@senderban/core";
import { decryptPassword, encryptPassword, writeJsonAtomic } from "./accounts-file.js";

// One ID (<= 128 characters) and one ciphertext (<= 8192): anything near this size is not our file.
const FILE_MAX_BYTES = 16_384;

/**
 * The file is there and is not ours (too large, not JSON, fails the schema). Only this counts as "unreadable client":
 * an I/O error (a virus scanner holding the file, a permission) is a passing state and surfaces as itself.
 */
export class ClientFileInvalid extends Error {}

/** Missing file = no client set up. An invalid file throws `ClientFileInvalid` without echoing its content. */
export async function loadGoogleClient(path: string): Promise<GoogleClientFile | null> {
  try {
    if ((await stat(path)).size > FILE_MAX_BYTES)
      throw new ClientFileInvalid("google client file is too large");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const text = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // A JSON.parse message quotes the input.
    throw new ClientFileInvalid("google client file is not valid JSON");
  }
  const parsed = GoogleClientFileSchema.safeParse(json);
  if (!parsed.success) throw new ClientFileInvalid("google client file failed validation");
  return parsed.data;
}

export async function saveGoogleClient(
  path: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const file = GoogleClientFileSchema.parse({
    version: 1,
    clientId,
    secretCipher: await encryptPassword(clientSecret),
  });
  await writeJsonAtomic(path, file);
}

/** Read per call and never held: the secret exists in memory only for the length of one request. */
export function clientSecretGetter(file: GoogleClientFile): () => Promise<string> {
  return () => decryptPassword(file.secretCipher);
}
