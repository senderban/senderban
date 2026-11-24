import { z } from "zod";
import { senderOf } from "./gmail/mail-client.js";
import type { GmailRecentReader } from "./gmail/budget.js";
import { sanitizeSubject } from "./watcher/watcher.js";

/**
 * One mail of the Recent mail view (017), whatever the provider: read when the view opens, kept in memory only (never on disk), so
 * the promise that a subject is not stored holds. `id` is the provider's own (an IMAP UID, a Gmail or Graph message id) and is never
 * shown.
 */
export interface RecentMail {
  readonly id: string;
  /** Validated, lowercased `local@domain`, or null when the sender could not be read safely: shown with nothing to click. */
  readonly from: string | null;
  /** Control and bidi characters removed, cut (sanitizeSubject). Display only. */
  readonly subject: string;
  /** When the provider received it. Unit: epoch milliseconds. Null when it gave none we can use. */
  readonly receivedMs: number | null;
}

/** What a row's button does: "block" the sender (the default action), or "mute" it (the "Don't ask again" list). */
export const RECENT_ACTS = ["block", "mute"] as const;
export type RecentAct = (typeof RECENT_ACTS)[number];

/** The page asks for the rows; `refresh` is the person's Refresh button. Checked in the main process: the page is untrusted. */
export const RecentRequestSchema = z.strictObject({ refresh: z.boolean() });
/** A row's button: the row's key (a UUID the main process gave with the rows) and what to do. No address crosses from the page. */
export const RecentActSchema = z.strictObject({ key: z.uuid(), act: z.enum(RECENT_ACTS) });

/**
 * Gmail messages one Recent read asks for at once. Unit: requests. Google counts concurrent requests per user and answers too many
 * with 429 (`rateLimitExceeded`); three keeps a look of ten messages near half a second of waiting.
 */
export const GMAIL_RECENT_CONCURRENCY = 3;
/**
 * The newest `max` Inbox mails of a Gmail account: one `messages.list`, then `messages.get` for each id not in `known` (the headers an
 * earlier look read, which a message keeps). `known` is updated in place and keeps only the ids of this answer, so it holds `max` at
 * most. A message deleted in between is left out.
 */
export async function readGmailRecent(
  reader: GmailRecentReader,
  known: Map<string, RecentMail>,
  max: number,
  signal?: AbortSignal,
): Promise<RecentMail[]> {
  const ids = await reader.inbox(max, signal);
  // A deadline that fired while the list came back: the listener below would never hear it, and the gets would spend quota.
  signal?.throwIfAborted();
  const missing = ids.filter((id) => !known.has(id));
  // The first failure stops the others: a 429 or a 401 on one get must not let the rest of the list spend quota after it.
  const stop = new AbortController();
  const onAbort = (): void => {
    stop.abort(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < missing.length) {
      stop.signal.throwIfAborted();
      const id = missing[next];
      next += 1;
      if (id === undefined) return;
      const message = await reader.message(id, stop.signal);
      if (message === "gone") continue;
      const sender = senderOf(message);
      const subject = message.headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
      known.set(id, {
        id,
        from: sender.ok ? sender.address : null,
        subject: sanitizeSubject(subject),
        receivedMs: message.receivedMs,
      });
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(GMAIL_RECENT_CONCURRENCY, missing.length) }, async () => {
        try {
          await worker();
        } catch (error) {
          stop.abort(error);
          throw error;
        }
      }),
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Only this answer's ids, failed read or not: `known` stays at `max`.
    for (const id of [...known.keys()]) {
      if (!ids.includes(id)) known.delete(id);
    }
  }
  return ids.flatMap((id) => {
    const mail = known.get(id);
    return mail === undefined ? [] : [mail];
  });
}
