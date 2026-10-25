import { AdapterError, createMxrouteClient, validateDomain } from "@senderban/core";
import type { AccountConfig, MxrouteInput } from "@senderban/core";
import { encryptPassword, loadAccounts, saveAccounts } from "./accounts-file.js";

/** What the manage page may know about an account's MXroute key. The key itself never leaves this process. */
export interface MxroutePageAccount {
  readonly accountId: string;
  /** How the person knows the account (its mail address). */
  readonly label: string;
  readonly hasKey: boolean;
  /** The person turned the blacklist on for this account (takes effect when Senderban starts). */
  readonly enabled: boolean;
  readonly server: string | null;
  readonly username: string | null;
}

export type MxrouteSaveResult =
  | "saved"
  | "unknown-account"
  /** The account has no key to switch on or off. */
  | "no-key"
  /** The address of the account has no mail domain to put a blacklist on. */
  | "no-domain"
  /** MXroute answered and refused the key, user name or server. */
  | "key-refused"
  /** MXroute could not be reached or answered something unusable. */
  | "unreachable";

/** Asks MXroute to list the domain's blacklist with the typed key: the cheapest call that proves the key works. */
export type KeyCheck = (input: MxrouteInput, domain: string) => Promise<void>;

const checkWithMxroute: KeyCheck = async (input, domain) => {
  const client = createMxrouteClient({
    server: input.server,
    username: input.username,
    getKey: () => Promise.resolve(input.apiKey),
  });
  await client.list(domain);
};

// Reading, changing and writing accounts.json is one step; two clicks must not interleave and lose one.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/** Everything the page needs to draw the Advanced section: no ciphertext, no key. */
export async function listMxroute(path: string): Promise<MxroutePageAccount[]> {
  return (await loadAccounts(path)).map((a) => ({
    accountId: a.id,
    label: a.imap.user,
    hasKey: a.mxroute !== undefined,
    enabled: a.mxroute?.enabled ?? false,
    server: a.mxroute?.server ?? null,
    username: a.mxroute?.username ?? null,
  }));
}

function replaceAccount(
  accounts: readonly AccountConfig[],
  id: string,
  change: (account: AccountConfig) => AccountConfig,
): AccountConfig[] | null {
  if (!accounts.some((a) => a.id === id)) return null;
  return accounts.map((a) => (a.id === id ? change(a) : a));
}

/** The mail domain of an account (the part after the @ of its login), or null when it has none to use. */
export function mailDomain(account: AccountConfig): string | null {
  const domain = account.imap.user.split("@")[1];
  return domain !== undefined && validateDomain(domain.toLowerCase()) === null
    ? domain.toLowerCase()
    : null;
}

/**
 * Which MXroute blacklist an account writes to: (server, user name, mail domain), or null when it has no key or
 * no mail domain. Accounts with the same key string share one blacklist and so one engine lane.
 */
export function mxrouteGroupKey(account: AccountConfig): string | null {
  const domain = mailDomain(account);
  if (account.mxroute === undefined || domain === null) return null;
  return `${account.mxroute.server}|${account.mxroute.username}|${domain}`;
}

/**
 * Tries the key against MXroute first, then keeps it encrypted with the OS store (the same path as the mail
 * password). A key MXroute refuses is never stored. Replacing a key keeps the account's on/off choice.
 */
export async function saveMxroute(
  path: string,
  input: MxrouteInput,
  check: KeyCheck = checkWithMxroute,
): Promise<MxrouteSaveResult> {
  const account = (await loadAccounts(path)).find((a) => a.id === input.accountId);
  if (account === undefined) return "unknown-account";
  const domain = mailDomain(account);
  if (domain === null) return "no-domain";
  try {
    await check(input, domain);
  } catch (error) {
    const refused =
      error instanceof AdapterError &&
      (error.code === "AUTH_REQUIRED" || error.code === "REJECTED");
    return refused ? "key-refused" : "unreachable";
  }
  const apiKeyCipher = await encryptPassword(input.apiKey);
  return serialized(async () => {
    const next = replaceAccount(await loadAccounts(path), input.accountId, (a) => ({
      ...a,
      mxroute: {
        server: input.server,
        username: input.username,
        apiKeyCipher,
        enabled: a.mxroute?.enabled ?? false,
      },
    }));
    if (next === null) return "unknown-account";
    await saveAccounts(path, next);
    return "saved";
  });
}

/** Switches the blacklist lane of one account on or off; it takes effect when Senderban starts. */
export function setMxrouteEnabled(
  path: string,
  accountId: string,
  enabled: boolean,
): Promise<MxrouteSaveResult> {
  return serialized(async () => {
    const accounts = await loadAccounts(path);
    const account = accounts.find((a) => a.id === accountId);
    if (account === undefined) return "unknown-account";
    if (account.mxroute === undefined) return "no-key";
    const next = replaceAccount(accounts, accountId, (a) =>
      a.mxroute === undefined ? a : { ...a, mxroute: { ...a.mxroute, enabled } },
    );
    if (next === null) return "unknown-account";
    await saveAccounts(path, next);
    return "saved";
  });
}

/** Forgets the key on this device. It does not revoke it: that is done on panel.mxroute.com/api-keys.php. */
export function removeMxroute(path: string, accountId: string): Promise<MxrouteSaveResult> {
  return serialized(async () => {
    const accounts = await loadAccounts(path);
    const next = replaceAccount(accounts, accountId, (a) => {
      // Everything but the key stays, including any field the schema gains later.
      const rest = { ...a };
      delete rest.mxroute;
      return rest;
    });
    if (next === null) return "unknown-account";
    await saveAccounts(path, next);
    return "saved";
  });
}
