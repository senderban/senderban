import { GmailWatcher } from "@senderban/core";
import type {
  Gate,
  GmailBackoffDetail,
  GmailCursorStore,
  GmailGap,
  GmailIncoming,
  GmailPollEvent,
  GmailWatcherState,
  MailToast,
  PendingBlock,
} from "@senderban/core";
import { gmailLogTag } from "./gmail-lanes.js";
import type { GmailLane } from "./gmail-lanes.js";
import type { Log } from "./log.js";

// Scale budget (ADR 0009 point 5, .task/gmail-watcher.md A0): one watcher per Gmail account with a lane, each with its own timer
// and one poll in the air; the polls of all accounts go through the one shared gate. This module keeps one throttle entry per
// (account, notice kind): at most MAX_ACCOUNTS x 4 small entries, replaced in place. No timer of its own.

/**
 * A notice of the same kind about the same account is shown at most this often; the log line is written every time. Unit:
 * milliseconds. One hour: a backoff that keeps failing or a gap that repeats must not become a stream of toasts, and a problem that
 * lasts longer than an hour is worth saying again.
 */
export const GMAIL_NOTICE_EVERY_MS = 3_600_000;

type NoticeKind = GmailGap | "quota" | "halted-auth" | "halted-rejected";

const GAP_TEXT: Record<GmailGap, string> = {
  expired:
    "Senderban lost track of new mail (it was offline too long for Gmail to remember), so mail from that time was not announced.",
  unreadable: "Some new mail could not be read and was not announced.",
  skipped: "A new message could not be read after several tries and was not announced.",
  overflow: "More new mail arrived than one check reads, so the oldest was not announced.",
};

export interface GmailWatchersDeps {
  readonly lanes: readonly GmailLane[];
  /** The store's Gmail cursors; `delete` is for an account that is gone. */
  readonly cursors: GmailCursorStore & { delete(accountId: string): void };
  /** The one gate of the app (the IMAP logins use it too): it bounds how many polls and logins run at once. */
  readonly gate: Gate;
  readonly pending: { add(block: PendingBlock): string };
  readonly showMail: (toast: MailToast) => void;
  /** A toast without buttons. */
  readonly notice: (title: string, body: string) => void;
  /** Lane id -> the name the person knows the account by (`me@gmail.com (Gmail)`). */
  readonly labelOf: (laneId: string) => string;
  /** True for a lane held still for a removal: `start()` leaves it alone (an un-pause must not wake it). */
  readonly isHeld?: (laneId: string) => boolean;
  /** Every state change, for the tray. */
  readonly onState: (laneId: string, state: GmailWatcherState) => void;
  readonly log: Log;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface GmailWatchers {
  start(): void;
  /** Stops every watcher (pause, quit). */
  stop(): void;
  /** After system resume. */
  resumeNow(): void;
  /** One lane, held still for a removal or sign-out (`stop`), or free again (`start`). Unknown lane: nothing. */
  stopOne(laneId: string): void;
  startOne(laneId: string): void;
  /** The account is gone or signed out: its watcher is stopped and dropped, its cursor deleted. */
  forget(laneId: string): void;
  /** Watchers alive (for tests and the tray). */
  readonly size: number;
}

export function createGmailWatchers(deps: GmailWatchersDeps): GmailWatchers {
  const now = deps.now ?? Date.now;
  const watchers = new Map<string, GmailWatcher>();
  const noticed = new Map<string, Map<NoticeKind, number>>();

  /** Tells the person at most once an hour per (account, kind). */
  const tell = (laneId: string, kind: NoticeKind, title: string, body: string): void => {
    const kinds = noticed.get(laneId) ?? new Map<NoticeKind, number>();
    noticed.set(laneId, kinds);
    const last = kinds.get(kind);
    if (last !== undefined && now() - last < GMAIL_NOTICE_EVERY_MS) return;
    kinds.set(kind, now());
    deps.notice(title, body);
  };

  const states = new Map<string, GmailWatcherState>();

  for (const lane of deps.lanes) {
    const laneId = lane.laneId;
    const tag = gmailLogTag(lane.accountId);
    const label = (): string => deps.labelOf(laneId);
    watchers.set(
      laneId,
      new GmailWatcher({
        // The lane id is the account id of everything that follows: the pending block, the toast click, the engine lane, the cursor.
        accountId: laneId,
        client: lane.mail,
        cursors: deps.cursors,
        gate: deps.gate,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.random === undefined ? {} : { random: deps.random }),
        onMessage: (_id: string, message: GmailIncoming) => {
          if (message.from === null) {
            // The sender could not be read safely (a second From, an odd header): announced, with nothing to click.
            deps.log("gmail-announce", { account: tag, sender: "unreadable" });
            deps.notice(
              "Senderban",
              `New mail in ${label()}: the sender could not be read safely, so there is no Block button.${message.subject === "" ? "" : ` ${message.subject}`}`,
            );
            return;
          }
          const id = deps.pending.add({ accountId: laneId, sender: message.from });
          deps.log("gmail-announce", {
            account: tag,
            domain: message.from.slice(message.from.lastIndexOf("@") + 1),
          });
          deps.showMail({
            id,
            sender: message.from,
            subject: message.subject,
            account: label(),
            spamScore: null,
            // A Gmail filter takes a single address and Trash only (ADR 0009 point 6): no domain button, no Junk, no server refusal.
            domain: null,
            rejectsAtServer: false,
            trashOnly: true,
          });
        },
        onOverflow: (_id: string, skipped: number) => {
          deps.log("gmail-overflow", { account: tag, skipped });
          tell(
            laneId,
            "overflow",
            "Senderban",
            `${String(skipped)} more new messages in ${label()} were not announced.`,
          );
        },
        onGap: (_id: string, gap: GmailGap) => {
          deps.log("gmail-gap", { account: tag, gap });
          tell(laneId, gap, "Senderban", `${label()}: ${GAP_TEXT[gap]}`);
        },
        onState: (_id: string, state: GmailWatcherState, detail?: GmailBackoffDetail) => {
          const previous = states.get(laneId);
          states.set(laneId, state);
          deps.log("gmail-watcher", { account: tag, state, detail });
          deps.onState(laneId, state);
          if (previous === state) return;
          if (state === "halted-auth") {
            tell(
              laneId,
              "halted-auth",
              "Senderban stopped watching",
              `${label()}: Google refused the sign-in. Sign in again under Gmail accounts in Blocked senders, then restart Senderban.`,
            );
          } else if (state === "halted-rejected") {
            tell(
              laneId,
              "halted-rejected",
              "Senderban stopped watching",
              `${label()}: Google kept refusing the checks for new mail. Restart Senderban to try again.`,
            );
          } else if (state === "backoff" && detail === "quota") {
            tell(
              laneId,
              "quota",
              "Senderban",
              `Checking ${label()} for new mail is paused for a while: Gmail's limit (or Senderban's own daily limit) was reached.`,
            );
          }
        },
        onPoll: (_id: string, event: GmailPollEvent) => {
          // A quiet poll is one `gmail-http` line already (its status and time); a second line a minute per account would roll
          // the 1 MiB log in under an hour at 50 accounts. Everything that is not "worked and found nothing" is written.
          if (event.outcome === "ok" && event.found === 0) return;
          deps.log("gmail-poll", {
            account: tag,
            outcome: event.outcome,
            code: event.code,
            pages: event.pages,
            found: event.found,
            announced: event.announced,
            consumerErrors: event.consumerErrors,
            ms: event.ms,
          });
        },
      }),
    );
    states.set(laneId, "stopped");
    deps.onState(laneId, "stopped");
  }

  return {
    start() {
      for (const [laneId, watcher] of watchers) {
        if (deps.isHeld?.(laneId) !== true) watcher.start();
      }
    },
    stop() {
      for (const watcher of watchers.values()) watcher.stop();
    },
    resumeNow() {
      for (const watcher of watchers.values()) watcher.resumeNow();
    },
    stopOne(laneId) {
      watchers.get(laneId)?.stop();
    },
    startOne(laneId) {
      watchers.get(laneId)?.start();
    },
    forget(laneId) {
      watchers.get(laneId)?.stop();
      watchers.delete(laneId);
      states.delete(laneId);
      noticed.delete(laneId);
      deps.cursors.delete(laneId);
    },
    get size() {
      return watchers.size;
    },
  };
}
