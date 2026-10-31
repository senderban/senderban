import { OutlookWatcher } from "@senderban/core";
import type { Gate, OutlookCursorStore, OutlookGap, OwnMail } from "@senderban/core";
import { blockableDomain } from "@senderban/core";
import { createMailWatchers } from "./mail-watchers.js";
import type { MailWatchers, MailWatchersDeps } from "./mail-watchers.js";
import { microsoftLogTag, outlookCover } from "./microsoft-lanes.js";
import type { MicrosoftLane } from "./microsoft-lanes.js";

const GAP_TEXT: Record<OutlookGap, string> = {
  unreadable: "Some new mail could not be read and was not announced.",
  "too-large":
    "A burst of new mail was too large to read at once, so the mail that arrived since the last check was not announced.",
};

export interface OutlookWatchersDeps extends MailWatchersDeps {
  readonly lanes: readonly MicrosoftLane[];
  /** The store's Outlook cursors; `delete` is for an account that is gone. */
  readonly cursors: OutlookCursorStore & { delete(accountId: string): void };
  /** The Outlook polls' own gate: an outage at Microsoft must not hold the slots of IMAP logins or Gmail polls. */
  readonly gate: Gate;
  /** The person's own mail as it is now: a domain the Outlook rule could not take is not offered. */
  readonly own: () => OwnMail;
  readonly random?: () => number;
}

export function createOutlookWatchers(deps: OutlookWatchersDeps): MailWatchers {
  return createMailWatchers(
    deps.lanes,
    {
      prefix: "outlook",
      who: "Microsoft",
      service: "Outlook",
      gapText: GAP_TEXT,
      laneId: (lane) => lane.laneId,
      tag: (lane) => microsoftLogTag(lane.accountId),
      create: (lane, hooks) =>
        new OutlookWatcher({
          // The lane id is the account id of everything that follows: the pending block, the toast click, the engine lane, the cursor.
          accountId: lane.laneId,
          client: lane.mail,
          cursors: deps.cursors,
          gate: deps.gate,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.random === undefined ? {} : { random: deps.random }),
          ...hooks,
        }),
      // Junk and Trash both exist as rule actions. No score: Graph gives none to this permission. No server refusal: only MXroute refuses at the door.
      toast: (sender) => {
        const own = deps.own();
        const domain = blockableDomain(sender, own);
        return {
          spamScore: null,
          domain:
            domain !== null && outlookCover({ match: "subdomains", value: domain }, own) !== "no"
              ? domain
              : null,
          rejectsAtServer: false,
        };
      },
      forgetCursor: (laneId) => {
        deps.cursors.delete(laneId);
      },
    },
    deps,
  );
}
