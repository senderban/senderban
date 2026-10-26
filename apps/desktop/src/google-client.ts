import { readFile, stat } from "node:fs/promises";
import { GoogleClientFileSchema } from "@senderban/core";
import type { GoogleClientFile } from "@senderban/core";
import { decryptPassword, encryptPassword, writeJsonAtomic } from "./accounts-file.js";

// One ID (<= 128 characters) and one ciphertext (<= 8192): anything near this size is not our file.
const FILE_MAX_BYTES = 16_384;

/** Missing file = no client set up. A file that fails validation throws without echoing its content. */
export async function loadGoogleClient(path: string): Promise<GoogleClientFile | null> {
  try {
    if ((await stat(path)).size > FILE_MAX_BYTES)
      throw new Error("google client file is too large");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = GoogleClientFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error("google client file failed validation");
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
