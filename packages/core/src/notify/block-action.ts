import { randomUUID } from "node:crypto";
import { mailboxKey, validateDomain } from "../address.js";
import { folderAction } from "../blocklist.js";
import { canRefuseAtServer } from "../mxroute/client.js";
import type { BlockAction, BlockEntry } from "../blocklist.js";
import { isCountrySuffix, isFreemail } from "../freemail.js";
import type { Store } from "../store/store.js";
import type { SyncEngine, SyncOutcome } from "../sync/engine.js";
import type { PendingBlocks } from "./pending.js";

/** What the person chose in the popup: this mailbox, or the sender's whole domain (subdomains included). */
export const BLOCK_SCOPES = ["address", "domain"] as const;
export type BlockScope = (typeof BLOCK_SCOPES)[number];

/**
 * The domain a popup may offer to block for this sender, or null when it must not (a freemail
 * provider, a shape the block list would refuse, or a mail domain the person owns). Hiding the button is only a
 * courtesy: the list enforces the shape rule and `blockPending` the own-domain rule.
 */
export function blockableDomain(sender: string, own: OwnMail): string | null {
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  if (validateDomain(domain) !== null || isFreemail(domain) || isCountrySuffix(domain)) return null;
  if (isOwnDomain(domain, own)) return null;
  return domain;
}

/**
 * True when a rule on `domain` (subdomains included) would reach a mail domain the person owns: the domain itself, a
 * subdomain of it, or a parent of it. A spammer can forge the person's own domain in From; a domain rule would file
 * every colleague's mail away.
 */
function isOwnDomain(domain: string, own: OwnMail): boolean {
  const lower = domain.toLowerCase();
  for (const owned of own.domains) {
    if (lower === owned || lower.endsWith(`.${owned}`) || owned.endsWith(`.${lower}`)) return true;
  }
  return false;
}

/**
 * What is the person's own: login addresses as mailbox keys (`mailboxKey`: the lowercase address, with Gmail's dot, +tag and
 * googlemail.com spellings folded into one), and the mail domains of those accounts (never a freemail domain).
 */
export interface OwnMail {
  readonly domains: ReadonlySet<string>;
  readonly addresses: ReadonlySet<string>;
}

/**
 * True when the address is one of the person's own mailboxes. By mailbox, not by text: a forged `m.e@gmail.com` is the
 * person's own `me@gmail.com` to Gmail. Domains are not looked at: only the exact mailbox is "me".
 */
export function isOwnMailbox(address: string, own: OwnMail): boolean {
  const lower = address.toLowerCase();
  return own.addresses.has(lower) || own.addresses.has(mailboxKey(lower));
}

/**
 * True for a list entry that reaches the person's own mail: one of their mailboxes, or a domain rule over one of their mail
 * domains. `blockPending` refuses these at the click; the engine also leaves them out of every plan, so an entry stored before
 * that rule (or written by hand) never files the person's own mail away.
 */
export function isOwnEntry(entry: Pick<BlockEntry, "match" | "value">, own: OwnMail): boolean {
  return entry.match === "exactAddress"
    ? isOwnMailbox(entry.value, own)
    : isOwnDomain(entry.value, own);
}

/**
 * True when "Block at server" may be offered and run for this sender: the blacklist can take the address as a
 * single entry, and it is neither one of the person's own addresses nor on a mail domain they own. A spammer can
 * forge the From of the person's own address or a colleague's; refusing that at the server would bounce their real
 * mail with no copy kept. Domains the account has that Senderban is not told about are not covered (ADR 0008).
 */
export function canRejectSender(sender: string, own: OwnMail): boolean {
  if (!canRefuseAtServer(sender)) return false;
  const lower = sender.toLowerCase();
  if (isOwnMailbox(sender, own)) return false;
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  for (const owned of own.domains) {
    if (domain === owned || domain.endsWith(`.${owned}`)) return false;
  }
  return true;
}

export interface BlockActionDeps {
  readonly pending: PendingBlocks;
  readonly store: Pick<Store, "add" | "list">;
  readonly engine: Pick<SyncEngine, "sync" | "requestSync" | "verify">;
  /** The person's own mailbox keys and domains, lowercase: never refused at the server. Required, so a caller cannot forget it. */
  readonly own: OwnMail;
  /** Every account on this device: the list is global, so each one must pick the new entry up. */
  readonly accountIds: readonly string[];
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Called as soon as the click is matched to its account, before any sync runs. */
  readonly onClaimed?: (accountId: string) => void;
  /**
   * True for an account whose rules can only be single addresses moved to Trash (Gmail filters). A click that came from such an
   * account is held to that whatever the OS reported (a click does not have to match the toast): the action becomes Trash, a
   * whole-domain click is refused. Absent: no account is limited.
   */
  readonly trashOnlyAccount?: (accountId: string) => boolean;
}

/** What a choice led to. `detail` is shown to the person, so it carries no password or full server reply. */
export type BlockResult =
  | { readonly status: "duplicate" }
  | { readonly status: "unknown" }
  /** The target is already blocked, or covered by a rule that wins; `action` is where its mail really goes. */
  | { readonly status: "already-blocked"; readonly target: string; readonly action: BlockAction }
  | { readonly status: "refused"; readonly detail: string }
  /** The rule was written; `verified` says whether reading it back from the provider confirmed it. */
  | {
      readonly status: "blocked";
      readonly target: string;
      readonly action: BlockAction;
      /** True only for `accountId`: the other accounts are updated in the background and not read back. */
      readonly verified: boolean;
      readonly detail: string;
      /** The account the person clicked on, the only one that was read back. */
      readonly accountId: string;
      /** Accounts that were only queued (debounced sync); their outcome arrives later. */
      readonly otherAccounts: number;
    }
  | {
      readonly status: "not-applied";
      readonly target: string;
      readonly detail: string;
      readonly accountId: string;
    };

/** True when `entry` would match mail from `sender` (an address) or from every sender of `domain`. */
function covers(entry: BlockEntry, match: "exactAddress" | "subdomains", value: string): boolean {
  if (entry.match === "exactAddress") return match === "exactAddress" && entry.value === value;
  const domain = match === "exactAddress" ? value.slice(value.lastIndexOf("@") + 1) : value;
  if (domain === entry.value) return true;
  return entry.match === "subdomains" && domain.endsWith(`.${entry.value}`);
}

function describeSync(outcome: SyncOutcome): string | null {
  switch (outcome.status) {
    case "unchanged":
    case "applied":
      return null;
    case "partial":
      return `${String(outcome.failed)} change(s) failed`;
    case "failed":
      return `${outcome.code}: ${outcome.message}`;
  }
}

/**
 * A click in the popup: look the sender up by notification id, add the chosen entry to the list,
 * write the rule to the clicked account at once and to the others through the debounce, then read
 * the clicked account back. The id is consumed exactly once, so a double click blocks once.
 * `action` is where the mail goes: Junk (default) or Trash. Both keep the mail, so both are reversible.
 */
export async function blockPending(
  deps: BlockActionDeps,
  id: string,
  scope: BlockScope,
  requested: BlockAction = "junk",
): Promise<BlockResult> {
  const claimed = deps.pending.consume(id);
  if (claimed.status !== "ok") return { status: claimed.status };

  const { accountId, sender } = claimed.block;
  deps.onClaimed?.(accountId);
  const trashOnly = deps.trashOnlyAccount?.(accountId) === true;
  if (trashOnly && scope === "domain") {
    return { status: "refused", detail: "a Gmail filter takes single addresses only" };
  }
  // The list is global, so an own address blocked from one account would file the person's own mail away on every other
  // (and the Gmail filter lane refuses it anyway): never on any account. A forged own From is the server's job (SPF/DMARC).
  if (isOwnMailbox(sender, deps.own)) {
    return { status: "refused", detail: "this is one of your own addresses" };
  }
  if (scope === "domain" && isOwnDomain(sender.slice(sender.lastIndexOf("@") + 1), deps.own)) {
    return { status: "refused", detail: "this domain would reach one of your own mail domains" };
  }
  const action: BlockAction = trashOnly ? "trash" : requested;
  const target = scope === "domain" ? blockableDomain(sender, deps.own) : sender;
  if (target === null) {
    return { status: "refused", detail: "this domain cannot be blocked as a whole" };
  }

  // A whole domain is never refused at the server (its reach on the blacklist is not measured): refuse here,
  // whatever a caller passes, so a `reject` domain entry cannot be stored.
  if (action === "reject" && scope === "domain") {
    return { status: "refused", detail: "a whole domain cannot be refused at the server" };
  }

  if (action === "reject" && !canRejectSender(target, deps.own)) {
    return { status: "refused", detail: "this address cannot be refused at the server" };
  }

  const match = scope === "domain" ? "subdomains" : "exactAddress";
  // Junk rules (a `reject` entry is filed like Junk) are written first and each one stops, so Junk wins wherever
  // both would match. Say so instead of reporting a Trash rule that never fires.
  if (action === "trash") {
    // A Gmail click is the exception for a domain winner: a domain rule never reaches Gmail, so the address entry is
    // still needed there (on Sieve the domain's Junk rule keeps winning).
    const winner = deps.store.list().find(
      (e) =>
        folderAction(e.action) === "junk" &&
        // An entry over the person's own mail is never written (SyncEngine `exclude`): it wins nothing.
        !isOwnEntry(e, deps.own) &&
        covers(e, match, target) &&
        (!trashOnly || e.match === "exactAddress"),
    );
    if (winner !== undefined) {
      return { status: "already-blocked", target: winner.value, action: winner.action };
    }
  }

  const added = deps.store.add({
    id: (deps.newId ?? randomUUID)(),
    match,
    value: target,
    action,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (!added.ok) return { status: "refused", detail: added.reason };
  if (!added.added && added.entry.action !== action) {
    return { status: "already-blocked", target, action: added.entry.action };
  }

  const outcome = await deps.engine.sync(accountId);
  let otherAccounts = 0;
  for (const other of deps.accountIds) {
    if (other === accountId) continue;
    deps.engine.requestSync(other);
    otherAccounts += 1;
  }

  const problem = describeSync(outcome);
  if (problem !== null) return { status: "not-applied", target, detail: problem, accountId };

  const check = await deps.engine.verify(accountId);
  switch (check.status) {
    case "verified":
      return {
        status: "blocked",
        target,
        action,
        verified: true,
        detail: "read back from the provider",
        accountId,
        otherAccounts,
      };
    case "drifted":
      return {
        status: "blocked",
        target,
        action,
        verified: false,
        detail: `read-back differs: ${check.detail}`,
        accountId,
        otherAccounts,
      };
    case "failed":
      return {
        status: "blocked",
        target,
        action,
        verified: false,
        detail: `rule written, read-back failed: ${check.code}`,
        accountId,
        otherAccounts,
      };
  }
}
