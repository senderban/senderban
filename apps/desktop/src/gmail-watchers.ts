import { GmailWatcher } from "@senderban/core";
import type { Gate, GmailCursorStore, GmailGap } from "@senderban/core";
import { gmailLogTag } from "./gmail-lanes.js";
import type { GmailLane } from "./gmail-lanes.js";
import {
  MAIL_HEARTBEAT_MS,
  MAIL_NOTICE_EVERY_MS,
  NOTICE_SUBJECT_MAX,
  createMailWatchers,
  subjectLine,
} from "./mail-watchers.js";
import type { MailWatchers, MailWatchersDeps } from "./mail-watchers.js";

export { NOTICE_SUBJECT_MAX, subjectLine };
export const GMAIL_NOTICE_EVERY_MS = MAIL_NOTICE_EVERY_MS;
export const GMAIL_HEARTBEAT_MS = MAIL_HEARTBEAT_MS;

const GAP_TEXT: Record<GmailGap, string> = {
  expired:
    "Senderban lost track of new mail (it was offline too long for Gmail to remember), so mail from that time was not announced.",
  unreadable: "Some new mail could not be read and was not announced.",
  skipped: "A new message could not be read after several tries and was not announced.",
  overflow: "More new mail arrived than one check reads, so the oldest was not announced.",
  "too-large":
    "A burst of new mail was too large to read at once, so the mail that arrived since the last check was not announced.",
};

export interface GmailWatchersDeps extends MailWatchersDeps {
  readonly lanes: readonly GmailLane[];
  /** The store's Gmail cursors; `delete` is for an account that is gone. */
  readonly cursors: GmailCursorStore & { delete(accountId: string): void };
  /** The Gmail polls' own gate (not the IMAP logins'): it bounds how many polls run at once. */
  readonly gate: Gate;
  readonly random?: () => number;
}

export type GmailWatchers = MailWatchers;

export function createGmailWatchers(deps: GmailWatchersDeps): GmailWatchers {
  return createMailWatchers(
    deps.lanes,
    {
      prefix: "gmail",
      who: "Google",
      service: "Gmail",
      gapText: GAP_TEXT,
      laneId: (lane) => lane.laneId,
      tag: (lane) => gmailLogTag(lane.accountId),
      create: (lane, hooks) =>
        new GmailWatcher({
          // The lane id is the account id of everything that follows: the pending block, the toast click, the engine lane, the cursor.
          accountId: lane.laneId,
          client: lane.mail,
          cursors: deps.cursors,
          gate: deps.gate,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.random === undefined ? {} : { random: deps.random }),
          ...hooks,
        }),
      // A Gmail filter takes a single address and Trash only (ADR 0009 point 6): no domain button, no Junk, no server refusal.
      toast: () => ({ spamScore: null, domain: null, rejectsAtServer: false, trashOnly: true }),
      forgetCursor: (laneId) => {
        deps.cursors.delete(laneId);
      },
    },
    deps,
  );
}
