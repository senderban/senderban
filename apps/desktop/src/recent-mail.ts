import { randomUUID } from "node:crypto";
import {
  AdapterError,
  RECENT_MAX,
  RecentTooLargeError,
  coverLookup,
  isOwnMailbox,
  readGmailRecent,
} from "@senderban/core";
import { gmailCover } from "./gmail-lanes.js";
import type { Log } from "./log.js";
import { outlookCover } from "./microsoft-lanes.js";
import type {
  AccountWatcher,
  Blocklist,
  OwnMail,
  GmailRecentReader,
  GraphRecentClient,
  RecentMail,
} from "@senderban/core";

// Scale budget (.task/recent-mail-0-4-0.md, A0): requests leave only when the Recent mail view is opened or refreshed, never on a
// timer; boredom costs nothing. Per account one read: IMAP one FETCH on the watcher's open connection, Gmail one list and a get per
// id not read before (own 24-hour line), Microsoft one request (own 24-hour line). At 50 accounts (MAX_ACCOUNTS) a look is 50 reads,
// RECENT_CONCURRENCY at a time per provider kind, each cut off at RECENT_TIMEOUT_MS, so one slow server cannot hold the others. Memory: RECENT_MAX rows
// per account, ANNOUNCED_PER_ACCOUNT announcements per account.

/**
 * How long a read is shown before the view asks again, and how long its rows are kept: past it they are dropped from memory, read
 * again or not. Unit: milliseconds. Opening the window twice in a row costs nothing.
 */
export const RECENT_TTL_MS = 180_000;
/**
 * The Refresh button asks again no sooner than this per account, and a read that failed is asked again after this even without it.
 * Unit: milliseconds. A click held down is not a request storm.
 */
export const RECENT_REFRESH_MIN_MS = 30_000;
/**
 * Accounts of one provider kind read at once. Unit: reads. Each kind has its own pool, so IMAP servers that hang cannot hold Gmail
 * or Outlook reads back (perf review 2026-11-24 W3); at most three kinds, so 12 reads at once. This bounds sockets and Google's
 * concurrent-request count.
 */
export const RECENT_CONCURRENCY = 4;
/** One account's read, at most. Unit: milliseconds. The Graph client's own request timeout is 15 s; an IMAP read of ten envelopes took 305 and 453 ms (two MXroute accounts, live 2026-11-24). */
export const RECENT_TIMEOUT_MS = 15_000;
/**
 * How long a look waits for its reads before it shows what it has. Unit: milliseconds. One account that hangs must not hold the other
 * 49 for RECENT_TIMEOUT_MS; its reads go on and the page asks again (`reading`). A look of one Gmail and two MXroute accounts took 551 ms
 * (live 2026-11-24); 50 IMAP accounts at 0.3-0.45 s each, four at once, come near 5 s (estimate).
 */
export const RECENT_LOOK_WAIT_MS = 5_000;
/** Announcements kept per account, newest kept. Unit: announcements. 40 drains of five mails; the view looks at the newest ten mails. */
export const ANNOUNCED_PER_ACCOUNT = 200;
/** Accounts the announcements are kept for. Unit: accounts. MAX_ACCOUNTS (sync/engine.ts) is 50; lanes add a few more. */
export const ANNOUNCED_ACCOUNTS_MAX = 100;
/** How far back "Not notified" looks. Unit: milliseconds. Older mail is not news; what Senderban did a day ago is not known after a restart. */
export const MISSED_WINDOW_MS = 24 * 3_600_000;
/** Clocks of the provider and this machine disagree: an announcement this much before the mail's own time still counts. Unit: milliseconds. */
export const CLOCK_SLACK_MS = 5 * 60_000;

export type RecentProvider = "imap" | "gmail" | "microsoft";

/** One account the view can read. `accountId` is the id a toast of it uses (the lane id for Gmail and Microsoft). */
export interface RecentSource {
  readonly accountId: string;
  readonly provider: RecentProvider;
  /**
   * The newest mails, or null when there is nothing to read on now (the watcher is not connected, the account is paused). `memo`
   * is the account's own, kept and dropped with its rows: what a source may keep between reads (Gmail: headers by message id).
   */
  read(signal: AbortSignal, memo: Map<string, RecentMail>): Promise<readonly RecentMail[] | null>;
}

/**
 * What the row says beside the sender. `missed`: the mail came while Senderban ran, and no notification for this sender on this
 * account was shown since (the five-per-drain limit, a quiet sender being the other reason, which is `muted`).
 */
export type RecentMark = "blocked" | "muted" | "own" | "unreadable" | "missed" | "none";
/**
 * `large`: a mail among the newest is too large to read, so the account's rows are not listed (RECENT_TOO_LARGE_MAILS). `reading`:
 * its first read is still running past RECENT_LOOK_WAIT_MS.
 */
export type RecentAccountStatus = "ok" | "offline" | "error" | "limit" | "large" | "reading";

/** What the window gets: no account id, no message id; `key` names the row for one click, until the next look. */
export interface RecentRowView {
  readonly key: string;
  readonly account: string;
  readonly from: string | null;
  readonly subject: string;
  readonly receivedMs: number | null;
  readonly mark: RecentMark;
  /** Where the row's block button puts the sender's mail, so the button carries the toast's own word for it (Junk, Trash). */
  readonly blockAct: "junk" | "trash";
}

export interface RecentView {
  /** Senderban has not finished starting: no account was asked, so the empty list says nothing about mail. */
  readonly starting: boolean;
  readonly rows: readonly RecentRowView[];
  /** Accounts whose rows could not be read this time; an account that read fine is not listed. */
  readonly problems: readonly { readonly account: string; readonly status: RecentAccountStatus }[];
}

/** The account and sender behind a row: what a click blocks or quiets. */
export interface RecentTarget {
  readonly accountId: string;
  readonly sender: string;
}

/** Who was announced when, per account, in memory: "Not notified" is the absence of a line here. */
export class Announcements {
  readonly #byAccount = new Map<string, { readonly sender: string; readonly at: number }[]>();

  record(accountId: string, sender: string, at: number): void {
    let lines = this.#byAccount.get(accountId);
    if (lines === undefined) {
      if (this.#byAccount.size >= ANNOUNCED_ACCOUNTS_MAX) {
        const oldest = this.#byAccount.keys().next().value;
        if (oldest !== undefined) this.#byAccount.delete(oldest);
      }
      lines = [];
      this.#byAccount.set(accountId, lines);
    }
    lines.push({ sender, at });
    if (lines.length > ANNOUNCED_PER_ACCOUNT) lines.splice(0, lines.length - ANNOUNCED_PER_ACCOUNT);
    // `since` never looks past MISSED_WINDOW_MS (and the slack): an older line is a sender address held for nothing.
    const cutoff = at - MISSED_WINDOW_MS - CLOCK_SLACK_MS;
    const old = lines.findIndex((l) => l.at >= cutoff);
    lines.splice(0, old === -1 ? lines.length : old);
  }

  /** True when `sender` was announced on the account at `ms` or later (less the clock slack). */
  since(accountId: string, sender: string, ms: number): boolean {
    const lines = this.#byAccount.get(accountId);
    return lines?.some((l) => l.sender === sender && l.at >= ms - CLOCK_SLACK_MS) === true;
  }

  forget(accountId: string): void {
    this.#byAccount.delete(accountId);
  }
}

export interface RecentDeps {
  readonly sources: () => readonly RecentSource[];
  /** The name the person knows the account by. */
  readonly label: (accountId: string) => string;
  /**
   * What the list already says about a sender on an account: on the block list, on "Don't ask again", one of the person's own.
   * Called once per look; the function it returns once per row, so a look reads the lists once, not once per row.
   */
  readonly marks: () => (accountId: string, sender: string) => "blocked" | "muted" | "own" | null;
  readonly announced: Announcements;
  /** What a block from a row of the account does: the default action, Trash on Gmail (a Gmail filter has one effect). */
  readonly blockAct: (accountId: string) => "junk" | "trash";
  /** The account as the log may name it: never an address. */
  readonly tag: (accountId: string) => string;
  readonly log: Log;
  /**
   * When this run began. Unit: epoch milliseconds. Announcements live in memory, so of mail that came before it nothing is known:
   * such a row is never "Not notified". Default: when the service was made, at start.
   */
  readonly startedAt?: number;
  /** True until the accounts are set up: the view then asks nobody and says so. */
  readonly starting?: () => boolean;
  readonly now?: () => number;
}

interface Cached {
  /** When the account was last asked. */
  readonly asked: number;
  /** When `mails` were read: a failed read keeps what an earlier one read, and its age. */
  readonly read: number;
  readonly mails: readonly RecentMail[];
  readonly status: RecentAccountStatus;
}

type Outcome = { readonly mails: readonly RecentMail[] | null } | { readonly error: unknown };

export interface RecentMarkInputs {
  readonly list: Blocklist;
  readonly own: OwnMail;
  readonly quiet: (sender: string) => boolean;
  readonly provider: (accountId: string) => RecentProvider;
  /** False when the account's rules are not known to be in place: no lane runs for it, or its last sync failed or was not read back. */
  readonly applied: (accountId: string) => boolean;
}

/**
 * The `marks` of a look. "blocked" only where a rule reaches that account: Gmail holds single addresses only (gmailCover), Outlook
 * refuses some domains (outlookCover), and an account whose last sync failed is not applied. Otherwise the row keeps its Block
 * button, whose click writes the address entry that does reach it (blockPending). Three lookups built once per look, not per row.
 */
export function recentMarks(
  inputs: RecentMarkInputs,
): (accountId: string, sender: string) => "blocked" | "muted" | "own" | null {
  const { list, own } = inputs;
  const isOwn = (address: string): boolean => isOwnMailbox(address, own);
  const any = coverLookup(list, own);
  let gmail: ((sender: string) => boolean) | null = null;
  let outlook: ((sender: string) => boolean) | null = null;
  const reaches = (accountId: string, sender: string): boolean => {
    if (!any(sender) || !inputs.applied(accountId)) return false;
    switch (inputs.provider(accountId)) {
      case "imap":
        return true;
      case "gmail":
        gmail ??= coverLookup(
          list.filter((e) => gmailCover(e, isOwn) === "trash"),
          own,
        );
        return gmail(sender);
      case "microsoft":
        outlook ??= coverLookup(
          list.filter((e) => outlookCover(e, own) !== "no"),
          own,
        );
        return outlook(sender);
    }
  };
  return (accountId, sender) =>
    isOwn(sender)
      ? "own"
      : reaches(accountId, sender)
        ? "blocked"
        : inputs.quiet(sender)
          ? "muted"
          : null;
}

/** What failed, as the log may say it: an AdapterError's code or an error's class name, nothing a server wrote. */
function errorKind(error: unknown): string {
  if (error instanceof AdapterError) return error.code;
  return error instanceof Error && /^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : "unknown";
}

/** Runs `read` with a deadline: the read is aborted and no longer waited for when it passes. */
async function withDeadline(
  read: (signal: AbortSignal) => Promise<readonly RecentMail[] | null>,
  ms: number,
): Promise<Outcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      const error = new Error(`the read did not finish within ${String(ms)} ms`);
      controller.abort(error);
      resolve({ error });
    }, ms);
  });
  try {
    return await Promise.race([
      read(controller.signal).then(
        (mails): Outcome => ({ mails }),
        (error: unknown): Outcome => ({ error }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Recent mail view's reads (017): the newest RECENT_MAX mails of each account, in memory for RECENT_TTL_MS, and the keys a
 * click on a row comes back with. Marks are worked out at each look, not at the read, so a block shows on the next look without a
 * request.
 */
export class RecentMailService {
  readonly #deps: RecentDeps;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #cache = new Map<string, Cached>();
  readonly #memo = new Map<string, Map<string, RecentMail>>();
  #targets = new Map<string, RecentTarget>();
  #running: Promise<RecentView> | null = null;
  /** The reads running, which can outlive the look that started them (RECENT_LOOK_WAIT_MS); null when none. */
  #reading: Promise<void> | null = null;
  readonly #inFlight = new Set<string>();
  /** Moves at `release` and `forget`: a look that began before does not hand its keys out after. */
  #generation = 0;
  /** The one timer that drops rows past RECENT_TTL_MS, set while any are held. */
  #sweep: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: RecentDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#startedAt = deps.startedAt ?? this.#now();
  }

  /** The rows to show. `refresh`: the person asked; each account is read again unless it was read in the last RECENT_REFRESH_MIN_MS. */
  view(refresh = false): Promise<RecentView> {
    // One look at a time: a second open while the first reads gets the same answer, not a second round of requests.
    this.#running ??= this.#look(refresh).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * The account and sender behind a row, once: the key is spent, as a toast's id is. Null for a key spent, from an older look, or
   * never given.
   */
  take(key: string): RecentTarget | null {
    const target = this.#targets.get(key) ?? null;
    this.#targets.delete(key);
    return target;
  }

  /** The account is gone: what was read of it goes too. */
  forget(accountId: string): void {
    this.#generation += 1;
    this.#drop(accountId, true);
    this.#deps.announced.forget(accountId);
  }

  /** The page closed: the keys of the rows it showed go (account and sender, no subject). */
  release(): void {
    this.#generation += 1;
    this.#targets = new Map();
  }

  /**
   * `keys`: the rows' click keys go too. Not when time drops the rows: the page still shows them, and a click on one must still work
   * (perf review 2026-11-24 W2). They go at the next look or when the page closes (`release`).
   */
  #drop(accountId: string, keys: boolean): void {
    this.#cache.delete(accountId);
    this.#memo.delete(accountId);
    if (!keys) return;
    for (const [key, target] of this.#targets) {
      if (target.accountId === accountId) this.#targets.delete(key);
    }
  }

  /** Drops every account's rows read RECENT_TTL_MS ago or longer, and sets the timer for the next ones. */
  #expire(): void {
    if (this.#sweep !== null) clearTimeout(this.#sweep);
    this.#sweep = null;
    const now = this.#now();
    let next = Infinity;
    for (const [id, cached] of [...this.#cache]) {
      if (now - cached.read >= RECENT_TTL_MS) this.#drop(id, false);
      else next = Math.min(next, cached.read + RECENT_TTL_MS);
    }
    if (next === Infinity) return;
    this.#sweep = setTimeout(() => {
      this.#expire();
    }, next - now);
    // Not a reason to keep the process alive.
    this.#sweep.unref();
  }

  async #look(refresh: boolean): Promise<RecentView> {
    if (this.#deps.starting?.() === true) return { starting: true, rows: [], problems: [] };
    const generation = this.#generation;
    this.#expire();
    const sources = this.#deps.sources();
    // Reads a look before left running are waited for, not started again.
    this.#reading ??= this.#readStale(sources, refresh);
    const reading = this.#reading;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reading,
        new Promise((resolve) => {
          timer = setTimeout(resolve, RECENT_LOOK_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    // An account removed since its last read is not shown.
    const live = new Set(sources.map((s) => s.accountId));
    for (const id of [...this.#cache.keys()]) if (!live.has(id)) this.#drop(id, true);
    this.#expire();
    return this.#rows(sources, generation);
  }

  async #readStale(sources: readonly RecentSource[], refresh: boolean): Promise<void> {
    const now = this.#now();
    const stale = sources.filter((s) => {
      const cached = this.#cache.get(s.accountId);
      if (cached === undefined) return true;
      // "Not connected" asked nobody, so it costs nothing to ask again; a failed read waits the Refresh floor, a good one its time.
      if (cached.status === "offline") return true;
      const fresh = refresh || cached.status !== "ok" ? RECENT_REFRESH_MIN_MS : RECENT_TTL_MS;
      return now - cached.asked >= fresh;
    });
    // Every account of the round is "reading" until its own read ends, also one still waiting for a worker.
    for (const source of stale) this.#inFlight.add(source.accountId);
    const pool = async (queue: readonly RecentSource[]): Promise<void> => {
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < queue.length) {
          const source = queue[next];
          next += 1;
          if (source === undefined) return;
          try {
            await this.#read(source);
          } finally {
            this.#inFlight.delete(source.accountId);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(RECENT_CONCURRENCY, queue.length) }, worker));
    };
    const byKind = Map.groupBy(stale, (s) => s.provider);
    try {
      await Promise.all([...byKind.values()].map(pool));
    } finally {
      this.#reading = null;
      // Rows that landed after their look ended get their timer too.
      this.#expire();
    }
  }

  async #read(source: RecentSource): Promise<void> {
    const started = this.#now();
    let memo = this.#memo.get(source.accountId);
    if (memo === undefined) {
      memo = new Map();
      this.#memo.set(source.accountId, memo);
    }
    const held = memo;
    // In an async arrow: a source that threw at once would otherwise end the pool while its other reads still run.
    const outcome = await withDeadline(
      async (signal) => source.read(signal, held),
      RECENT_TIMEOUT_MS,
    );
    const previous = this.#cache.get(source.accountId);
    const at = this.#now();
    let entry: Cached;
    if ("error" in outcome) {
      const status: RecentAccountStatus =
        outcome.error instanceof AdapterError && outcome.error.code === "QUOTA_EXCEEDED"
          ? "limit"
          : outcome.error instanceof RecentTooLargeError
            ? "large"
            : "error";
      // What was read before stays on screen, marked, until its own time is up: a passing failure must not empty the list.
      entry = {
        asked: at,
        read: previous?.read ?? at,
        mails: previous?.mails ?? [],
        status,
      };
    } else if (outcome.mails === null) {
      entry = { asked: at, read: at, mails: [], status: "offline" };
    } else {
      entry = { asked: at, read: at, mails: outcome.mails.slice(0, RECENT_MAX), status: "ok" };
    }
    this.#cache.set(source.accountId, entry);
    // A read that lands after its look returned (RECENT_LOOK_WAIT_MS) gets its drop timer now, not when the whole pool ends.
    this.#expire();
    this.#deps.log("recent-read", {
      account: this.#deps.tag(source.accountId),
      provider: source.provider,
      outcome: entry.status,
      rows: entry.mails.length,
      ms: Math.max(0, this.#now() - started),
      // The kind only, never the message: a provider's text can quote an address.
      ...("error" in outcome ? { error: errorKind(outcome.error) } : {}),
    });
  }

  #rows(sources: readonly RecentSource[], generation: number): RecentView {
    const now = this.#now();
    const markOf = this.#deps.marks();
    const targets = new Map<string, RecentTarget>();
    const rows: RecentRowView[] = [];
    const problems: { account: string; status: RecentAccountStatus }[] = [];
    for (const source of sources) {
      const cached = this.#cache.get(source.accountId);
      const account = this.#deps.label(source.accountId);
      const blockAct = this.#deps.blockAct(source.accountId);
      if (cached === undefined) {
        if (this.#inFlight.has(source.accountId)) problems.push({ account, status: "reading" });
        continue;
      }
      if (cached.status !== "ok") problems.push({ account, status: cached.status });
      for (const mail of cached.mails) {
        const key = randomUUID();
        const mark = this.#markOf(markOf, source.accountId, mail, now);
        if (mail.from !== null && mark !== "own") {
          targets.set(key, { accountId: source.accountId, sender: mail.from });
        }
        rows.push({
          key,
          account,
          from: mail.from,
          subject: mail.subject,
          receivedMs: mail.receivedMs,
          mark,
          blockAct,
        });
      }
    }
    // Newest first across accounts; a mail with no time goes last.
    rows.sort((a, b) => (b.receivedMs ?? -Infinity) - (a.receivedMs ?? -Infinity));
    // The page closed (or an account went) while this look waited: its keys are not handed out, nor kept.
    if (generation === this.#generation) this.#targets = targets;
    return { starting: false, rows, problems };
  }

  #markOf(
    markOf: ReturnType<RecentDeps["marks"]>,
    accountId: string,
    mail: RecentMail,
    now: number,
  ): RecentMark {
    if (mail.from === null) return "unreadable";
    const known = markOf(accountId, mail.from);
    if (known !== null) return known;
    const at = mail.receivedMs;
    if (
      at !== null &&
      at >= this.#startedAt &&
      now - at <= MISSED_WINDOW_MS &&
      !this.#deps.announced.since(accountId, mail.from, at)
    ) {
      return "missed";
    }
    return "none";
  }
}

/** An IMAP account's rows: read on its watcher's open connection, or none while it is not connected or Senderban is paused. */
export function imapRecentSource(
  accountId: string,
  watcher: Pick<AccountWatcher, "recent">,
  paused: () => boolean,
): RecentSource {
  return {
    accountId,
    provider: "imap",
    read: async (signal) => {
      if (paused()) return null;
      const rows = await watcher.recent(RECENT_MAX, signal);
      return rows === null
        ? null
        : rows.map((r) => ({
            id: String(r.uid),
            from: r.from,
            subject: r.subject,
            receivedMs: r.deliveredAt,
          }));
    },
  };
}

/** A Gmail account's rows: the headers of a message already read are kept in `memo`, so a look inside RECENT_TTL_MS pays for new mail only. */
export function gmailRecentSource(
  laneId: string,
  reader: GmailRecentReader,
  paused: () => boolean,
): RecentSource {
  return {
    accountId: laneId,
    provider: "gmail",
    read: (signal, memo) =>
      paused() ? Promise.resolve(null) : readGmailRecent(reader, memo, RECENT_MAX, signal),
  };
}

/** A Microsoft account's rows: one request. */
export function microsoftRecentSource(
  laneId: string,
  reader: GraphRecentClient,
  paused: () => boolean,
): RecentSource {
  return {
    accountId: laneId,
    provider: "microsoft",
    read: async (signal) => (paused() ? null : (await reader.recent(RECENT_MAX, signal)).mail),
  };
}
