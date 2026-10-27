import { z } from "zod";
import { AdapterError } from "../adapter.js";
import { createGoogleCaller } from "../google/call.js";
import type { GoogleCallerOptions } from "../google/call.js";
import { GOOGLE_BODY_MAX_BYTES, OVERSIZE, apiFailure, googleErrorReason } from "../google/http.js";
import { FROM_UNPARSABLE, parseFromHeaders } from "./from-header.js";
import type { FromResult, RawHeader } from "./from-header.js";

/** Gmail API, `users.*` for reading new mail (read 2026-10-26: `history.list` 2 units, `messages.get` 20, `getProfile` 1; all accept `gmail.metadata`). Fixed host. */
export const GMAIL_USER_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * A `historyId`: a decimal string that outgrows a double, so it stays a string and is compared as a BigInt. Unit: digits, 1 to 20
 * (a uint64 has 20 digits; a 20-digit value above its maximum is harmless because it is never turned into a number).
 */
export const HISTORY_ID = /^[0-9]{1,20}$/u;
/** A message id: Gmail's are 16 hex digits (seen); this stays wider and is always `encodeURIComponent`-ed. Unit: characters, 1 to 64. */
export const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** A page token comes only from Google and goes back into a query string. Unit: printable ASCII without space, 1 to 512. PROVISIONAL (upper bound). */
const PAGE_TOKEN = /^[!-~]{1,512}$/u;
const LABEL_ID_MAX_CHARS = 64;
const LABELS_MAX = 100;

/**
 * History records one `history.list` page asks for. Unit: records. Google's own default is 100 and its maximum 500; one record per
 * new message is the usual case, and the watcher reads at most a handful of messages per drain, so one page is nearly always the
 * whole answer. PROVISIONAL until G6 shows real mail.
 */
export const HISTORY_PAGE_SIZE = 100;
/** Headers one message answer may carry before it is not trusted. Unit: headers. We ask for `From` and `Subject` only, so more than a few is abuse. */
export const MESSAGE_HEADERS_MAX = 50;
/** One header name. Unit: characters (RFC 5322 does not cap it; the one we ask for is 4 to 7). */
const HEADER_NAME_MAX_CHARS = 128;
/** One header value. Unit: characters. A subject longer than the 998-character line limit is padding; it is read bounded and the display cuts it to 200. */
const HEADER_VALUE_MAX_CHARS = 8_192;

export interface HistoryMessage {
  readonly id: string;
  readonly labelIds: readonly string[];
}

export interface HistoryPage {
  /** New messages of this page in the order Google listed them, once each. */
  readonly messages: readonly HistoryMessage[];
  /** The mailbox's `historyId` as of this answer: the cursor to keep once the last page was read. */
  readonly historyId: string;
  readonly nextPageToken?: string;
  /** Records of the page that did not fit the expected shape and were skipped. */
  readonly unreadable: number;
}

/**
 * Fields the `messages.get` answer is cut to (Google's partial-response `fields`): the id, the labels and the two headers we ask
 * for. Seen live (G6, 2026-10-27, ADR 0009 "Measured live"): Google accepts it (200, 375 bytes against 512 without it) and, with the
 * `gmail.metadata` scope, sends no `snippet` either way; the cut stays so that a wider scope later cannot bring body text in.
 */
export const MESSAGE_FIELDS = "id,labelIds,payload/headers";

export interface MessageMetadata {
  readonly id: string;
  readonly labelIds: readonly string[];
  /** `From` and `Subject` headers, as Google returned them. */
  readonly headers: readonly RawHeader[];
  /**
   * False when a header could not be read (too long, wrong shape, too many): the sender must then not be trusted, because an
   * unreadable second `From` would make a single one look like the whole truth.
   */
  readonly headersComplete: boolean;
}

/** The `startHistoryId` is too old for Google to answer (404): mail in the gap was not announced. A fixed class, so the watcher can tell it from every other refusal. */
export class HistoryExpiredError extends AdapterError {
  constructor() {
    super("REJECTED", "Gmail no longer holds history that old");
    this.name = "HistoryExpiredError";
  }
}

/**
 * The sender of a message, or `from-unparsable`. This is the only way to read a sender off a `MessageMetadata`: a message whose
 * headers were not all readable (a dropped second `From` would make a single one look like the whole truth) is never trusted.
 * `parseFromHeaders` alone does not know about that flag.
 */
export function senderOf(message: MessageMetadata): FromResult {
  if (!message.headersComplete) return { ok: false, reason: FROM_UNPARSABLE };
  return parseFromHeaders(message.headers);
}

/**
 * One `history.list` page was larger than the read cap (a page of 100 records with many labels each): asking again reads the same
 * bytes, so the watcher treats it as a reported gap and starts from now, instead of asking for the same page for a week.
 */
export class HistoryTooLargeError extends AdapterError {
  constructor() {
    super("REJECTED", "a Gmail history page is larger than any valid one");
    this.name = "HistoryTooLargeError";
  }
}

/**
 * Fields the `history.list` answer is cut to: the added messages' ids and labels, the page token and the mailbox's `historyId`.
 * Without it each record also repeats the ids in `messages` and carries thread ids, about three times the bytes, and a page of 100
 * records can reach the 64 KiB read cap. PROVISIONAL: the syntax is read from the partial-response guide and must be seen live
 * (a wrong one would answer 400); `prettyPrint=false` removes the indentation Google adds by default.
 */
export const HISTORY_FIELDS =
  "history(messagesAdded(message(id,labelIds))),nextPageToken,historyId";

/**
 * An answer that did not have the expected shape (or named another message). The one TRANSIENT failure that belongs to the answer
 * and not to the network: asking again reads the same thing, so the watcher counts these against one message and gives it up,
 * while a timeout or a 5xx (also TRANSIENT) is a passing state it never gives a message up for.
 */
export class MalformedAnswerError extends AdapterError {
  constructor(what: string) {
    super("TRANSIENT", `Google answer is malformed (${what})`);
    this.name = "MalformedAnswerError";
  }
}

export interface GmailMailClient {
  /** The mailbox's current `historyId`: the starting cursor of a first run and of a gap. 1 unit. */
  profile(signal?: AbortSignal): Promise<{ readonly historyId: string }>;
  /** New INBOX messages after `startHistoryId`, one page. 2 units. `HistoryExpiredError` on 404. */
  history(startHistoryId: string, pageToken?: string, signal?: AbortSignal): Promise<HistoryPage>;
  /** From and Subject of one message, no body. 20 units. `"gone"` when it was deleted before we asked (404). */
  message(id: string, signal?: AbortSignal): Promise<MessageMetadata | "gone">;
}

const ProfileAnswer = z.looseObject({ historyId: z.string().regex(HISTORY_ID) });

const Labels = z.array(z.string().max(LABEL_ID_MAX_CHARS)).max(LABELS_MAX);
const HistoryAnswer = z.looseObject({
  history: z
    .array(z.unknown())
    .max(HISTORY_PAGE_SIZE * 5)
    .optional(),
  nextPageToken: z.string().regex(PAGE_TOKEN).optional(),
  historyId: z.string().regex(HISTORY_ID),
});
// A record's messages are checked one by one, so one odd id costs that message only (and is counted), not its siblings.
const HistoryRecord = z.looseObject({
  messagesAdded: z
    .array(z.unknown())
    .max(HISTORY_PAGE_SIZE * 5)
    .optional(),
});
const AddedMessage = z.looseObject({
  message: z.looseObject({ id: z.string().regex(MESSAGE_ID), labelIds: Labels.optional() }),
});

const MessageAnswer = z.looseObject({
  id: z.string().regex(MESSAGE_ID),
  labelIds: Labels.optional(),
  // Not bounded by the schema on purpose: more headers than MESSAGE_HEADERS_MAX must read as "headers not complete" (the sender is
  // then refused), not as a failed parse that the watcher would retry for ever. The 64 KiB body cap bounds the array itself.
  payload: z.looseObject({ headers: z.array(z.unknown()).optional() }).optional(),
});
const HeaderEntry = z.looseObject({
  name: z.string().min(1).max(HEADER_NAME_MAX_CHARS),
  value: z.string().max(HEADER_VALUE_MAX_CHARS),
});

export function createGmailMailClient(options: GoogleCallerOptions): GmailMailClient {
  const call = createGoogleCaller(options);
  const malformed = (what: string): AdapterError => new MalformedAnswerError(what);

  return {
    async profile(signal) {
      const { status, json } = await call(
        "profile",
        "profile",
        { method: "GET", url: `${GMAIL_USER_URL}/profile` },
        GOOGLE_BODY_MAX_BYTES,
        signal,
      );
      if (status !== 200) throw apiFailure(status, googleErrorReason(json), "profile");
      const parsed = ProfileAnswer.safeParse(json);
      if (!parsed.success) throw malformed("profile");
      return { historyId: parsed.data.historyId };
    },

    async history(startHistoryId, pageToken, signal) {
      if (!HISTORY_ID.test(startHistoryId)) {
        throw new AdapterError("REJECTED", "the history id is not a valid value");
      }
      if (pageToken !== undefined && !PAGE_TOKEN.test(pageToken)) {
        throw new AdapterError("REJECTED", "the page token is not a valid value");
      }
      const query = new URLSearchParams({
        startHistoryId,
        historyTypes: "messageAdded",
        labelId: "INBOX",
        maxResults: String(HISTORY_PAGE_SIZE),
        fields: HISTORY_FIELDS,
        prettyPrint: "false",
      });
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      let answer: { status: number; json: unknown };
      try {
        answer = await call(
          "history-list",
          "history list",
          { method: "GET", url: `${GMAIL_USER_URL}/history?${query.toString()}` },
          GOOGLE_BODY_MAX_BYTES,
          signal,
        );
      } catch (error) {
        // An answer over the cap is this page's own doing (asking again reads the same bytes), not a passing network state.
        if (
          error instanceof AdapterError &&
          error.code === "TRANSIENT" &&
          error.message.includes(OVERSIZE)
        ) {
          throw new HistoryTooLargeError();
        }
        throw error;
      }
      const { status, json } = answer;
      if (status === 404) throw new HistoryExpiredError();
      if (status !== 200) throw apiFailure(status, googleErrorReason(json), "history list");
      const parsed = HistoryAnswer.safeParse(json);
      if (!parsed.success) throw malformed("history list");

      const seen = new Set<string>();
      const messages: HistoryMessage[] = [];
      let unreadable = 0;
      for (const entry of parsed.data.history ?? []) {
        const record = HistoryRecord.safeParse(entry);
        if (!record.success) {
          unreadable += 1;
          continue;
        }
        for (const entry of record.data.messagesAdded ?? []) {
          const added = AddedMessage.safeParse(entry);
          if (!added.success) {
            unreadable += 1;
            continue;
          }
          const { id, labelIds } = added.data.message;
          if (seen.has(id)) continue;
          seen.add(id);
          messages.push({ id, labelIds: labelIds ?? [] });
        }
      }
      return {
        messages,
        historyId: parsed.data.historyId,
        ...(parsed.data.nextPageToken === undefined
          ? {}
          : { nextPageToken: parsed.data.nextPageToken }),
        unreadable,
      };
    },

    async message(id, signal) {
      if (!MESSAGE_ID.test(id)) {
        throw new AdapterError("REJECTED", "the message id is not a valid value");
      }
      const query = new URLSearchParams([
        ["format", "metadata"],
        ["metadataHeaders", "From"],
        ["metadataHeaders", "Subject"],
        ["fields", MESSAGE_FIELDS],
      ]);
      let answer: { status: number; json: unknown };
      try {
        answer = await call(
          "message-get",
          "message get",
          {
            method: "GET",
            url: `${GMAIL_USER_URL}/messages/${encodeURIComponent(id)}?${query.toString()}`,
          },
          GOOGLE_BODY_MAX_BYTES,
          signal,
        );
      } catch (error) {
        // An answer over the cap is this message's own doing (asking again reads the same bytes), not a passing network state.
        if (
          error instanceof AdapterError &&
          error.code === "TRANSIENT" &&
          error.message.includes(OVERSIZE)
        ) {
          throw malformed("message get");
        }
        throw error;
      }
      const { status, json } = answer;
      if (status === 404) return "gone";
      if (status !== 200) throw apiFailure(status, googleErrorReason(json), "message get");
      const parsed = MessageAnswer.safeParse(json);
      if (!parsed.success || parsed.data.id !== id) throw malformed("message get");

      const rawHeaders = parsed.data.payload?.headers ?? [];
      const headers: RawHeader[] = [];
      let headersComplete = rawHeaders.length <= MESSAGE_HEADERS_MAX;
      for (const entry of rawHeaders.slice(0, MESSAGE_HEADERS_MAX)) {
        const one = HeaderEntry.safeParse(entry);
        if (one.success) headers.push({ name: one.data.name, value: one.data.value });
        else headersComplete = false;
      }
      return { id, labelIds: parsed.data.labelIds ?? [], headers, headersComplete };
    },
  };
}
