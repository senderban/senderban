import { z } from "zod";
import { AdapterError } from "../adapter.js";
import { createBearerCaller } from "../oauth/bearer.js";
import type { BearerCall } from "../oauth/bearer.js";
import { OVERSIZE } from "../oauth/http.js";

/** Microsoft Graph v1.0, `mailFolder` and `messageRule` (read 2026-10-31, https://learn.microsoft.com/en-us/graph/api/resources/messagerule). Fixed host. */
export const GRAPH_RULES_URL = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules";
export const GRAPH_JUNK_URL =
  "https://graph.microsoft.com/v1.0/me/mailFolders/junkemail?$select=id";

/** One request to Graph: connect, answer and body. Unit: milliseconds. */
export const GRAPH_TIMEOUT_MS = 15_000;
/** Bytes read from a single rule or folder answer. Unit: bytes. A rule of 100 addresses is about 10 KiB of JSON; PROVISIONAL. */
export const GRAPH_BODY_MAX_BYTES = 262_144;
/**
 * Bytes read from one page of the rule list. Unit: bytes. Exchange Online holds 256 KiB of rules (Set-Mailbox -RulesQuota, read
 * 2026-10-24); their JSON is several times that, the person's own rules included. A list that is cut off is an error, never a shorter list.
 */
export const GRAPH_LIST_MAX_BYTES = 4_194_304;
/** Pages of the rule list, at most. Unit: pages. Graph has not been seen paging rules; a loop must still end. */
export const GRAPH_LIST_MAX_PAGES = 10;
/** Rules on one page, at most. Unit: rules. 256 KiB cannot hold more than a few thousand. PROVISIONAL. */
const LIST_MAX = 2_000;
/** The longest access token. Unit: characters. Microsoft documents none and says they are opaque; PROVISIONAL. */
export const GRAPH_ACCESS_TOKEN_MAX_CHARS = 16_384;
/**
 * Longest wait a `Retry-After` may set. Unit: seconds. An answer of a day must not silence an account for a day: past this the
 * engine's own backoff decides again.
 */
export const GRAPH_RETRY_AFTER_MAX_S = 3_600;
/** Wait when a 429 or a 503 names none, or names one that cannot be read (Microsoft: back off). Unit: seconds. */
export const GRAPH_RETRY_AFTER_DEFAULT_S = 30;

/** A rule or folder id: opaque (`AQAAAJ5dZqA=` in the docs), so any printable ASCII, always `encodeURIComponent`-ed. Characters. PROVISIONAL. */
export const GRAPH_ID = /^(?!\.+$)[!-~]{1,1024}$/u;

/** The name of every rule this lane writes: the prefix says whose it is, the nonce which one (a create whose answer was lost is found by it). */
export const GRAPH_RULE_NAME = /^Senderban [0-9a-f]{16}$/u;

/** Strings of one condition, at most, in one request. Unit: strings. Twice the most a lane puts in a rule (GRAPH_STRINGS_PER_RULE). */
export const GRAPH_MAX_STRINGS_IN_REQUEST = 200;
/** One string of a condition. Unit: characters. An address is at most 254, and `@` plus a domain less. */
const STRING_MAX_CHARS = 254;
/** A mail address or a part of one, printable ASCII: nothing a person's list can hold is longer or wider. */
const CONDITION_STRING = /^[!-~]+$/u;

const Text = z.string().max(1_024);
/** What an address of the person's own rule may look like: bounded, nothing more (it is read, never written). */
const Recipient = z.looseObject({
  emailAddress: z.looseObject({
    name: Text.nullish(),
    address: Text.nullish(),
  }),
});

/**
 * Bounded, not strict: Graph may add fields, and the person's own rules use keys this lane never writes. Unknown keys stay in the parsed
 * object so the adapter can tell "exactly ours" from "ours plus something the person added".
 */
const Predicates = z.looseObject({
  fromAddresses: z
    .array(Recipient)
    .max(GRAPH_MAX_STRINGS_IN_REQUEST * 50)
    .nullish(),
  senderContains: z
    .array(Text)
    .max(GRAPH_MAX_STRINGS_IN_REQUEST * 50)
    .nullish(),
});
const Actions = z.looseObject({
  delete: z.boolean().nullish(),
  moveToFolder: Text.nullish(),
  stopProcessingRules: z.boolean().nullish(),
});
const RuleAnswer = z.looseObject({
  id: z.string().regex(GRAPH_ID),
  displayName: Text.nullish(),
  isEnabled: z.boolean().nullish(),
  isReadOnly: z.boolean().nullish(),
  hasError: z.boolean().nullish(),
  conditions: Predicates.nullish(),
  exceptions: z.looseObject({}).nullish(),
  actions: Actions.nullish(),
});
export type GraphRule = z.infer<typeof RuleAnswer>;

// Entries are checked one by one, so a single rule of the person's that does not fit the bounds is counted as unreadable and skipped,
// and cannot stop the lane for the whole mailbox.
const ListAnswer = z.looseObject({
  value: z.array(z.unknown()).max(LIST_MAX),
  "@odata.nextLink": z.string().max(2_048).optional(),
});
const RuleId = z.looseObject({ id: z.string().regex(GRAPH_ID) });
const FolderAnswer = z.looseObject({ id: z.string().regex(GRAPH_ID) });
const ErrorAnswer = z.looseObject({
  error: z.looseObject({ code: z.string().max(128).optional() }),
});

export interface GraphRuleList {
  readonly rules: readonly GraphRule[];
  /** Entries that could not be read. One of ours can be among them, grown past the bounds in Outlook. */
  readonly unreadable: number;
  /** The ids of those that have a readable id: a rule in neither list is gone, unless some entry had no id at all. */
  readonly unreadableIds: ReadonlySet<string>;
}

/** The one condition of a rule this lane writes. A rule never holds both: conditions of one rule are all required. */
export type GraphConditions =
  { readonly fromAddresses: readonly string[] } | { readonly senderContains: readonly string[] };

export type GraphRuleAction = { readonly moveToFolder: string } | { readonly delete: true };

export interface GraphNewRule {
  readonly displayName: string;
  readonly conditions: GraphConditions;
  readonly action: GraphRuleAction;
}

/**
 * Outlook refused a rule for what it holds (400, 413, 422): usually too much, and the number is not documented. Still `REJECTED`, but
 * the adapter can tell it from every other refusal and tries a smaller rule.
 */
export class RuleRefusedError extends AdapterError {
  constructor() {
    super("REJECTED", "Outlook refused the rule");
    this.name = "RuleRefusedError";
  }
}

/** The mailbox has no room for more rules (507, or an error code that says quota): smaller rules take the same room. */
export class RuleSpaceError extends AdapterError {
  constructor() {
    super("REJECTED", "Outlook has no room for more rules on this mailbox");
    this.name = "RuleSpaceError";
  }
}

export interface GraphRuleClient {
  /** The id of the Junk Email folder. */
  junkFolderId(signal?: AbortSignal): Promise<string>;
  /** Every rule of the Inbox, the person's own included. */
  list(signal?: AbortSignal): Promise<GraphRuleList>;
  /**
   * One rule: enabled, first in the order, stops the rules after it. Not retried here, and an error (a 5xx, a deadline, a malformed
   * answer) means the outcome is UNKNOWN, not "not created": the caller reads the list before it creates the same rule again.
   */
  create(rule: GraphNewRule, signal?: AbortSignal): Promise<GraphRule>;
  /** Replaces the rule's one condition. `gone` when it no longer exists. */
  update(
    id: string,
    conditions: GraphConditions,
    signal?: AbortSignal,
  ): Promise<GraphRule | "gone">;
  /** `gone` when Graph no longer has it (404): the wanted end state, reported so the caller can say it. */
  remove(id: string, signal?: AbortSignal): Promise<"removed" | "gone">;
}

export type GraphCall = BearerCall<
  "junk" | "rule-list" | "rule-create" | "rule-update" | "rule-delete"
>;

export interface GraphClientOptions {
  /** An access token for this call; the caller owns refreshing. It must throw `AdapterError` only. */
  readonly getAccessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Called once per request, when the answer's headers are in (or when no answer came). */
  readonly onCall?: (call: GraphCall) => void;
  /** Injectable for tests. Milliseconds. */
  readonly now?: () => number;
}

function errorCode(json: unknown): string | null {
  const parsed = ErrorAnswer.safeParse(json);
  const code = parsed.success ? parsed.data.error.code : undefined;
  return code !== undefined && /^[A-Za-z0-9_.-]{1,128}$/u.test(code) ? code : null;
}

/**
 * A failed Graph call as an adapter error. Fixed texts only: no body, no address, no token reaches a log. `message` is not read: Microsoft
 * says to code against `code` (https://learn.microsoft.com/en-us/graph/errors).
 */
function failure(status: number, json: unknown, what: string): AdapterError {
  if (status === 401)
    return new AdapterError("AUTH_REQUIRED", `Microsoft refused the sign-in (${what})`);
  if (status === 403) {
    return new AdapterError(
      "AUTH_REQUIRED",
      `Microsoft refused the permission, your organization may have to approve Senderban (${what})`,
    );
  }
  if (status === 429)
    return new AdapterError("QUOTA_EXCEEDED", `Microsoft asked to slow down (${what})`);
  if (status === 507 || /quota/iu.test(errorCode(json) ?? "")) return new RuleSpaceError();
  if (status >= 500) {
    return new AdapterError(
      "TRANSIENT",
      `Microsoft is busy or unavailable (${what}, ${String(status)})`,
    );
  }
  return new AdapterError("REJECTED", `Microsoft refused the request (${what}, ${String(status)})`);
}

/** Seconds from `Retry-After`, a number or an HTTP date (RFC 9110 §10.2.3), inside the limits. */
function retryAfterSeconds(value: string | null, now: number): number {
  let seconds = GRAPH_RETRY_AFTER_DEFAULT_S;
  if (value !== null) {
    const trimmed = value.trim();
    const date = Date.parse(trimmed);
    if (/^[0-9]{1,9}$/u.test(trimmed)) seconds = Number(trimmed);
    else if (Number.isFinite(date)) seconds = Math.ceil((date - now) / 1_000);
  }
  return Math.min(Math.max(seconds, 1), GRAPH_RETRY_AFTER_MAX_S);
}

/** A next link is an answer like any other: the token goes to Graph's own host and version or nowhere. The rest of its form is not measured. */
function isGraphLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === new URL(GRAPH_RULES_URL).origin &&
      url.pathname.startsWith("/v1.0/") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function checkConditions(conditions: GraphConditions): void {
  const strings =
    "fromAddresses" in conditions ? conditions.fromAddresses : conditions.senderContains;
  if (
    strings.length === 0 ||
    strings.length > GRAPH_MAX_STRINGS_IN_REQUEST ||
    strings.some((s) => s.length > STRING_MAX_CHARS || !CONDITION_STRING.test(s))
  ) {
    throw new AdapterError("REJECTED", "the rule is outside the allowed size");
  }
}

const conditionsBody = (conditions: GraphConditions): unknown =>
  "fromAddresses" in conditions
    ? {
        fromAddresses: conditions.fromAddresses.map((address) => ({ emailAddress: { address } })),
      }
    : { senderContains: conditions.senderContains };

export function createGraphClient(options: GraphClientOptions): GraphRuleClient {
  const now = options.now ?? Date.now;
  const call = createBearerCaller<GraphCall["op"]>({
    who: "Microsoft",
    getAccessToken: options.getAccessToken,
    maxTokenChars: GRAPH_ACCESS_TOKEN_MAX_CHARS,
    timeoutMs: options.timeoutMs ?? GRAPH_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
  });
  /** Until when Microsoft asked for quiet. Waiting it out is what ends a throttle soonest: it counts what is sent meanwhile. */
  let quietUntil = 0;

  const send = async (
    op: GraphCall["op"],
    what: string,
    request: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; body?: string },
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; json: unknown }> => {
    if (now() < quietUntil) {
      throw new AdapterError("QUOTA_EXCEEDED", `Microsoft asked to slow down (${what})`);
    }
    const answer = await call(op, what, request, maxBytes, signal);
    if (answer.status === 429 || answer.status === 503) {
      quietUntil = now() + retryAfterSeconds(answer.retryAfter, now()) * 1_000;
    }
    return answer;
  };
  const malformed = (what: string): AdapterError =>
    new AdapterError("TRANSIENT", `Microsoft answer is malformed (${what})`);
  const refused = (status: number, json: unknown, what: string): AdapterError => {
    const error = failure(status, json, what);
    return error.code === "REJECTED" &&
      !(error instanceof RuleSpaceError) &&
      (status === 400 || status === 413 || status === 422)
      ? new RuleRefusedError()
      : error;
  };
  const ruleUrl = (id: string): string => {
    if (!GRAPH_ID.test(id)) throw new AdapterError("REJECTED", "the rule id is not a valid value");
    return `${GRAPH_RULES_URL}/${encodeURIComponent(id)}`;
  };

  async function page(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; json: unknown }> {
    try {
      return await send(
        "rule-list",
        "rules list",
        { method: "GET", url },
        GRAPH_LIST_MAX_BYTES,
        signal,
      );
    } catch (error) {
      // Too big to read is not a passing state: asking again reads the same list. Refused, so the engine does not retry it.
      if (
        error instanceof AdapterError &&
        error.code === "TRANSIENT" &&
        error.message.includes(OVERSIZE)
      ) {
        throw new AdapterError("REJECTED", "the rule list is larger than Senderban reads");
      }
      throw error;
    }
  }

  return {
    async junkFolderId(signal) {
      const { status, json } = await send(
        "junk",
        "junk folder",
        { method: "GET", url: GRAPH_JUNK_URL },
        GRAPH_BODY_MAX_BYTES,
        signal,
      );
      if (status !== 200) throw failure(status, json, "junk folder");
      const parsed = FolderAnswer.safeParse(json);
      if (!parsed.success) throw malformed("junk folder");
      return parsed.data.id;
    },

    async list(signal) {
      const rules: GraphRule[] = [];
      let unreadable = 0;
      const unreadableIds = new Set<string>();
      let url: string | undefined = GRAPH_RULES_URL;
      for (let pages = 0; url !== undefined; pages += 1) {
        if (pages >= GRAPH_LIST_MAX_PAGES) {
          throw new AdapterError("REJECTED", "the rule list is larger than Senderban reads");
        }
        // One page after the other by design: a next link exists only once the page before it was read.
        const { status, json } = await page(url, signal);
        if (status !== 200) throw failure(status, json, "rules list");
        const parsed = ListAnswer.safeParse(json);
        if (!parsed.success) throw malformed("rules list");
        for (const entry of parsed.data.value) {
          const one = RuleAnswer.safeParse(entry);
          if (one.success) rules.push(one.data);
          else {
            unreadable += 1;
            const id = RuleId.safeParse(entry);
            if (id.success) unreadableIds.add(id.data.id);
          }
        }
        const next = parsed.data["@odata.nextLink"];
        if (next !== undefined && !isGraphLink(next)) throw malformed("rules list");
        url = next;
      }
      return { rules, unreadable, unreadableIds };
    },

    async create(rule, signal) {
      checkConditions(rule.conditions);
      if (!GRAPH_RULE_NAME.test(rule.displayName)) {
        throw new AdapterError("REJECTED", "the rule name is not a valid value");
      }
      const body = JSON.stringify({
        displayName: rule.displayName,
        sequence: 1,
        isEnabled: true,
        conditions: conditionsBody(rule.conditions),
        actions: { ...rule.action, stopProcessingRules: true },
      });
      const { status, json } = await send(
        "rule-create",
        "rule create",
        { method: "POST", url: GRAPH_RULES_URL, body },
        GRAPH_BODY_MAX_BYTES,
        signal,
      );
      if (status !== 201) throw refused(status, json, "rule create");
      const parsed = RuleAnswer.safeParse(json);
      if (!parsed.success) throw malformed("rule create");
      return parsed.data;
    },

    async update(id, conditions, signal) {
      checkConditions(conditions);
      const { status, json } = await send(
        "rule-update",
        "rule update",
        {
          method: "PATCH",
          url: ruleUrl(id),
          body: JSON.stringify({ conditions: conditionsBody(conditions) }),
        },
        GRAPH_BODY_MAX_BYTES,
        signal,
      );
      if (status === 404) return "gone";
      if (status !== 200) throw refused(status, json, "rule update");
      const parsed = RuleAnswer.safeParse(json);
      if (!parsed.success) throw malformed("rule update");
      return parsed.data;
    },

    async remove(id, signal) {
      const { status, json } = await send(
        "rule-delete",
        "rule delete",
        { method: "DELETE", url: ruleUrl(id) },
        GRAPH_BODY_MAX_BYTES,
        signal,
      );
      if (status === 204 || status === 200) return "removed";
      if (status === 404) return "gone";
      throw failure(status, json, "rule delete");
    },
  };
}
