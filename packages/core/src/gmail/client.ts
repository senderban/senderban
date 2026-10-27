import { z } from "zod";
import { AdapterError } from "../adapter.js";
import { createGoogleCaller } from "../google/call.js";
import { GOOGLE_BODY_MAX_BYTES, OVERSIZE, apiFailure, googleErrorReason } from "../google/http.js";
import type { GoogleCall } from "../google/http.js";

/** Gmail API, `users.settings.filters` (measured on a real account 2026-10-26, ADR 0009 "Measured live"). Fixed host. */
export const GMAIL_FILTERS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters";

/**
 * Longest `criteria.query` the client sends. Unit: characters, printable ASCII only. A query of 14,003 characters was
 * accepted and one of 28,003 answered `500` (measured, ASCII only); 50 addresses of the longest legal size are 13,003, so a
 * filter this lane builds always fits, and anything longer or non-ASCII is a bug that must not reach Google.
 */
export const GMAIL_QUERY_MAX_CHARS = 14_003;
const QUERY_SHAPE = /^[\x20-\x7e]+$/u;

/**
 * Bytes read from a filter list, at most. Unit: bytes. A Gmail account holds at most 1,000 filters (Gmail help, not
 * measured here) and the person's own may carry long queries, so the list is far larger than a profile answer;
 * 2 MiB is about 2 KiB per filter at that count. PROVISIONAL until a real large list is seen. A list that is cut off
 * is an error, never a shorter list: an adapter that acted on half a list would delete nothing and duplicate everything.
 */
export const GMAIL_LIST_MAX_BYTES = 2_097_152;

/** Filters in one list, at most. Unit: filters (twice the documented account limit, so a raised limit does not break the page). */
const LIST_MAX = 2_000;

/**
 * A filter id. Measured live 2026-10-27: a filter made by this lane has an id of 38 characters and one the person made
 * in Gmail has 74, both letters and digits only. Two samples do not prove the alphabet, so this stays wider: any
 * printable ASCII (no space) except the characters that change the meaning of a URL path (`/ \ ? # %`) and an id made
 * only of dots; it is always `encodeURIComponent`-ed into the path anyway. One shape for what Google may send and what
 * we send back, so an id we accepted can always be deleted. Unit: characters, 1 to 256. PROVISIONAL (upper bound).
 */
export const GMAIL_FILTER_ID = /^(?!\.+$)(?!.*[/\\?#%])[!-~]{1,256}$/u;

/**
 * Text fields of a filter's criteria, characters. Above the 28,003 wall measured for `query` (Google cannot hold a
 * longer one), so no filter Google accepted fails here.
 */
const CRITERIA_TEXT_MAX_CHARS = 32_768;
/** A label id is `TRASH`, `Label_123456789` or similar, characters; 100 labels is far above anything a filter holds. */
const LABEL_ID_MAX_CHARS = 64;
const LABELS_MAX = 100;
/** An address in `forward`, characters: the RFC 5321 path limit plus a margin. */
const FORWARD_MAX_CHARS = 320;
/** `size` is a message size in bytes; we never read it, so only "a whole number the JSON can hold". PROVISIONAL. */
const SIZE_MAX_BYTES = Number.MAX_SAFE_INTEGER;

/**
 * Bounded, not strict: Google may add fields, and the person's own filters (which the list returns too) use keys this
 * lane never writes. Unknown keys stay in the parsed object so the adapter can tell "exactly ours" from "ours plus
 * something the person added in Gmail".
 */
const Criteria = z.looseObject({
  from: z.string().max(CRITERIA_TEXT_MAX_CHARS).optional(),
  to: z.string().max(CRITERIA_TEXT_MAX_CHARS).optional(),
  subject: z.string().max(CRITERIA_TEXT_MAX_CHARS).optional(),
  query: z.string().max(CRITERIA_TEXT_MAX_CHARS).optional(),
  negatedQuery: z.string().max(CRITERIA_TEXT_MAX_CHARS).optional(),
  hasAttachment: z.boolean().optional(),
  excludeChats: z.boolean().optional(),
  size: z.number().int().min(0).max(SIZE_MAX_BYTES).optional(),
  sizeComparison: z.string().max(32).optional(),
});
const Action = z.looseObject({
  addLabelIds: z.array(z.string().max(LABEL_ID_MAX_CHARS)).max(LABELS_MAX).optional(),
  removeLabelIds: z.array(z.string().max(LABEL_ID_MAX_CHARS)).max(LABELS_MAX).optional(),
  forward: z.string().max(FORWARD_MAX_CHARS).optional(),
});
const FilterAnswer = z.looseObject({
  id: z.string().regex(GMAIL_FILTER_ID),
  criteria: Criteria.optional(),
  action: Action.optional(),
});
// Entries are checked one by one (not as one array), so a single filter of the person's that does not fit the bounds
// is counted as unreadable and skipped, and cannot stop the lane for the whole mailbox.
const ListAnswer = z.looseObject({ filter: z.array(z.unknown()).max(LIST_MAX).optional() });

export type GmailFilter = z.infer<typeof FilterAnswer>;

/** What `list` found: the readable filters, and how many entries it could not read (never ours: an id we hold passed the same check at create). */
export interface GmailFilterList {
  readonly filters: readonly GmailFilter[];
  readonly unreadable: number;
}

/**
 * Gmail holds no two identical filters: a second create with the same criteria and action answers `400`, reason
 * `failedPrecondition`, "Filter already exists" (measured 2026-10-27). Still a REJECTED error, but the adapter can tell
 * it from every other refusal: it means a filter with exactly this content is already there, ours from a lost answer or the person's.
 */
export class FilterExistsError extends AdapterError {
  constructor() {
    super("REJECTED", "Gmail already has an identical filter");
    this.name = "FilterExistsError";
  }
}

/** The one action this lane writes: the mail stays, in Trash (a filter does not accept `SPAM`, measured). */
export const GMAIL_FILTER_LABEL = "TRASH";

export interface GmailFilterClient {
  /** Every filter of the mailbox, the person's own included. */
  list(signal?: AbortSignal): Promise<GmailFilterList>;
  /**
   * One filter: `criteria.query` = the given query, action = add label TRASH. Not retried here, and an error (a 5xx, a
   * deadline, a malformed answer) means the outcome is UNKNOWN, not "not created": the caller reads the list before it
   * creates the same filter again.
   */
  create(query: string, signal?: AbortSignal): Promise<GmailFilter>;
  /** `gone` when Google no longer has it (404): the wanted end state, reported so the caller can say it. */
  remove(id: string, signal?: AbortSignal): Promise<"removed" | "gone">;
}

export interface GmailClientOptions {
  /**
   * An access token for this call; the caller owns refreshing and should cache it until it expires (3,599 s measured),
   * not refresh per call. It must throw `AdapterError` only: anything else is reported as a fixed `TRANSIENT`.
   */
  readonly getAccessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Called once per request, when the answer's headers are in (or when no answer came). */
  readonly onCall?: (call: GoogleCall) => void;
}

/** `failedPrecondition` alone is not enough (other preconditions exist): the message must say it too. Read, never repeated. */
function isAlreadyExists(json: unknown): boolean {
  if (googleErrorReason(json) !== "failedPrecondition") return false;
  const message = ((json as { error?: { message?: unknown } }).error ?? {}).message;
  return typeof message === "string" && /already exists/iu.test(message);
}

export function createGmailClient(options: GmailClientOptions): GmailFilterClient {
  const call = createGoogleCaller(options);

  const failure = (status: number, json: unknown, what: string): AdapterError =>
    apiFailure(status, googleErrorReason(json), what);
  const malformed = (what: string): AdapterError =>
    new AdapterError("TRANSIENT", `Google answer is malformed (${what})`);

  return {
    async list(signal) {
      let answer: { status: number; json: unknown };
      try {
        answer = await call(
          "filter-list",
          "filters list",
          { method: "GET", url: GMAIL_FILTERS_URL },
          GMAIL_LIST_MAX_BYTES,
          signal,
        );
      } catch (error) {
        // Too big to read is not a passing state: asking again reads the same list. Refused, so the engine does not retry it.
        if (
          error instanceof AdapterError &&
          error.code === "TRANSIENT" &&
          error.message.includes(OVERSIZE)
        ) {
          throw new AdapterError(
            "REJECTED",
            "the Gmail filter list is larger than Senderban reads",
          );
        }
        throw error;
      }
      const { status, json } = answer;
      if (status !== 200) throw failure(status, json, "filters list");
      const parsed = ListAnswer.safeParse(json);
      if (!parsed.success) throw malformed("filters list");
      // No `filter` key at all is how Gmail says "no filters".
      const filters: GmailFilter[] = [];
      let unreadable = 0;
      for (const entry of parsed.data.filter ?? []) {
        const one = FilterAnswer.safeParse(entry);
        if (one.success) filters.push(one.data);
        else unreadable += 1;
      }
      return { filters, unreadable };
    },

    async create(query, signal) {
      if (query.length === 0 || query.length > GMAIL_QUERY_MAX_CHARS || !QUERY_SHAPE.test(query)) {
        throw new AdapterError("REJECTED", "the filter query is outside the measured size");
      }
      const body = JSON.stringify({
        criteria: { query },
        action: { addLabelIds: [GMAIL_FILTER_LABEL] },
      });
      const { status, json } = await call(
        "filter-create",
        "filter create",
        { method: "POST", url: GMAIL_FILTERS_URL, body },
        GOOGLE_BODY_MAX_BYTES,
        signal,
      );
      if (status === 400 && isAlreadyExists(json)) throw new FilterExistsError();
      if (status !== 200) throw failure(status, json, "filter create");
      const parsed = FilterAnswer.safeParse(json);
      if (!parsed.success) throw malformed("filter create");
      return parsed.data;
    },

    async remove(id, signal) {
      if (!GMAIL_FILTER_ID.test(id)) {
        throw new AdapterError("REJECTED", "the filter id is not a valid value");
      }
      const { status, json } = await call(
        "filter-delete",
        "filter delete",
        { method: "DELETE", url: `${GMAIL_FILTERS_URL}/${encodeURIComponent(id)}` },
        GOOGLE_BODY_MAX_BYTES,
        signal,
      );
      if (status === 204 || status === 200) return "removed";
      if (status === 404) return "gone";
      throw failure(status, json, "filter delete");
    },
  };
}
