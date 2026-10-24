import { readFile, unlink } from "node:fs/promises";
import { AccountConfigSchema, NewAccountSchema } from "@senderban/core";
import { encryptPassword, loadAccounts, saveAccounts } from "./accounts-file.js";

// Bootstrap until there is a settings window: `electron . --add-account=<file.json>`. The file
// holds the plaintext password, so it is deleted as soon as the encrypted copy is saved.
export async function addAccountFromFile(inputPath: string, accountsPath: string): Promise<string> {
  const parsed = NewAccountSchema.safeParse(JSON.parse(await readFile(inputPath, "utf8")));
  if (!parsed.success) throw new Error("account file failed validation");
  const { password, ...rest } = parsed.data;

  const existing = await loadAccounts(accountsPath);
  if (existing.some((a) => a.id === rest.id)) throw new Error(`account ${rest.id} already exists`);
  const account = AccountConfigSchema.parse({
    ...rest,
    passwordCipher: await encryptPassword(password),
  });
  await saveAccounts(accountsPath, [...existing, account]);
  await unlink(inputPath);
  return rest.id;
}
