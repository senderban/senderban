import { readFile, stat } from "node:fs/promises";
import {
  AdapterError,
  MXROUTE_KEY_LIMITS,
  MxrouteKeysFileSchema,
  createMxrouteClient,
  isImapAccount,
  mxrouteLaneId,
  mxrouteStateHolds,
  validateDomain,
} from "@senderban/core";
import type {
  AccountConfig,
  ImapAccountConfig,
  MxrouteCall,
  MxrouteEnableInput,
  MxrouteInput,
  MxrouteKeyRef,
  MxrouteStoredKey,
  OpaqueState,
} from "@senderban/core";
import {
  decryptPassword,
  encryptPassword,
  loadAccounts,
  saveAccounts,
  serialized,
  writeJsonAtomic,
} from "./accounts-file.js";

// 50 keys x (~8 KiB of ciphertext + 50 domains of ~290 bytes) is the worst case the schema allows (~1.15 MB).
const KEYS_FILE_MAX_BYTES = 2_097_152;

/** One mailbox, as the page knows it. */
export interface MxroutePageAccount {
  readonly accountId: string;
  /** How the person knows the account (its mail address). */
  readonly label: string;
}

/** What the page may know about a key. The key itself never leaves this process. */
export interface MxroutePageKey {
  readonly server: string;
  readonly username: string;
  /** Its domains, and any mailbox domain no key holds yet: the person can switch it on here. */
  readonly domains: readonly { readonly domain: string; readonly enabled: boolean }[];
}

export interface MxroutePage {
  readonly accounts: readonly MxroutePageAccount[];
  readonly keys: readonly MxroutePageKey[];
  /** The key file is there but cannot be read. The mailbox list still works without it. */
  readonly keysUnreadable: boolean;
}

export type MxrouteSaveResult =
  | "saved"
  /** No key is stored for that server and user name. */
  | "unknown-key"
  /** No mailbox is on that domain, or another key holds it. */
  | "unknown-domain"
  /** The most keys, or the most domains on one key, that the file holds. */
  | "full"
  /** MXroute answered and refused the key, user name or server. */
  | "key-refused"
  /** MXroute could not be reached or answered something unusable. */
  | "unreachable"
  /** The person said no. */
  | "cancelled";

/** Asks MXroute for the login's domains with the typed key: the cheapest call that proves it, and no mailbox is needed. */
export type KeyCheck = (input: MxrouteInput) => Promise<void>;
/** Asks MXroute for the domain's blacklist with the stored key: can this key reach this domain? */
export type DomainCheck = (key: MxrouteStoredKey, domain: string) => Promise<void>;

/** Hears the operation, HTTP status and duration of a check: no key, no address. */
type OnCall = (call: MxrouteCall) => void;

export const keyCheck =
  (onCall?: OnCall): KeyCheck =>
  async (input) => {
    const client = createMxrouteClient({
      server: input.server,
      username: input.username,
      getKey: () => Promise.resolve(input.apiKey),
      ...(onCall === undefined ? {} : { onCall }),
    });
    await client.domains();
  };

export const domainCheck =
  (onCall?: OnCall): DomainCheck =>
  async (key, domain) => {
    const client = createMxrouteClient({
      server: key.server,
      username: key.username,
      getKey: () => decryptPassword(key.apiKeyCipher),
      ...(onCall === undefined ? {} : { onCall }),
    });
    await client.list(domain);
  };

/** A failed check as a fixed word. */
function checkFailed(error: unknown): "key-refused" | "unreachable" {
  const refused =
    error instanceof AdapterError && (error.code === "AUTH_REQUIRED" || error.code === "REJECTED");
  return refused ? "key-refused" : "unreachable";
}

/** Missing file = no key yet. A file that fails validation throws without echoing its content. */
export async function loadMxrouteKeys(path: string): Promise<MxrouteStoredKey[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (size > KEYS_FILE_MAX_BYTES) throw new Error("key file is larger than any valid one");
  const text = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // A JSON.parse message quotes the input.
    throw new Error("key file is not valid JSON");
  }
  const parsed = MxrouteKeysFileSchema.safeParse(json);
  if (!parsed.success) throw new Error("key file failed validation");
  return parsed.data.keys;
}

function saveMxrouteKeys(path: string, keys: readonly MxrouteStoredKey[]): Promise<void> {
  return writeJsonAtomic(path, MxrouteKeysFileSchema.parse({ version: 1, keys }));
}

const sameKey = (a: MxrouteKeyRef, b: MxrouteKeyRef): boolean =>
  a.server === b.server && a.username === b.username;

/** The mail domain of an account (the part after the @ of its login), or null when it has none to use. */
export function mailDomain(account: ImapAccountConfig): string | null {
  const domain = account.imap.user.split("@")[1];
  return domain !== undefined && validateDomain(domain.toLowerCase()) === null
    ? domain.toLowerCase()
    : null;
}

/** One blacklist in use: a domain under a key, with the mailboxes on it. One of them owns the engine lane. */
export interface MxrouteGroup {
  readonly key: MxrouteStoredKey;
  readonly domain: string;
  readonly owner: string;
  readonly members: readonly string[];
  readonly mirror: boolean;
}

/**
 * The blacklist of each mailbox, by account id. One lane per domain: the blacklist belongs to the domain, so five
 * mailboxes on it would otherwise send the same entries five times. A domain with no mailbox left has no lane.
 */
export function mxrouteGroups(
  keys: readonly MxrouteStoredKey[],
  accounts: readonly ImapAccountConfig[],
  hasLaneState: (accountId: string) => boolean = () => false,
): Map<string, MxrouteGroup> {
  const onDomain = new Map<string, string[]>();
  for (const account of accounts) {
    const domain = mailDomain(account);
    if (domain === null) continue;
    onDomain.set(domain, [...(onDomain.get(domain) ?? []), account.id]);
  }
  const groups = new Map<string, MxrouteGroup>();
  for (const key of keys) {
    for (const { domain, enabled } of key.domains) {
      const members = onDomain.get(domain);
      // The mailbox with the lane's record keeps it (0.1.2 gave the lane to the first mailbox with a key): a new owner
      // would start empty and could no longer take back what the old lane put on the blacklist.
      const owner = members?.find(hasLaneState) ?? members?.[0];
      if (members === undefined || owner === undefined) continue;
      const group = { key, domain, owner, members, mirror: enabled };
      for (const id of members) groups.set(id, group);
    }
  }
  return groups;
}

/** Everything the page needs to draw the Advanced section: no ciphertext, no key. */
export async function listMxroute(keysPath: string, accountsPath: string): Promise<MxroutePage> {
  const accounts = (await loadAccounts(accountsPath)).filter(isImapAccount);
  const page = accounts.map((a) => ({ accountId: a.id, label: a.imap.user }));
  let keys: MxrouteStoredKey[];
  try {
    keys = await loadMxrouteKeys(keysPath);
  } catch {
    return { accounts: page, keys: [], keysUnreadable: true };
  }
  const held = new Set(keys.flatMap((k) => k.domains.map((d) => d.domain)));
  const unheld = [...new Set(accounts.map(mailDomain))].filter(
    (d): d is string => d !== null && !held.has(d),
  );
  return {
    accounts: page,
    keys: keys.map((k) => ({
      server: k.server,
      username: k.username,
      domains: [...k.domains, ...unheld.map((domain) => ({ domain, enabled: false }))],
    })),
    keysUnreadable: false,
  };
}

/**
 * Tries the key against MXroute first, then keeps it encrypted with the OS store (the same path as the mail
 * password). A key MXroute refuses is never stored. Saving for the same login replaces the key and keeps its domains.
 */
export async function saveMxroute(
  path: string,
  input: MxrouteInput,
  check: KeyCheck = keyCheck(),
): Promise<MxrouteSaveResult> {
  try {
    await check(input);
  } catch (error) {
    return checkFailed(error);
  }
  const apiKeyCipher = await encryptPassword(input.apiKey);
  return serialized(async () => {
    const keys = await loadMxrouteKeys(path);
    const known = keys.some((k) => sameKey(k, input));
    if (!known && keys.length >= MXROUTE_KEY_LIMITS.keys.max) return "full";
    const { server, username } = input;
    await saveMxrouteKeys(
      path,
      known
        ? keys.map((k) => (sameKey(k, input) ? { ...k, apiKeyCipher } : k))
        : [...keys, { server, username, apiKeyCipher, domains: [] }],
    );
    return "saved";
  });
}

/**
 * Switches one domain's blacklist on or off; it takes effect when Senderban starts. The first time on, MXroute is asked
 * whether this key reaches the domain, and the domain must be one of the person's mailboxes: the page names it, so the
 * page is not trusted with it. A domain switched off stays on the key: its lane takes back what it added.
 */
export async function setMxrouteEnabled(
  keysPath: string,
  accountsPath: string,
  input: MxrouteEnableInput,
  check: DomainCheck = domainCheck(),
): Promise<MxrouteSaveResult> {
  const keys = await loadMxrouteKeys(keysPath);
  const key = keys.find((k) => sameKey(k, input));
  if (key === undefined) return "unknown-key";
  const { domain, enabled } = input;
  const holds = (k: MxrouteStoredKey): boolean => k.domains.some((d) => d.domain === domain);
  if (keys.some((k) => k !== key && holds(k))) return "unknown-domain";
  if (!holds(key)) {
    if (!enabled) return "saved";
    const accounts = (await loadAccounts(accountsPath)).filter(isImapAccount);
    if (!accounts.some((a) => mailDomain(a) === domain)) return "unknown-domain";
    try {
      await check(key, domain);
    } catch (error) {
      return checkFailed(error);
    }
  }
  return serialized(async () => {
    const fresh = await loadMxrouteKeys(keysPath);
    const current = fresh.find((k) => sameKey(k, input));
    if (current === undefined) return "unknown-key";
    // Again: the first answer may be out of date after the check, and the file refuses a domain on two keys.
    if (fresh.some((k) => k !== current && holds(k))) return "unknown-domain";
    if (!holds(current) && current.domains.length >= MXROUTE_KEY_LIMITS.domains.max) return "full";
    const domains = holds(current)
      ? current.domains.map((d) => (d.domain === domain ? { domain, enabled } : d))
      : [...current.domains, { domain, enabled }];
    await saveMxrouteKeys(
      keysPath,
      fresh.map((k) => (k === current ? { ...k, domains } : k)),
    );
    return "saved";
  });
}

/**
 * Forgets the key on this device, after the person's yes: without it Unblock can no longer reach the blacklist. It does
 * not revoke the key: that is done on panel.mxroute.com/api-keys.php. A copy that a failed move left inside a mailbox goes
 * first, or the next start would bring the key back.
 */
export async function removeMxroute(
  path: string,
  accountsPath: string,
  ref: MxrouteKeyRef,
  confirm: () => Promise<boolean>,
): Promise<MxrouteSaveResult> {
  // Outside the queue: a question left open must not hold up every other write of accounts.json.
  if (!(await loadMxrouteKeys(path)).some((k) => sameKey(k, ref))) return "unknown-key";
  if (!(await confirm())) return "cancelled";
  return serialized(async () => {
    const keys = await loadMxrouteKeys(path);
    if (!keys.some((k) => sameKey(k, ref))) return "unknown-key";
    const accounts = await loadAccounts(accountsPath);
    const holds = (a: AccountConfig): boolean =>
      isImapAccount(a) && a.mxroute !== undefined && sameKey(a.mxroute, ref);
    if (accounts.some(holds)) {
      await saveAccounts(
        accountsPath,
        accounts.map((a) => (holds(a) ? withoutKey(a) : a)),
      );
    }
    await saveMxrouteKeys(
      path,
      keys.filter((k) => !sameKey(k, ref)),
    );
    return "saved";
  });
}

/**
 * True when a blacklist with no running lane still holds the address: Unblock cannot take it off, and its mail goes on
 * being refused. The stored state of the lane is the record, and it outlives the key.
 */
export function strandedOnBlacklist(
  value: string,
  accountIds: readonly string[],
  liveLanes: readonly string[],
  getState: (laneId: string) => OpaqueState | undefined,
): boolean {
  return accountIds.some((id) => {
    const laneId = mxrouteLaneId(id);
    if (liveLanes.includes(laneId)) return false;
    const state = getState(laneId);
    return state !== undefined && mxrouteStateHolds(state, value);
  });
}

/**
 * True when nothing tends the account's blacklist any more: a key holds its domain, and no mailbox is left on it. Asked
 * after the account left the file. The key stays either way; only the person removes it.
 */
export async function blacklistOutlives(
  keysPath: string,
  accountsPath: string,
  account: ImapAccountConfig,
): Promise<boolean> {
  const domain = mailDomain(account);
  if (domain === null) return false;
  const keys = await loadMxrouteKeys(keysPath);
  if (!keys.some((k) => k.domains.some((d) => d.domain === domain))) return false;
  const left = (await loadAccounts(accountsPath)).filter(isImapAccount);
  return !left.some((a) => mailDomain(a) === domain);
}

/**
 * The keys that 0.1.2 and older stored inside mailboxes, added to `keys`. The first of two for one login wins. A domain
 * already in `keys` keeps what the person chose there: a copy left by a failed move is older than that choice.
 */
export function keysFromAccounts(
  accounts: readonly ImapAccountConfig[],
  keys: readonly MxrouteStoredKey[],
): MxrouteStoredKey[] {
  const next = keys.map((k) => ({ ...k, domains: [...k.domains] }));
  const chosen = new Set(keys.flatMap((k) => k.domains.map((d) => d.domain)));
  for (const account of accounts) {
    const { mxroute } = account;
    if (mxroute === undefined) continue;
    let key = next.find((k) => sameKey(k, mxroute));
    if (key === undefined) {
      const { server, username, apiKeyCipher } = mxroute;
      key = { server, username, apiKeyCipher, domains: [] };
      next.push(key);
    }
    const domain = mailDomain(account);
    if (domain === null || chosen.has(domain)) continue;
    const holder = next.find((k) => k.domains.some((d) => d.domain === domain));
    if (holder === undefined) {
      key.domains.push({ domain, enabled: mxroute.enabled });
    } else if (mxroute.enabled) {
      // Several mailboxes shared one blacklist: it was on when any of them had it on, under either login.
      holder.domains = holder.domains.map((d) =>
        d.domain === domain ? { domain, enabled: true } : d,
      );
    }
  }
  return next;
}

/**
 * Moves keys out of the mailboxes, once. The key file is written first: a crash in between leaves both, and the next
 * start merges again. Returns how many mailboxes held one.
 */
export function migrateMxrouteKeys(keysPath: string, accountsPath: string): Promise<number> {
  return serialized(async () => {
    const accounts = await loadAccounts(accountsPath);
    const holders = accounts.filter(isImapAccount).filter((a) => a.mxroute !== undefined);
    if (holders.length === 0) return 0;
    await saveMxrouteKeys(keysPath, keysFromAccounts(holders, await loadMxrouteKeys(keysPath)));
    await saveAccounts(accountsPath, accounts.map(withoutKey));
    return holders.length;
  });
}

function withoutKey(account: AccountConfig): AccountConfig {
  if (!isImapAccount(account)) return account;
  // Everything but the key stays, including any field the schema gains later.
  const rest = { ...account };
  delete rest.mxroute;
  return rest;
}
