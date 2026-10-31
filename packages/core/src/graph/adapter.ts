import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  AdapterError,
  type ApplyResult,
  type BlockAdapter,
  type Capabilities,
  type Drift,
  type OpaqueState,
  type Plan,
  type PlannedChange,
} from "../adapter.js";
import { checkEntry, folderAction } from "../blocklist.js";
import type { BlockEntry, Blocklist } from "../blocklist.js";
import { freemailDomains, hasKnownTop, isPublicSuffix } from "../freemail.js";
import type { OwnMail } from "../notify/block-action.js";
import { GRAPH_ID, RuleRefusedError, RuleSpaceError } from "./client.js";
import type {
  GraphConditions,
  GraphRule,
  GraphRuleAction,
  GraphRuleClient,
  GraphRuleList,
} from "./client.js";
import { GraphBudgetError } from "./budget.js";

export const GRAPH_ADAPTER_ID = "graph";

const LANE_SUFFIX = ".graph";
/** The engine lane of a Microsoft account's rules: its own queue, journal and state. */
export function graphLaneId(accountId: string): string {
  // The engine caps lane ids at 64 characters (ACCOUNT_ID); a long account id is cut so the suffix always fits.
  return accountId.length + LANE_SUFFIX.length <= 64
    ? `${accountId}${LANE_SUFFIX}`
    : `${accountId.slice(0, 64 - LANE_SUFFIX.length)}${LANE_SUFFIX}`;
}

/**
 * Strings in one rule, at most. Unit: strings. Graph documents no limit on `fromAddresses` (measurement M1), and Exchange Online holds
 * 256 KiB of rules in all. PROVISIONAL until M1. When Outlook refuses a rule, the lane halves this for itself and stores the result.
 */
export const GRAPH_STRINGS_PER_RULE = 100;
/** The smallest rule the halving goes to. Unit: strings. A refusal at this size is not about size. */
export const GRAPH_MIN_STRINGS_PER_RULE = 10;
/** Rules this lane holds, at most. Unit: rules. 5,000 entries at the smallest rule, 500, would never fit 256 KiB; 200 is twice the room at 50. */
export const GRAPH_MAX_RULES = 200;
/** Rule writes in one round, at most. Unit: requests. A backlog goes out over the next rounds as `deferred`. */
export const GRAPH_MAX_WRITES_PER_ROUND = 10;
/** Time after which a round stops STARTING new writes. Unit: milliseconds. It is not the round's limit: that is GRAPH_ROUND_DEADLINE_MS. */
export const GRAPH_ROUND_BUDGET_MS = 20_000;
/**
 * Hard limit of one round. Unit: milliseconds. The engine abandons a round at 60 s and drops what it returned; here every call in flight is
 * cut off first, and what the `checkpoint` saved is found again by the next round. 15 s of margin.
 */
export const GRAPH_ROUND_DEADLINE_MS = 45_000;
/** The same limit for removing the lane's rules (`uninstall`), which a person starts. Unit: milliseconds. */
export const GRAPH_UNINSTALL_DEADLINE_MS = 120_000;
/** Retries of a PATCH or a DELETE that answered 5xx or timed out. Unit: retries. A POST is never retried: its outcome is read from the list. */
export const GRAPH_WRITE_RETRIES = 2;
/** Wait before the n-th retry is `n` times this. Unit: milliseconds. */
export const GRAPH_RETRY_DELAY_MS = 1_000;
/** Longest `suspend` waits for a running round: its deadline and 15 s for the answer to be handled. Unit: milliseconds. */
export const GRAPH_SUSPEND_WAIT_MS = GRAPH_ROUND_DEADLINE_MS + 15_000;

/**
 * `exactDomain` and `subdomains` are false on purpose. A block of a domain is written as `senderContains: "@domain"`, a substring: Graph has
 * no exact-domain condition, so `@bank.co` also catches `@bank.com`. The match is wider than the contract's word, the mail stays reversible
 * (Junk or Deleted Items), and the window says so. `exactAddress` is exact.
 */
const CAPABILITIES: Capabilities = {
  serverBlock: true,
  retroClean: false,
  watch: false,
  unsubscribe: false,
  quota: false,
  exactAddress: true,
  exactDomain: false,
  subdomains: false,
};

/** What a rule's condition may hold: printable ASCII, the same as the client lets out. */
const Value = z
  .string()
  .min(3)
  .max(254)
  .regex(/^[!-~]+$/u);
const RuleAction = z.enum(["junk", "trash"]);
type RuleAction = z.infer<typeof RuleAction>;
const RuleKind = z.enum(["address", "domain"]);
type RuleKind = z.infer<typeof RuleKind>;
const Nonce = z.string().regex(/^[0-9a-f]{16}$/u);

/** What the state keeps of a block: enough to write the rule again and to say which entry a change was for. */
const Held = z.strictObject({
  id: z.uuid(),
  value: Value,
  match: z.enum(["exactAddress", "exactDomain", "subdomains"]),
});
type Held = z.infer<typeof Held>;

const RuleRecord = z.strictObject({
  id: z.string().regex(GRAPH_ID),
  nonce: Nonce,
  kind: RuleKind,
  action: RuleAction,
  entries: z.array(Held).min(1).max(GRAPH_STRINGS_PER_RULE),
});
type RuleRecord = z.infer<typeof RuleRecord>;

/**
 * A rule of ours that no longer reads as written: the person edited it (an exception for a false positive, a rule switched off, a new name) or Outlook
 * stores it otherwise. It is never written to or deleted, and unless it was switched off it still acts on mail, so it is kept: its entries count as covered,
 * an Unblock of one is reported instead of shown as done, and the Accounts page and a removal say it stays. `entries` shrinks as Unblocks are reported.
 */
const EditedRule = RuleRecord.extend({ entries: z.array(Held).max(GRAPH_STRINGS_PER_RULE) });
type EditedRule = z.infer<typeof EditedRule>;

/**
 * A write that was about to be sent: on disk first, so one Graph took but never answered for is found again. `ruleId` null is a create (found by
 * the nonce in the name); otherwise a PATCH of that rule (found by what the rule now holds).
 */
const Intent = z.strictObject({
  ruleId: z.string().regex(GRAPH_ID).nullable(),
  nonce: Nonce,
  kind: RuleKind,
  action: RuleAction,
  entries: z.array(Held).min(1).max(GRAPH_STRINGS_PER_RULE),
});
type Intent = z.infer<typeof Intent>;

const StateSchema = z
  .strictObject({
    rules: z.array(RuleRecord).max(GRAPH_MAX_RULES),
    edited: z.array(EditedRule).max(GRAPH_MAX_RULES),
    intent: z.array(Intent).max(GRAPH_MAX_WRITES_PER_ROUND * 2),
    /** The Junk Email folder, read once. */
    junkFolderId: z.string().regex(GRAPH_ID).nullable(),
    /** Strings a rule takes on this mailbox: starts at GRAPH_STRINGS_PER_RULE and halves when Outlook refuses a rule. */
    capacity: z.number().int().min(GRAPH_MIN_STRINGS_PER_RULE).max(GRAPH_STRINGS_PER_RULE),
  })
  .superRefine((state, ctx) => {
    const ids = new Set<string>();
    const values = new Set<string>();
    for (const rule of state.rules) {
      if (ids.has(rule.id)) ctx.addIssue({ code: "custom", message: "duplicate rule id" });
      ids.add(rule.id);
      for (const entry of rule.entries) {
        if ((rule.kind === "address") !== (entry.match === "exactAddress")) {
          ctx.addIssue({ code: "custom", message: "entry not allowed in this rule" });
        }
        if (values.has(entry.value)) ctx.addIssue({ code: "custom", message: "repeated entry" });
        values.add(entry.value);
      }
    }
  });
type GraphState = z.infer<typeof StateSchema>;

const toHeld = (entry: BlockEntry): Held => ({
  id: entry.id,
  value: entry.value,
  match: entry.match,
});
const toEntry = (held: Held, action: RuleAction): BlockEntry => ({
  id: held.id,
  match: held.match,
  value: held.value,
  action,
  createdAt: "1970-01-01T00:00:00.000Z",
});

export function initialGraphState(): OpaqueState {
  const data: GraphState = {
    rules: [],
    edited: [],
    intent: [],
    junkFolderId: null,
    capacity: GRAPH_STRINGS_PER_RULE,
  };
  return { adapterId: GRAPH_ADAPTER_ID, data };
}

function parseState(state: OpaqueState): GraphState {
  if (state.adapterId !== GRAPH_ADAPTER_ID) {
    throw new AdapterError("REJECTED", "state belongs to another adapter");
  }
  const parsed = StateSchema.safeParse(state.data);
  if (!parsed.success) throw new AdapterError("REJECTED", "graph state failed validation");
  return parsed.data;
}

/**
 * Whether the state records anything in the mailbox that Senderban wrote or may have written. Used before an account is removed: only an
 * empty state means nothing is left to delete. A state that cannot be read counts as holding rules (nothing is assumed gone).
 */
export function graphStateHoldsRules(state: OpaqueState): boolean {
  const parsed = StateSchema.safeParse(state.data);
  if (state.adapterId !== GRAPH_ADAPTER_ID || !parsed.success) return true;
  return parsed.data.rules.length + parsed.data.edited.length + parsed.data.intent.length > 0;
}

/** How many rules Senderban leaves alone because they were changed in Outlook, for the Accounts page. A state that cannot be read has none to name. */
export function graphEditedRules(state: OpaqueState): number {
  const parsed = StateSchema.safeParse(state.data);
  return state.adapterId === GRAPH_ADAPTER_ID && parsed.success ? parsed.data.edited.length : 0;
}

/** Whether Senderban may still delete something: the rules a person edited are not its to delete. A state that cannot be read counts as yes. */
export function graphStateHoldsDeletable(state: OpaqueState): boolean {
  const parsed = StateSchema.safeParse(state.data);
  if (state.adapterId !== GRAPH_ADAPTER_ID || !parsed.success) return true;
  return parsed.data.rules.length + parsed.data.intent.length > 0;
}

/** Where account alerts come from: a look-alike of one, blocked after a phishing mail, would silence the real alerts in the middle of the attack. */
const IDENTITY_DOMAINS = ["google", "microsoft", "apple"].map((name) => `${name}.com`);

/**
 * Whether a text match of this domain would also reach the person's own mail, a mail provider or a whole country. `senderContains` is a substring:
 * `@contoso.co` and `.contoso.co` match `@contoso.com`, `@gmail.co` every Gmail sender, `.gov.u` every `*.gov.uk`. The guards at the list work on labels and
 * cannot see that, so such a domain is refused on Outlook. Every parent of the value is tried too: a subdomain of a look-alike reaches the same subdomain of the real name.
 */
export function graphMatchReaches(
  entry: Pick<BlockEntry, "match" | "value">,
  own: OwnMail,
): boolean {
  return graphReachTest(own)(entry);
}

export type GraphReachTest = (entry: Pick<BlockEntry, "match" | "value">) => boolean;

const reachTests = new WeakMap<OwnMail, GraphReachTest>();

/** The test for one own-mail set, the same function every time: a list read and every lane ask it thousands of times. */
export function graphReachTest(own: OwnMail): GraphReachTest {
  const found = reachTests.get(own);
  if (found !== undefined) return found;
  const guarded = [
    ...own.domains,
    ...[...own.addresses].map((a) => a.slice(a.lastIndexOf("@") + 1)),
    ...freemailDomains(),
    ...IDENTITY_DOMAINS,
  ].map((domain) => `.${domain}`);
  const test: GraphReachTest = (entry) => reachesGuarded(entry, guarded);
  reachTests.set(own, test);
  return test;
}

function reachesGuarded(
  entry: Pick<BlockEntry, "match" | "value">,
  guarded: readonly string[],
): boolean {
  if (entry.match === "exactAddress") return false;
  const labels = entry.value.split(".");
  // A last label that is no top-level domain is a forged name, likely a cut of a real one: its text match reaches everything under that suffix.
  if (!hasKnownTop(entry.value)) return true;
  // A parent that is a public suffix is not a value: `co.uk` under a name there says nothing about the sender.
  const values = labels
    .slice(0, -1)
    .map((_, i) => labels.slice(i).join("."))
    .filter((value, i) => i === 0 || !isPublicSuffix(value));
  return values.some((value) => {
    const needle = `.${value}`;
    return guarded.some((domain) => domain.includes(needle));
  });
}

const ruleName = (nonce: string): string => `Senderban ${nonce}`;
const newNonce = (): string => randomBytes(8).toString("hex");
const kindOf = (match: Held["match"]): RuleKind =>
  match === "exactAddress" ? "address" : "domain";

/** The strings an entry takes in its rule: `.domain` is what reaches the subdomains (`@domain` does not). */
function stringsOf(entry: Held): string[] {
  if (entry.match === "exactAddress") return [entry.value];
  return entry.match === "subdomains"
    ? [`@${entry.value}`, `.${entry.value}`]
    : [`@${entry.value}`];
}
const load = (entries: readonly Held[]): number =>
  entries.reduce((sum, e) => sum + stringsOf(e).length, 0);
const strings = (entries: readonly Held[]): string[] => entries.flatMap(stringsOf);

function conditionsOf(kind: RuleKind, entries: readonly Held[]): GraphConditions {
  return kind === "address"
    ? { fromAddresses: strings(entries) }
    : { senderContains: strings(entries) };
}

/** A value Graph returns where nothing is set. */
const unset = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === false ||
  (Array.isArray(value) && value.length === 0);
const setKeys = (value: Record<string, unknown> | null | undefined): string[] =>
  Object.entries(value ?? {})
    .filter(([key, v]) => !unset(v) && !key.startsWith("@"))
    .map(([key]) => key)
    .sort();

const sameStrings = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a.map((s) => s.toLowerCase()));
  const right = new Set(b.map((s) => s.toLowerCase()));
  return left.size === right.size && [...left].every((s) => right.has(s));
};

/** The strings of a rule's one condition as Graph holds them, or null when it has any other condition. */
function remoteStrings(remote: GraphRule, kind: RuleKind): string[] | null {
  const keys = setKeys(remote.conditions);
  const key = kind === "address" ? "fromAddresses" : "senderContains";
  if (keys.length !== 1 || keys[0] !== key) return null;
  if (kind === "domain") return [...(remote.conditions?.senderContains ?? [])];
  return (remote.conditions?.fromAddresses ?? []).map((r) => r.emailAddress.address ?? "");
}

/**
 * Ownership read-back: a rule is ours only with our name, exactly one condition of our kind holding `entries`, no exception, and exactly our
 * actions. Compared as sets without case (the docs' sample stores `adele` as `ADELE`), and without `sequence` (the server renumbers). The
 * folder id is not compared: its form on the way back is not measured, and reading a sound rule as changed would write a new one every round.
 */
function holds(
  remote: GraphRule,
  nonce: string,
  kind: RuleKind,
  action: RuleAction,
  entries: readonly Held[],
): boolean {
  if (remote.displayName !== ruleName(nonce) || remote.isReadOnly === true) return false;
  // Switched off by the person, or in error at Outlook: new blocks must not go into a rule that does nothing.
  if (remote.isEnabled === false || remote.hasError === true) return false;
  if (setKeys(remote.exceptions).length > 0) return false;
  const held = remoteStrings(remote, kind);
  if (held === null || !sameStrings(held, strings(entries))) return false;
  const actions = setKeys(remote.actions).join(" ");
  return action === "trash"
    ? actions === "delete stopProcessingRules"
    : actions === "moveToFolder stopProcessingRules";
}

/** One rule change. `rule` null is a new rule; `next` empty deletes the rule. `takes` are the plan changes it carries out. */
interface Write {
  readonly rule: RuleRecord | null;
  readonly kind: RuleKind;
  readonly action: RuleAction;
  readonly next: readonly Held[];
  readonly takes: readonly PlannedChange[];
}

const change = (kind: "create" | "remove", entry: BlockEntry): PlannedChange => ({
  kind,
  entry,
  match: entry.match,
});

interface Wanted {
  readonly held: Held;
  readonly action: RuleAction;
}

/**
 * Which rules change. Append-only: an entry already in a rule never moves (one added address writes one rule, never all of them), a new entry
 * goes to the first rule of its kind and action with room, then to new rules. Removals come first: an Unblock is the urgent one, and they
 * free the room. At most `cap` writes; the changes of the others are counted in `left`.
 */
function schedule(
  rules: readonly RuleRecord[],
  removes: readonly Held[],
  adds: readonly Wanted[],
  capacity: number,
  cap: number,
): { writes: Write[]; left: number } {
  const removeValues = new Set(removes.map((e) => e.value));
  const kept = new Map<string, Held[]>();
  const taken = new Map<string, PlannedChange[]>();
  for (const rule of rules) {
    kept.set(
      rule.id,
      rule.entries.filter((e) => !removeValues.has(e.value)),
    );
    taken.set(
      rule.id,
      rule.entries
        .filter((e) => removeValues.has(e.value))
        .map((e) => change("remove", toEntry(e, rule.action))),
    );
  }
  const pending = [...adds];
  for (const rule of rules) {
    const holdsNow = kept.get(rule.id) ?? [];
    for (const wanted of pending.filter(
      (w) => kindOf(w.held.match) === rule.kind && w.action === rule.action,
    )) {
      if (load([...holdsNow, wanted.held]) > capacity) break;
      holdsNow.push(wanted.held);
      taken.get(rule.id)?.push(change("create", toEntry(wanted.held, wanted.action)));
      pending.splice(pending.indexOf(wanted), 1);
    }
  }
  const writes: Write[] = [];
  const touched = (rule: RuleRecord): boolean => (taken.get(rule.id)?.length ?? 0) > 0;
  const hasRemoval = (rule: RuleRecord): boolean =>
    (taken.get(rule.id) ?? []).some((c) => c.kind === "remove");
  for (const pass of [true, false]) {
    for (const rule of rules) {
      if (!touched(rule) || hasRemoval(rule) !== pass) continue;
      writes.push({
        rule,
        kind: rule.kind,
        action: rule.action,
        next: kept.get(rule.id) ?? [],
        takes: taken.get(rule.id) ?? [],
      });
    }
  }
  const groups = new Map<string, Wanted[]>();
  for (const wanted of pending) {
    const key = `${kindOf(wanted.held.match)} ${wanted.action}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [wanted]);
    else group.push(wanted);
  }
  for (const group of groups.values()) {
    let chunk: Held[] = [];
    const first = group[0];
    if (first === undefined) continue;
    const flush = (): void => {
      if (chunk.length === 0) return;
      writes.push({
        rule: null,
        kind: kindOf(first.held.match),
        action: first.action,
        next: chunk,
        takes: chunk.map((e) => change("create", toEntry(e, first.action))),
      });
      chunk = [];
    };
    for (const { held } of group) {
      if (load([...chunk, held]) > capacity) flush();
      chunk.push(held);
    }
    flush();
  }
  const chosen = writes.slice(0, cap);
  const all = writes.reduce((sum, w) => sum + w.takes.length, 0);
  const done = chosen.reduce((sum, w) => sum + w.takes.length, 0);
  return { writes: chosen, left: all - done };
}

/** Whether the list may hold this rule among the entries it could not read. */
function maybeListed(listing: GraphRuleList, id: string): boolean {
  return listing.unreadableIds.has(id) || listing.unreadable > listing.unreadableIds.size;
}

/** The removals of entries an edited rule holds: no write takes them, and the round reports them. */
function leavingEdited(edited: readonly EditedRule[], removes: readonly Held[]): PlannedChange[] {
  const out: PlannedChange[] = [];
  const leaving = new Set(removes.map((e) => e.value));
  for (const rule of edited) {
    for (const entry of rule.entries) {
      if (leaving.has(entry.value)) out.push(change("remove", toEntry(entry, rule.action)));
    }
  }
  return out;
}

/** The marked `remove` change that carries "clean up" into a round when nothing else is planned. The address is a placeholder. */
export const GRAPH_CLEANUP_ENTRY_ID = "00000000-0000-4000-8000-00000000fff2";
const CLEANUP_ENTRY: BlockEntry = {
  id: GRAPH_CLEANUP_ENTRY_ID,
  match: "exactAddress",
  value: "cleanup@senderban.invalid",
  action: "trash",
  createdAt: "1970-01-01T00:00:00.000Z",
};

/** What the log may learn about a round: counts and a duration, never an address or a rule id. */
export interface GraphRoundReport {
  readonly ms: number;
  readonly writes: number;
  readonly applied: number;
  readonly failed: number;
  readonly deferred: number;
  readonly edited: number;
  readonly capacity: number;
}

export interface GraphAdapterOptions {
  /** The engine lane this adapter serves; it names the journal rows. */
  readonly accountId: string;
  readonly client: GraphRuleClient;
  /**
   * Saves the state in the middle of a round (the app binds it to `store.setState` for this lane). The engine drops a round at 60 s together with
   * everything `apply` returned, so a rule written before then is only known if it was saved here first. Required: a wiring that forgets it must not compile.
   */
  readonly checkpoint: (state: OpaqueState) => void;
  /** Injectable for tests. Milliseconds. */
  readonly now?: () => number;
  readonly roundDeadlineMs?: number;
  readonly uninstallDeadlineMs?: number;
  readonly roundBudgetMs?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * The current test for entries this lane must not write (`graphReachTest`). One already in a rule is taken out like an Unblock. Return the same function while
   * nothing changed: what follows from a list is kept once for all lanes until the list or the test changes.
   */
  readonly reaches: () => GraphReachTest;
  /** Told once per round: numbers only. */
  readonly onRound?: (round: GraphRoundReport) => void;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const asAdapterError = (error: unknown, fallback: string): AdapterError =>
  error instanceof AdapterError ? error : new AdapterError("TRANSIENT", fallback);

/** The state while a round runs: every step changes it and saves it. */
interface Work {
  rules: RuleRecord[];
  edited: EditedRule[];
  intent: Intent[];
  junkFolderId: string | null;
  capacity: number;
}
const snapshot = (work: Work): OpaqueState => {
  const data: GraphState = {
    rules: [...work.rules],
    edited: [...work.edited],
    intent: [...work.intent],
    junkFolderId: work.junkFolderId,
    capacity: work.capacity,
  };
  return { adapterId: GRAPH_ADAPTER_ID, data };
};

/** What follows from a list and a test alone. The engine hands every lane one list object: 50 lanes must not validate 5,000 entries 50 times. */
interface Mirror {
  readonly reaches: GraphReachTest;
  readonly wanted: ReadonlyMap<string, Wanted>;
  readonly hash: string;
}
const mirrors = new WeakMap<Blocklist, Mirror>();

/**
 * The entries of the list this lane mirrors, by value. `reject` is Junk here (`folderAction`): only MXroute refuses at the door. The engine has
 * already left out what reaches the person's own mail.
 */
function mirrored(list: Blocklist, reaches: GraphReachTest): Mirror {
  const cached = mirrors.get(list);
  if (cached?.reaches === reaches) return cached;
  const wanted = new Map<string, Wanted>();
  const hash = createHash("sha256");
  for (const raw of list) {
    const checked = checkEntry(raw);
    if (!checked.ok) continue;
    const { entry } = checked;
    if (reaches(entry)) continue;
    wanted.set(entry.value, { held: toHeld(entry), action: folderAction(entry.action) });
    hash.update(entry.value).update(entry.action).update(entry.match).update("\n");
  }
  const mirror = { reaches, wanted, hash: hash.digest("base64") };
  mirrors.set(list, mirror);
  return mirror;
}

/**
 * Mirrors the block list onto Outlook Inbox rules (messageRules), so the mail goes to Junk or Deleted Items at the server, whichever app reads it.
 * Addresses and domains sit in separate rules, one per kind and action. Ownership is the rule id in this lane's state plus an exact read-back
 * of what it holds. A rule we did not write is never seen; one changed since is never touched, and is kept as `edited`.
 */
export class GraphAdapter implements BlockAdapter {
  readonly id = GRAPH_ADAPTER_ID;
  readonly #client: GraphRuleClient;
  readonly #accountId: string;
  readonly #checkpoint: (state: OpaqueState) => void;
  readonly #roundDeadlineMs: number;
  readonly #uninstallDeadlineMs: number;
  readonly #now: () => number;
  readonly #budgetMs: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #reaches: GraphAdapterOptions["reaches"];
  readonly #onRound: GraphAdapterOptions["onRound"];
  /** The inputs of the last plan that had nothing to do: the same inputs have nothing to do again. */
  #idleKey: string | null = null;
  #suspended = false;
  #retired = false;
  #active = 0;
  #idle: (() => void)[] = [];

  constructor(options: GraphAdapterOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#checkpoint = options.checkpoint;
    this.#roundDeadlineMs = options.roundDeadlineMs ?? GRAPH_ROUND_DEADLINE_MS;
    this.#uninstallDeadlineMs = options.uninstallDeadlineMs ?? GRAPH_UNINSTALL_DEADLINE_MS;
    this.#now = options.now ?? Date.now;
    this.#budgetMs = options.roundBudgetMs ?? GRAPH_ROUND_BUDGET_MS;
    this.#retryDelayMs = options.retryDelayMs ?? GRAPH_RETRY_DELAY_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#reaches = options.reaches;
    this.#onRound = options.onRound;
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /**
   * Stops writing: a round that is running finishes (it ends by its own deadline), a new one does not start. While suspended `plan` and `apply`
   * answer TRANSIENT, never "nothing to do": the engine must not read the pause as a clean round. Resolves true when no round is running,
   * false when one still is after `timeoutMs`. `resume` ends the pause (the removal did not finish).
   */
  suspend(timeoutMs: number = GRAPH_SUSPEND_WAIT_MS): Promise<boolean> {
    this.#suspended = true;
    if (this.#active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  resume(): void {
    this.#suspended = false;
  }

  /** The account is gone for good: the lane stays in the engine, which cannot drop one, with nothing to do for the rest of the session. */
  retire(): void {
    this.#retired = true;
  }

  #planKey(mirror: Mirror, state: OpaqueState): string {
    return createHash("sha256")
      .update(mirror.hash)
      .update(JSON.stringify(state.data))
      .digest("base64");
  }

  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    if (this.#retired) {
      return Promise.resolve({ accountId: this.#accountId, changes: [], basedOn: state });
    }
    if (this.#suspended) {
      return Promise.reject(new AdapterError("TRANSIENT", "Outlook rules are being removed"));
    }
    try {
      // A block click plans every lane, and a list holds thousands: the same list over the same state that had nothing to do last time has
      // nothing to do now, and is answered without parsing either.
      const mirror = mirrored(list, this.#reaches());
      const key = this.#planKey(mirror, state);
      if (key === this.#idleKey) {
        return Promise.resolve({ accountId: this.#accountId, changes: [], basedOn: state });
      }
      const current = parseState(state);
      const { removes, adds } = this.#difference(
        mirror.wanted,
        [...current.rules, ...current.edited],
        current.intent,
      );
      const { writes, left } = schedule(
        current.rules,
        removes,
        adds,
        current.capacity,
        GRAPH_MAX_WRITES_PER_ROUND,
      );
      const changes = [
        ...writes.flatMap((w) => w.takes),
        ...leavingEdited(current.edited, removes),
      ];
      // An unresolved intent must be dealt with by a round, and the engine only runs a round that has changes. An edited rule needs none of its own:
      // the next round that writes anything lists the mailbox anyway, and sees it gone or back as written.
      const pendingWork = current.intent.length > 0;
      this.#idleKey = changes.length === 0 && !pendingWork && left === 0 ? key : null;
      return Promise.resolve({
        accountId: this.#accountId,
        changes: changes.length === 0 && pendingWork ? [change("remove", CLEANUP_ENTRY)] : changes,
        basedOn: state,
        ...(left > 0 ? { deferred: left } : {}),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** What differs between the wanted list and the rules. An entry whose action changed leaves its rule and joins another. */
  #difference(
    wanted: ReadonlyMap<string, Wanted>,
    rules: readonly EditedRule[],
    intent: readonly Intent[],
  ): { removes: Held[]; adds: Wanted[] } {
    const have = new Set<string>();
    const removes: Held[] = [];
    for (const rule of rules) {
      for (const entry of rule.entries) {
        const want = wanted.get(entry.value);
        if (want?.action === rule.action && want.held.match === entry.match) have.add(entry.value);
        else removes.push(entry);
      }
    }
    // An entry in an unconfirmed write is not added a second time until a round has settled that write.
    const pending = new Set(intent.flatMap((i) => i.entries.map((e) => e.value)));
    const adds = [...wanted.values()].filter(
      (w) => !have.has(w.held.value) && !pending.has(w.held.value),
    );
    return { removes, adds };
  }

  async apply(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    if (this.#suspended || this.#retired) {
      throw new AdapterError("TRANSIENT", "Outlook rules are being removed");
    }
    this.#active += 1;
    const started = this.#now();
    try {
      const result = await this.#round(plan, signal);
      try {
        const { edited, capacity } = parseState(result.state);
        this.#onRound?.({
          ms: this.#now() - started,
          writes: plan.changes.length,
          applied: result.applied,
          failed: result.failed.length,
          deferred: result.deferred ?? 0,
          edited: edited.length,
          capacity,
        });
      } catch {
        // a report must not break a round
      }
      return result;
    } finally {
      this.#active -= 1;
      if (this.#active === 0) for (const resolve of this.#idle.splice(0)) resolve();
    }
  }

  async #round(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    const state = parseState(plan.basedOn);
    const asHeld = (c: PlannedChange): Held => toHeld(c.entry);
    const removes = plan.changes
      .filter((c) => c.kind === "remove" && c.entry.id !== GRAPH_CLEANUP_ENTRY_ID)
      .map(asHeld);
    const adds = plan.changes
      .filter((c) => c.kind === "create")
      .map((c): Wanted => ({ held: asHeld(c), action: folderAction(c.entry.action) }));
    const started = this.#now();
    // One clock for the whole round, under the engine's 60 s: whatever is in flight when it runs out is cut off, and what was saved
    // before then is found again by the next round.
    const deadline = AbortSignal.timeout(this.#roundDeadlineMs);
    const roundSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const work: Work = {
      rules: [...state.rules],
      edited: [...state.edited],
      intent: [...state.intent],
      junkFolderId: state.junkFolderId,
      capacity: state.capacity,
    };
    // A save after a step may fail without stopping the round; the save of an intent may not: a write must never go out without it on disk.
    const save = (strict = false): void => {
      try {
        this.#checkpoint(snapshot(work));
      } catch {
        if (strict) throw new AdapterError("TRANSIENT", "the state could not be saved");
      }
    };

    let lost = 0;
    let edits = 0;
    let settledLater: number;
    /** Rules the list did not show while it held one the client could not read: not confirmed, so not written to this round. */
    const unseen = new Set<string>();
    const rateLimited = (cause: AdapterError): AdapterError =>
      new AdapterError(
        "TRANSIENT",
        cause instanceof GraphBudgetError ? cause.message : "Microsoft asked to slow down, later",
      );
    try {
      // One read of the mailbox: what is really there decides what is ours, lost or changed.
      const listing = await this.#client.list(roundSignal);
      const settled = this.#resolveIntents(work, listing);
      settledLater = settled.adopted + settled.dropped;
      if (settled.changed) save();
      const remote = new Map(listing.rules.map((r) => [r.id, r]));
      const before = work.rules.length + work.edited.length;
      // A rule the client could not read is not a rule that is gone.
      const gone = (id: string): boolean => !remote.has(id) && !maybeListed(listing, id);
      for (const rule of [...work.rules]) {
        const found = remote.get(rule.id);
        if (found === undefined && !gone(rule.id)) unseen.add(rule.id);
        if (gone(rule.id)) {
          // Deleted in Outlook: the next plan puts back what is still wanted in a new rule, and that follow-up is `deferred`.
          lost += rule.entries.length;
          work.rules = work.rules.filter((r) => r.id !== rule.id);
        } else if (
          found !== undefined &&
          !holds(found, rule.nonce, rule.kind, rule.action, rule.entries)
        ) {
          work.rules = work.rules.filter((r) => r.id !== rule.id);
          work.edited.push(rule);
          edits += 1;
        }
      }
      for (const rule of [...work.edited]) {
        const found = remote.get(rule.id);
        if (gone(rule.id)) {
          lost += rule.entries.length;
          work.edited = work.edited.filter((r) => r.id !== rule.id);
        } else if (
          found !== undefined &&
          rule.entries.length > 0 &&
          holds(found, rule.nonce, rule.kind, rule.action, rule.entries)
        ) {
          // Back as written (switched on again): ours again.
          work.edited = work.edited.filter((r) => r.id !== rule.id);
          work.rules.push(rule);
          edits += 1;
        }
      }
      if (lost > 0 || edits > 0 || work.rules.length + work.edited.length !== before) save();
    } catch (error) {
      const adapterError = asAdapterError(error, "Microsoft call failed");
      // Asked to slow down before anything was written. Every change is reported as failed (TRANSIENT): the engine then backs off instead of
      // asking again every 30 s, and an Unblock is not shown as done while the rule is still in Outlook.
      if (adapterError.code === "QUOTA_EXCEEDED") {
        return {
          applied: 0,
          failed: plan.changes.map((c) => ({
            entryId: c.entry.id,
            error: rateLimited(adapterError),
          })),
          state: snapshot(work),
        };
      }
      throw adapterError;
    }

    // What an earlier round's intent took in may already hold some of these entries: never a second copy. An entry moving to
    // another rule is in one now and in `removes` too.
    const leaving = new Set(removes.map((e) => e.value));
    const inRules = new Set(
      [...work.rules, ...work.edited].flatMap((r) => r.entries.map((e) => e.value)),
    );
    // A person's edit stands between an Unblock and its rule: said once, never shown as done. What the person does with the rule next is theirs.
    const heldByEdit = removes.filter((e) =>
      work.edited.some((r) => r.entries.some((held) => held.value === e.value)),
    );
    const edited = heldByEdit.map((e) => ({
      entryId: e.id,
      error: new AdapterError(
        "REMOTE_CHANGED",
        "a Senderban rule changed in Outlook still holds this sender: remove it there",
      ),
    }));
    // A rule the list did not confirm holds its entries until a round can see it: taken out of neither, and a move waits with it, or one value would sit in
    // two rules, which the state refuses.
    const held = new Set(
      work.rules.filter((r) => unseen.has(r.id)).flatMap((r) => r.entries.map((e) => e.value)),
    );
    const waiting = [
      ...removes.filter((e) => held.has(e.value)),
      ...adds.filter((w) => held.has(w.held.value)).map((w) => w.held),
    ];
    const unconfirmed = waiting.map((e) => ({
      entryId: e.id,
      error: new AdapterError("TRANSIENT", "Outlook's rule list could not be read in full"),
    }));
    const { writes, left } = schedule(
      work.rules.filter((r) => !unseen.has(r.id)),
      removes.filter((e) => !held.has(e.value)),
      adds.filter(
        (w) => !held.has(w.held.value) && (leaving.has(w.held.value) || !inRules.has(w.held.value)),
      ),
      work.capacity,
      GRAPH_MAX_WRITES_PER_ROUND,
    );

    let applied = 0;
    let handled = 0;
    let stopped: AdapterError | null = null;
    for (const [index, write] of writes.entries()) {
      if (handled > 0 && this.#now() - started >= this.#budgetMs) break;
      try {
        roundSignal.throwIfAborted();
        // One write after the other by design: one lane holds one request open, under Outlook's four per mailbox.
        const outcome = await this.#write(write, work, roundSignal, save);
        // Gone between the list and this write: nothing of it was written, and the next plan writes what is still wanted.
        if (outcome === "gone") lost += write.takes.length;
        else applied += write.takes.length;
        handled = index + 1;
      } catch (error) {
        const adapterError = asAdapterError(error, "Microsoft call failed");
        const quota = adapterError.code === "QUOTA_EXCEEDED";
        // The write may have dropped its intent: that must be on disk whichever way this ends.
        save();
        const halved = Math.max(GRAPH_MIN_STRINGS_PER_RULE, Math.floor(work.capacity / 2));
        if (
          adapterError instanceof RuleRefusedError &&
          halved < work.capacity &&
          load(write.next) > halved &&
          write.takes.some((c) => c.kind === "create")
        ) {
          // Possibly too big: the number is not documented, so the lane finds it. The refused changes go out in smaller rules next round. A rule
          // that shrinks, or one the smaller size would not change, is refused for another reason.
          work.capacity = halved;
          save();
          break;
        }
        // A new rule refused for another reason may be a stale folder id: it is read again, once, by a round the engine runs by itself.
        if (
          adapterError.code === "REJECTED" &&
          !(adapterError instanceof RuleSpaceError) &&
          write.rule === null &&
          write.action === "junk" &&
          state.junkFolderId !== null
        ) {
          work.junkFolderId = null;
          save();
          if (handled === 0) throw new AdapterError("TRANSIENT", "the Junk folder is read again");
        }
        // Nothing handled yet: the whole round failed for this reason, and the engine does not ask again by itself. A mailbox with no room or a rule
        // Outlook refuses waits for the next change of the list, which is what can cure it. A rate limit is reported below: it passes.
        if (handled === 0 && !quota) throw adapterError;
        stopped = quota ? rateLimited(adapterError) : adapterError;
        break;
      }
    }

    const unprocessed = writes.slice(handled);
    const unprocessedChanges = unprocessed.reduce((sum, w) => sum + w.takes.length, 0);
    const later = left + lost + settledLater + (stopped === null ? unprocessedChanges : 0);
    const stopError = stopped;
    // Only here, with the report on its way: a round that throws has said nothing yet.
    if (heldByEdit.length > 0) {
      const said = new Set(heldByEdit.map((e) => e.value));
      work.edited = work.edited.map((r) => ({
        ...r,
        entries: r.entries.filter((e) => !said.has(e.value)),
      }));
    }
    return {
      applied,
      // After an error or a rate limit the rest is reported as failed (the engine backs off and tries again); a stop for time is only deferred.
      failed: [
        ...edited,
        ...unconfirmed,
        ...(stopError === null
          ? []
          : unprocessed.flatMap((w) =>
              w.takes.map((c) => ({ entryId: c.entry.id, error: stopError })),
            )),
      ],
      ...(later > 0 ? { deferred: later } : {}),
      state: snapshot(work),
    };
  }

  /** Settles writes of an earlier round whose answer never came back. */
  #resolveIntents(
    work: Work,
    listing: GraphRuleList,
  ): { changed: boolean; dropped: number; adopted: number } {
    if (work.intent.length === 0) return { changed: false, dropped: 0, adopted: 0 };
    const remote = listing.rules;
    let dropped = 0;
    let adopted = 0;
    const undecided: Intent[] = [];
    const known = new Set(work.rules.map((r) => r.id));
    for (const item of work.intent) {
      if (item.ruleId === null) {
        // Found by its name: the nonce makes it ours even when it no longer reads as written, and then it is kept, not lost.
        const found = remote.find(
          (r) => !known.has(r.id) && r.displayName === ruleName(item.nonce),
        );
        if (found === undefined) {
          // It may be the entry the client could not read.
          if (listing.unreadable > 0) undecided.push(item);
          else dropped += item.entries.length;
          continue;
        }
        known.add(found.id);
        adopted += item.entries.length;
        const record: RuleRecord = {
          id: found.id,
          nonce: item.nonce,
          kind: item.kind,
          action: item.action,
          entries: [...item.entries],
        };
        if (holds(found, item.nonce, item.kind, item.action, item.entries)) work.rules.push(record);
        else work.edited.push(record);
        continue;
      }
      // A PATCH either landed (the rule holds the new entries) or did not: the rule then reads as before, which the normal read-back handles.
      const target = remote.find((r) => r.id === item.ruleId);
      const record = work.rules.find((r) => r.id === item.ruleId);
      if (
        target !== undefined &&
        record !== undefined &&
        holds(target, item.nonce, item.kind, item.action, item.entries)
      ) {
        adopted += item.entries.length;
        work.rules = work.rules.map((r) =>
          r.id === item.ruleId ? { ...r, entries: [...item.entries] } : r,
        );
      } else dropped += item.entries.length;
    }
    work.intent = undecided;
    return { changed: true, dropped, adopted };
  }

  /** The folder a Junk rule moves mail to, read once and kept. */
  async #junkId(work: Work, signal: AbortSignal): Promise<string> {
    if (work.junkFolderId !== null) return work.junkFolderId;
    const id = await this.#client.junkFolderId(signal);
    work.junkFolderId = id;
    return id;
  }

  async #write(
    write: Write,
    work: Work,
    signal: AbortSignal,
    save: (strict?: boolean) => void,
  ): Promise<"written" | "gone"> {
    const { rule, next, kind, action } = write;
    if (rule !== null && next.length === 0) {
      // Removing a rule needs no intent: gone before the state follows reads as "deleted in Outlook", and its entries are no longer wanted.
      await this.#retrying(() => this.#client.remove(rule.id, signal), signal);
      work.rules = work.rules.filter((r) => r.id !== rule.id);
      return "written";
    }
    if (rule !== null) {
      const intent: Intent = {
        ruleId: rule.id,
        nonce: rule.nonce,
        kind,
        action,
        entries: [...next],
      };
      const answer = await this.#intended(intent, work, save, () =>
        this.#retrying(
          () => this.#client.update(rule.id, conditionsOf(kind, next), signal),
          signal,
        ),
      );
      if (answer === "gone") {
        work.rules = work.rules.filter((r) => r.id !== rule.id);
        save();
        return "gone";
      }
      work.rules = work.rules.filter((r) => r.id !== rule.id);
      this.#settle(answer, { ...rule, entries: [...next] }, work, save);
      return "written";
    }
    if (work.rules.length + work.edited.length + work.intent.length >= GRAPH_MAX_RULES) {
      throw new RuleSpaceError();
    }
    const graphAction: GraphRuleAction =
      action === "trash" ? { delete: true } : { moveToFolder: await this.#junkId(work, signal) };
    const nonce = newNonce();
    const intent: Intent = { ruleId: null, nonce, kind, action, entries: [...next] };
    const created = await this.#intended(intent, work, save, () =>
      this.#client.create(
        { displayName: ruleName(nonce), conditions: conditionsOf(kind, next), action: graphAction },
        signal,
      ),
    );
    this.#settle(created, { id: created.id, nonce, kind, action, entries: [...next] }, work, save);
    return "written";
  }

  /**
   * The answer to a write, read as carefully as a list: a status says nothing about what was stored. A rule Outlook holds otherwise than written is
   * tracked, so that nothing is written on top of it, and it stops the round at the first rule rather than one rule per sync.
   */
  #settle(
    answer: GraphRule,
    record: RuleRecord,
    work: Work,
    save: (strict?: boolean) => void,
  ): void {
    // Not saved here: the state is 500 KB, the next intent carries this with it, and a round that dies first still has this write's intent on disk.
    if (holds(answer, record.nonce, record.kind, record.action, record.entries)) {
      work.rules.push(record);
      return;
    }
    work.edited.push(record);
    save();
    throw new AdapterError("REJECTED", "Outlook stores the rule differently than written");
  }

  /**
   * A write with its intent on disk first. A refusal wrote nothing, so the intent goes; after a 5xx or a timeout the rule may have changed, and
   * the intent stays for the next round, which reads what is there.
   */
  async #intended<T>(
    intent: Intent,
    work: Work,
    save: (strict?: boolean) => void,
    write: () => Promise<T>,
  ): Promise<T> {
    work.intent.push(intent);
    save(true);
    try {
      const answer = await write();
      work.intent = work.intent.filter((i) => i !== intent);
      return answer;
    } catch (error) {
      if (error instanceof AdapterError && error.code !== "TRANSIENT") {
        work.intent = work.intent.filter((i) => i !== intent);
      }
      throw error;
    }
  }

  async #retrying<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
    // After a 5xx or a timeout the outcome stays unknown, whatever the next attempt says: a 503 also silences the client, and that refusal
    // must not read as "nothing was written".
    let unknown: AdapterError | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        // In turn by design: a retry waits for the answer to the attempt before it.
        return await call();
      } catch (error) {
        const passing = error instanceof AdapterError && error.code === "TRANSIENT";
        if (!passing || attempt >= GRAPH_WRITE_RETRIES) throw unknown ?? error;
        unknown = error;
        await this.#sleep(this.#retryDelayMs * (attempt + 1), signal);
      }
    }
  }

  async verify(state: OpaqueState, signal?: AbortSignal): Promise<Drift> {
    const current = parseState(state);
    if (!graphStateHoldsRules(state)) {
      return {
        drifted: false,
        detail: "nothing mirrored",
        checkedAt: new Date().toISOString(),
        checks: [],
      };
    }
    const listing = await this.#client.list(signal);
    const remote = new Map(listing.rules.map((r) => [r.id, r]));
    let missing = 0;
    let changed = 0;
    for (const rule of current.rules) {
      const found = remote.get(rule.id);
      if (found === undefined) missing += 1;
      else if (!holds(found, rule.nonce, rule.kind, rule.action, rule.entries)) changed += 1;
    }
    // A rule the person switched off or edited is theirs, and no drift; one Outlook calls broken is: its senders are not blocked, and nobody chose that.
    const broken = current.edited.filter((r) => remote.get(r.id)?.hasError === true).length;
    const total = current.rules.length;
    const inPlace = total - missing - changed;
    const unresolved = current.intent.length;
    const ok = missing + changed + broken + unresolved === 0;
    return {
      drifted: !ok,
      detail: ok
        ? current.edited.length > 0
          ? `Outlook rules in place, ${String(current.edited.length)} changed there and left alone`
          : "Outlook rules in place"
        : `${String(missing)} missing, ${String(changed)} changed, ${String(broken)} in error, ${String(unresolved)} writes not confirmed`,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          name: "outlook-rules",
          ok: missing + changed === 0,
          detail: `${String(inPlace)} of ${String(total)} exactly as written`,
        },
        {
          name: "rules-in-error",
          ok: broken === 0,
          detail: `${String(broken)} in error`,
        },
        {
          name: "pending-writes",
          ok: unresolved === 0,
          detail: `${String(unresolved)} not confirmed`,
        },
      ],
    };
  }

  /**
   * Deletes every rule this lane wrote, each only when it still reads as written. Returns the state of what is LEFT: `rules` could not be deleted, and
   * the caller keeps the account; `edited` are not ours to delete, and the person is told they stay.
   */
  async uninstall(state: OpaqueState): Promise<OpaqueState> {
    const current = parseState(state);
    if (!graphStateHoldsRules(state)) return initialGraphState();
    // A person starts this, so it is not cut at the engine's 60 s, but it does end: what is not deleted by then is returned.
    const signal = AbortSignal.timeout(this.#uninstallDeadlineMs);
    const listing = await this.#client.list(signal);
    const work: Work = {
      rules: [...current.rules],
      edited: [...current.edited],
      intent: [...current.intent],
      junkFolderId: current.junkFolderId,
      capacity: current.capacity,
    };
    this.#resolveIntents(work, listing);
    const remote = new Map(listing.rules.map((r) => [r.id, r]));
    const left: RuleRecord[] = [];
    const edited: EditedRule[] = [];
    for (const rule of [...work.rules, ...work.edited]) {
      const found = remote.get(rule.id);
      // Gone: nothing to delete, and nothing to keep. Unless the list held a rule the client could not read: it may be this one.
      if (found === undefined) {
        if (maybeListed(listing, rule.id)) edited.push(rule);
        continue;
      }
      if (
        rule.entries.length === 0 ||
        !holds(found, rule.nonce, rule.kind, rule.action, rule.entries)
      ) {
        edited.push(rule);
        continue;
      }
      try {
        // In turn by design: one lane holds one request open.
        await this.#retrying(() => this.#client.remove(rule.id, signal), signal);
      } catch {
        left.push(rule);
      }
    }
    const data: GraphState = {
      rules: left,
      edited,
      intent: work.intent,
      junkFolderId: current.junkFolderId,
      capacity: current.capacity,
    };
    return { adapterId: GRAPH_ADAPTER_ID, data };
  }
}
