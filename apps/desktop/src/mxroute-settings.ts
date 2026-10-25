import type { AccountConfig, MxrouteInput } from "@senderban/core";
import { encryptPassword, loadAccounts, saveAccounts } from "./accounts-file.js";

/** What the manage page may know about an account's MXroute key. The key itself never leaves this process. */
export interface MxroutePageAccount {
  readonly accountId: string;
  /** How the person knows the account (its mail address). */
  readonly label: string;
  readonly hasKey: boolean;
  readonly server: string | null;
  readonly username: string | null;
}

export type MxrouteSaveResult = "saved" | "unknown-account";

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

/** Encrypts the key with the OS store and keeps only the ciphertext (the same path as the mail password). */
export function saveMxroute(path: string, input: MxrouteInput): Promise<MxrouteSaveResult> {
  return serialized(async () => {
    const accounts = await loadAccounts(path);
    const apiKeyCipher = await encryptPassword(input.apiKey);
    const next = replaceAccount(accounts, input.accountId, (a) => ({
      ...a,
      mxroute: { server: input.server, username: input.username, apiKeyCipher },
    }));
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
