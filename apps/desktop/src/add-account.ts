import { readFile, stat, unlink } from "node:fs/promises";
import {
  CleanAccountConfigSchema,
  ImapAccountConfigSchema,
  MAX_ACCOUNTS,
  NewAccountSchema,
  accountFromForm,
  accountLogins,
  cleanAccountFromForm,
  mailboxKey,
} from "@senderban/core";
import type {
  AccountAddInput,
  AccountConfig,
  CleanAddInput,
  NewAccount,
  NewCleanAccount,
} from "@senderban/core";
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
  const refused = refusal(existing, parsed.data.id, parsed.data.imap.user);
  if (refused === "exists") {
    throw new AddAccountError(`account ${accountTag(rest.id)} already exists`);
  }
  if (refused !== null) throw new AddAccountError("no room for another account");
  const account = ImapAccountConfigSchema.parse({
    ...rest,
    passwordCipher: await encryptPassword(password),
  });
  await saveAccounts(accountsPath, [...existing, account]);
  await unlink(inputPath);
  return rest.id;
}

export type AccountAddResult =
  | "saved"
  /** Saved, and entries of the block list now reach the person's own mail, so they stop applying. */
  | "saved-own-entries"
  | "exists"
  | "limit"
  | Exclude<AccountCheckResult, "ok">;

export interface AccountAddSteps<A = NewAccount> {
  /** The person's own yes to sending this password to this server, asked by the main process. */
  readonly confirm: () => Promise<boolean>;
  readonly check: (account: A, signal: AbortSignal) => Promise<AccountCheckResult>;
  /** Runs once, after a save; true when list entries stopped applying. It must not throw: the account is stored by then. */
  readonly onSaved: () => Promise<boolean>;
  /** The person gave up (the window closed): nothing is stored from here on. */
  readonly signal: AbortSignal;
}

/** Why this account cannot join the list, compared by mailbox as AccountsFileSchema does; null when it can. */
function refusal(
  accounts: readonly AccountConfig[],
  id: string,
  address: string,
): AccountAddResult | null {
  const mailbox = mailboxKey(address);
  const taken = accounts.some(
    (a) => a.id === id || accountLogins(a).some((login) => mailboxKey(login) === mailbox),
  );
  if (taken) return "exists";
  return accounts.length >= MAX_ACCOUNTS ? "limit" : null;
}

/**
 * The form's way in: nothing is stored until both logins worked. The network step stays outside `serialized`, so a slow server
 * never holds up another writer of accounts.json; the list is read again inside, because it may have changed meanwhile.
 */
export function addAccountFromForm(
  path: string,
  input: AccountAddInput,
  steps: AccountAddSteps,
): Promise<AccountAddResult> {
  const account = accountFromForm(input);
  const { password, ...rest } = account;
  return addChecked(
    path,
    account,
    password,
    account.id,
    account.imap.user,
    steps,
    (passwordCipher) => ImapAccountConfigSchema.parse({ ...rest, passwordCipher }),
  );
}

/** The "Other (IMAP)" form: the same steps, one login, and no ManageSieve to reach. */
export function addCleanFromForm(
  path: string,
  input: CleanAddInput,
  steps: AccountAddSteps<NewCleanAccount>,
): Promise<AccountAddResult> {
  const account = cleanAccountFromForm(input);
  const { password, ...rest } = account;
  return addChecked(
    path,
    account,
    password,
    account.id,
    account.clean.address,
    steps,
    (passwordCipher) => CleanAccountConfigSchema.parse({ ...rest, passwordCipher }),
  );
}

async function addChecked<A>(
  path: string,
  account: A,
  password: string,
  id: string,
  address: string,
  steps: AccountAddSteps<A>,
  stored: (passwordCipher: string) => AccountConfig,
): Promise<AccountAddResult> {
  const early = refusal(await loadAccounts(path), id, address);
  if (early !== null) return early;
  const gaveUp = (): boolean => steps.signal.aborted;
  if (!(await steps.confirm()) || gaveUp()) return "cancelled";
  const checked = await steps.check(account, steps.signal);
  if (checked !== "ok") return checked;
  if (gaveUp()) return "cancelled";
  const passwordCipher = await encryptPassword(password);
  const saved = await serialized(async () => {
    if (gaveUp()) return "cancelled";
    const accounts = await loadAccounts(path);
    const late = refusal(accounts, id, address);
    if (late !== null) return late;
    await saveAccounts(path, [...accounts, stored(passwordCipher)]);
    return "saved" as const;
  });
  if (saved !== "saved") return saved;
  return (await steps.onSaved()) ? "saved-own-entries" : "saved";
}
