import { readFile, stat, unlink } from "node:fs/promises";
import { AccountConfigSchema, NewAccountSchema } from "@senderban/core";
import { encryptPassword, loadAccounts, saveAccounts } from "./accounts-file.js";

/** A file with one account in it is a few hundred bytes; anything past this is not one. */
export const ADD_ACCOUNT_FILE_MAX_BYTES = 16 * 1024;

/** An error whose message is fixed text, never input: only these may be logged as they are. */
export class AddAccountError extends Error {}

// A JSON.parse message quotes the input, and the input holds the plaintext password.
function parseAccountJson(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new AddAccountError("account file is not valid JSON");
  }
}

// Bootstrap until there is a settings window: `electron . --add-account=<file.json>`. The file
// holds the plaintext password, so it is deleted as soon as the encrypted copy is saved.
export async function addAccountFromFile(inputPath: string, accountsPath: string): Promise<string> {
  if ((await stat(inputPath)).size > ADD_ACCOUNT_FILE_MAX_BYTES) {
    throw new AddAccountError("account file is too large");
  }
  const parsed = NewAccountSchema.safeParse(parseAccountJson(await readFile(inputPath, "utf8")));
  if (!parsed.success) throw new AddAccountError("account file failed validation");
  const { password, ...rest } = parsed.data;

  const existing = await loadAccounts(accountsPath);
  if (existing.some((a) => a.id === rest.id))
    throw new AddAccountError(`account ${rest.id} already exists`);
  const account = AccountConfigSchema.parse({
    ...rest,
    passwordCipher: await encryptPassword(password),
  });
  await saveAccounts(accountsPath, [...existing, account]);
  await unlink(inputPath);
  return rest.id;
}
