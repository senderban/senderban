import { readFile, stat } from "node:fs/promises";
import { GoogleClientFileSchema, GoogleClientInputSchema } from "@senderban/core";
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

/**
 * Written into the installer by the release build (scripts/write-builtin-client.mjs) next to the compiled app, never into the
 * repository. Google calls a desktop app a public client that "cannot keep secrets confidential"
 * (developers.google.com/identity/protocols/oauth2/native-app, read 2026-10-31), so the pair is no secret from a person who
 * installs the app; it only has to stay out of the repository's history.
 */
export const BUILTIN_CLIENT_FILE = "google-client.builtin.json";

const BuiltInClientSchema = GoogleClientInputSchema.pick({ clientId: true, clientSecret: true });

/** The client the installer came with. Absent, unreadable or not ours: no built-in client, and the person's own file is the only way. */
export async function loadBuiltInGoogleClient(
  path: string,
): Promise<{ readonly clientId: string; readonly clientSecret: string } | null> {
  try {
    if ((await stat(path)).size > FILE_MAX_BYTES) return null;
    const parsed = BuiltInClientSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The client every Google step uses: what the person saved wins, else the one the installer came with. */
export interface ActiveGoogleClient {
  readonly clientId: string;
  readonly getSecret: () => Promise<string>;
  /** The installer's client: the page offers the person's own as an option, not as a step. */
  readonly builtIn: boolean;
}

export async function activeGoogleClient(
  userPath: string,
  builtInPath?: string,
): Promise<ActiveGoogleClient | null> {
  // A file that is not ours throws here too: the tokens came from that client, so the built-in one must not stand in for it unseen.
  const file = await loadGoogleClient(userPath);
  if (file !== null) {
    return { clientId: file.clientId, getSecret: clientSecretGetter(file), builtIn: false };
  }
  const builtIn = builtInPath === undefined ? null : await loadBuiltInGoogleClient(builtInPath);
  if (builtIn === null) return null;
  const { clientId, clientSecret } = builtIn;
  return { clientId, getSecret: () => Promise.resolve(clientSecret), builtIn: true };
}
