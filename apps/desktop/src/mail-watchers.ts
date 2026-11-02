import type { MailToast, PollBackoffDetail, PollState } from "@senderban/core";
import type { Log } from "./log.js";

// Scale budget (ADR 0009 point 5, .task/gmail-watcher.md A0; ADR 0013 "New mail"): one watcher per account with a lane, each with its own timer
// and one poll in the air; the polls of all accounts of a provider go through that provider's shared gate. This module keeps one throttle entry per
// (account, notice kind): at most MAX_ACCOUNTS x its kinds of small entries, replaced in place. No timer of its own.

/**
 * A notice of the same kind about the same account is shown at most this often; the log line is written every time. Unit:
 * milliseconds. One hour: a backoff that keeps failing or a gap that repeats must not become a stream of toasts, and a problem that
 * lasts longer than an hour is worth saying again.
 */
export const MAIL_NOTICE_EVERY_MS = 3_600_000;

/**
 * The subject shown inside one of Senderban's own notices: on a line of its own, labelled as the mail's, quoted and cut, so a sender
 * cannot make it read as a sentence of Senderban's ("Senderban: sign in to Google again"). Unit: UTF-16 units, 80 at most.
 */
export const NOTICE_SUBJECT_MAX = 80;
export function subjectLine(subject: string): string {
  if (subject === "") return "";
  const cut =
    subject.length > NOTICE_SUBJECT_MAX ? `${subject.slice(0, NOTICE_SUBJECT_MAX)}…` : subject;
  return `\nSubject of the mail: “${cut}”`;
}

/**
 * How often an account's heartbeat line is written. Unit: milliseconds. One line an hour for each account is 50 lines an hour
 * at 50 accounts (about 8 KB) against 3,000 lines of per-poll lines; it is what tells "no new mail" from "not looking": a watcher whose
 * timer died writes no heartbeat. It rides on the polls (no timer of its own), so a missing heartbeat is itself the signal.
 */
export const MAIL_HEARTBEAT_MS = 3_600_000;

type NoticeKind<Gap extends string> =
  Gap | "overflow" | "quota" | "halted-auth" | "halted-rejected";

/** What every polling watcher does, whichever provider's. */
export interface MailWatcher {
  readonly lastOkAt: number | null;
  start(): void;
  stop(): void;
  resume(): void;
  resumeNow(): void;
}

export interface MailPollEvent {
  readonly outcome: "ok" | "first" | "gap" | "error";
  readonly code?: string;
  readonly pages: number;
  readonly found: number;
  readonly announced: number;
  readonly consumerErrors: number;
  readonly ms: number;
}

/** What a watcher hands back; each is a provider watcher's own option under the same name. */
export interface MailWatcherHooks<Gap extends string> {
  readonly onMessage: (
    id: string,
    message: { readonly from: string | null; readonly subject: string },
  ) => void;
  readonly onOverflow: (id: string, skipped: number) => void;
  readonly onGap: (id: string, gap: Gap) => void;
  readonly onState: (id: string, state: PollState, detail?: PollBackoffDetail) => void;
  readonly onPoll: (id: string, event: MailPollEvent) => void;
}

/** What differs between providers. */
export interface MailProvider<Lane, Gap extends string> {
  /** First word of every log line. */
  readonly prefix: string;
  /** Named when the sign-in is refused. */
  readonly who: string;
  /** Named when its limit is reached. */
  readonly service: string;
  readonly gapText: Readonly<Record<Gap, string>>;
  readonly laneId: (lane: Lane) => string;
  /** The account as the log may name it: never an address. */
  readonly tag: (lane: Lane) => string;
  readonly create: (lane: Lane, hooks: MailWatcherHooks<Gap>) => MailWatcher;
  /** What the toast of a mail from `sender` offers. */
  readonly toast: (
    sender: string,
  ) => Pick<MailToast, "spamScore" | "domain" | "rejectsAtServer" | "trashOnly">;
  readonly forgetCursor: (laneId: string) => void;
}

export interface MailWatchersDeps {
  readonly pending: { add(block: { accountId: string; sender: string }): string };
  readonly showMail: (toast: MailToast) => void;
  /** A toast without buttons. */
  readonly notice: (title: string, body: string) => void;
  /** Lane id -> the name the person knows the account by (`me@gmail.com (Gmail)`). */
  readonly labelOf: (laneId: string) => string;
  /**
   * True for one of the person's own mailboxes. A mail that claims to come from it is announced without a Block button: a forged
   * `From` of your own address would otherwise offer to send your own mail away (the lanes refuse it too).
   */
  readonly isOwn?: (address: string) => boolean;
  /** True for a sender on the "Don't ask again" list: no toast. */
  readonly isQuiet?: (address: string) => boolean;
  /** True for a lane held still for a removal: `start()` leaves it alone (an un-pause must not wake it). */
  readonly isHeld?: (laneId: string) => boolean;
  /** Every state change, for the tray. */
  readonly onState: (laneId: string, state: PollState) => void;
  readonly log: Log;
  readonly now?: () => number;
}

export interface MailWatchers {
  start(): void;
  /** Stops every watcher (pause, quit). */
  stop(): void;
  /** The end of a pause: a halted watcher stays halted. */
  resume(): void;
  /** After system resume. */
  resumeNow(): void;
  /** One lane, held still for a removal or sign-out (`stop`), or free again (`start`). Unknown lane: nothing. */
  stopOne(laneId: string): void;
  startOne(laneId: string): void;
  /** The account is gone or signed out: its watcher is stopped and dropped, its cursor deleted. */
  forget(laneId: string): void;
  /** What the toast of a mail from `sender` offers on this lane; null for a lane these watchers do not hold. */
  toastOffer(
    laneId: string,
    sender: string,
  ): Pick<MailToast, "spamScore" | "domain" | "rejectsAtServer" | "trashOnly"> | null;
  /** Watchers alive (for tests and the tray). */
  readonly size: number;
}

/** One watcher per lane, and what their events mean to the person: the same for every polling provider, so the rules about own mail and quiet senders cannot drift. */
export function createMailWatchers<Lane, Gap extends string>(
  lanes: readonly Lane[],
  provider: MailProvider<Lane, Gap>,
  deps: MailWatchersDeps,
): MailWatchers {
  const now = deps.now ?? Date.now;
  const { prefix } = provider;
  const watchers = new Map<string, MailWatcher>();
  const noticed = new Map<string, Map<NoticeKind<Gap>, number>>();

  /** Tells the person at most once an hour per (account, kind). */
  const tell = (laneId: string, kind: NoticeKind<Gap>, title: string, body: string): void => {
    const kinds = noticed.get(laneId) ?? new Map<NoticeKind<Gap>, number>();
    noticed.set(laneId, kinds);
    const last = kinds.get(kind);
    if (last !== undefined && now() - last < MAIL_NOTICE_EVERY_MS) return;
    kinds.set(kind, now());
    deps.notice(title, body);
  };

  const states = new Map<string, PollState>();

  for (const lane of lanes) {
    const laneId = provider.laneId(lane);
    const tag = provider.tag(lane);
    const label = (): string => deps.labelOf(laneId);
    // Counts since the last heartbeat line (polls, failed polls, mails found): three numbers, replaced in place.
    const beat = { since: now(), polls: 0, failed: 0, found: 0, maxMs: 0 };
    watchers.set(
      laneId,
      provider.create(lane, {
        onMessage: (_id, message) => {
          if (message.from === null) {
            // The sender could not be read safely (a second From, an odd header): announced, with nothing to click.
            deps.log(`${prefix}-announce`, { account: tag, sender: "unreadable" });
            deps.notice(
              "Senderban",
              `New mail in ${label()}: the sender could not be read safely, so there is no Block button.${subjectLine(message.subject)}`,
            );
            return;
          }
          if (deps.isOwn?.(message.from) === true) {
            deps.log(`${prefix}-announce`, { account: tag, sender: "own-address" });
            deps.notice(
              "Senderban",
              `New mail in ${label()} claims to come from your own address, so there is no Block button.${subjectLine(message.subject)}`,
            );
            return;
          }
          if (deps.isQuiet?.(message.from) === true) {
            deps.log(`${prefix}-announce`, { account: tag, sender: "quiet" });
            return;
          }
          const id = deps.pending.add({ accountId: laneId, sender: message.from });
          deps.log(`${prefix}-announce`, {
            account: tag,
            domain: message.from.slice(message.from.lastIndexOf("@") + 1),
          });
          deps.showMail({
            id,
            accountId: laneId,
            issuedAt: Math.floor(now() / 1000),
            sender: message.from,
            subject: message.subject,
            account: label(),
            ...provider.toast(message.from),
          });
        },
        onOverflow: (_id, skipped) => {
          deps.log(`${prefix}-overflow`, { account: tag, skipped });
          tell(
            laneId,
            "overflow",
            "Senderban",
            `${String(skipped)} more new messages in ${label()} were not announced.`,
          );
        },
        onGap: (_id, gap) => {
          deps.log(`${prefix}-gap`, { account: tag, gap });
          tell(laneId, gap, "Senderban", `${label()}: ${provider.gapText[gap]}`);
        },
        onState: (_id, state, detail) => {
          const previous = states.get(laneId);
          states.set(laneId, state);
          deps.log(`${prefix}-watcher`, { account: tag, state, detail });
          deps.onState(laneId, state);
          if (previous === state) return;
          if (state === "halted-auth") {
            tell(
              laneId,
              "halted-auth",
              "Senderban stopped watching",
              `${label()}: ${provider.who} refused the sign-in. Sign in again under Accounts in Senderban, then restart it.`,
            );
          } else if (state === "halted-rejected") {
            tell(
              laneId,
              "halted-rejected",
              "Senderban stopped watching",
              `${label()}: ${provider.who} kept refusing the checks for new mail. Restart Senderban to try again.`,
            );
          } else if (state === "backoff" && detail === "quota") {
            tell(
              laneId,
              "quota",
              "Senderban",
              `Checking ${label()} for new mail is paused for a while: ${provider.service}'s limit (or Senderban's own daily limit) was reached.`,
            );
          }
        },
        onPoll: (_id, event) => {
          beat.polls += 1;
          if (event.outcome === "error") beat.failed += 1;
          beat.found += event.found;
          beat.maxMs = Math.max(beat.maxMs, event.ms);
          if (now() - beat.since >= MAIL_HEARTBEAT_MS) {
            const lastOk = watchers.get(laneId)?.lastOkAt ?? null;
            deps.log(`${prefix}-heartbeat`, {
              account: tag,
              state: states.get(laneId),
              polls: beat.polls,
              failed: beat.failed,
              found: beat.found,
              // The slowest poll of the hour: the latency the per-poll lines used to show.
              maxMs: beat.maxMs,
              lastOkAgoS: lastOk === null ? null : Math.round((now() - lastOk) / 1000),
            });
            beat.since = now();
            beat.polls = 0;
            beat.failed = 0;
            beat.found = 0;
            beat.maxMs = 0;
          }
          // A quiet poll is one HTTP line already (its status and time); a second line a minute per account would roll
          // the 1 MiB log in under an hour at 50 accounts. Everything that is not "worked and found nothing" is written.
          if (event.outcome === "ok" && event.found === 0) return;
          deps.log(`${prefix}-poll`, {
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
    toastOffer(laneId, sender) {
      return watchers.has(laneId) ? provider.toast(sender) : null;
    },
    start() {
      for (const [laneId, watcher] of watchers) {
        if (deps.isHeld?.(laneId) !== true) watcher.start();
      }
    },
    stop() {
      for (const watcher of watchers.values()) watcher.stop();
    },
    resume() {
      for (const [laneId, watcher] of watchers) {
        if (deps.isHeld?.(laneId) !== true) watcher.resume();
      }
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
      provider.forgetCursor(laneId);
    },
    get size() {
      return watchers.size;
    },
  };
}
