import { readFile, stat, unlink } from "node:fs/promises";
import {
  ImapAccountConfigSchema,
  MAX_ACCOUNTS,
  NewAccountSchema,
  accountFromForm,
  isImapAccount,
  mailboxKey,
} from "@senderban/core";
import type { AccountAddInput, AccountConfig, NewAccount } from "@senderban/core";
import type { AccountCheckResult } from "./account-check.js";
import { encryptPassword, loadAccounts, saveAccounts, serialized } from "./accounts-file.js";
import { accountTag } from "./log.js";

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
    throw new AddAccountError(`account ${accountTag(rest.id)} already exists`);
  const account = ImapAccountConfigSchema.parse({
    ...rest,
    passwordCipher: await encryptPassword(password),
  });
  await saveAccounts(accountsPath, [...existing, account]);
  await unlink(inputPath);
  return rest.id;
}

export type AccountAddResult = "saved" | "exists" | "limit" | Exclude<AccountCheckResult, "ok">;

/** Why this account cannot join the list, compared by mailbox as AccountsFileSchema does; null when it can. */
function refusal(accounts: readonly AccountConfig[], account: NewAccount): AccountAddResult | null {
  const mailbox = mailboxKey(account.imap.user);
  const taken = accounts.some(
    (a) =>
      a.id === account.id ||
      (isImapAccount(a) ? [a.imap.user, a.sieve.user] : [a.gmail.email]).some(
        (login) => mailboxKey(login.toLowerCase()) === mailbox,
      ),
  );
  if (taken) return "exists";
  return accounts.length >= MAX_ACCOUNTS ? "limit" : null;
}

/**
 * The form's way in: nothing is stored until both logins worked. The network step stays outside `serialized`, so a slow server
 * never holds up another writer of accounts.json; the list is read again inside, because it may have changed meanwhile.
 */
export async function addAccountFromForm(
  path: string,
  input: AccountAddInput,
  check: (account: NewAccount) => Promise<AccountCheckResult>,
): Promise<AccountAddResult> {
  const account = accountFromForm(input);
  const early = refusal(await loadAccounts(path), account);
  if (early !== null) return early;
  const checked = await check(account);
  if (checked !== "ok") return checked;
  const { password, ...rest } = account;
  const passwordCipher = await encryptPassword(password);
  return serialized(async () => {
    const accounts = await loadAccounts(path);
    const late = refusal(accounts, account);
    if (late !== null) return late;
    const stored = ImapAccountConfigSchema.parse({ ...rest, passwordCipher });
    await saveAccounts(path, [...accounts, stored]);
    return "saved";
  });
}
