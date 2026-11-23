import type { PollState, WatcherState } from "@senderban/core";
import type { Log } from "./log.js";

// Two small things about watching: a shorter wait when the network comes back, and an hourly line per IMAP account.
//
// Scale budget: unit = account. Nudge: no timer and no request of its own; it moves a login that was due anyway forward, at most one per
// account in NUDGE_EVERY_MS and NUDGES_MAX in one absence, and every login still waits for the login gate (50 accounts on one server:
// MAX_CONCURRENT_LOGINS at once, spread over about 20 s). So a dead server costs NUDGES_MAX tries more than its backoff, however often
// others come and go, and a server that answered "not now" is left to its backoff: that wait is what it asked for.
// Heartbeat: one line an hour per account with something to say, every HEARTBEAT_QUIET_HOURS h for one with nothing (136 bytes; 50 quiet
// accounts: 200 lines, 27 KB a day). One timer. Memory: one small entry per account.

/** One account is nudged at most this often: the server that keeps failing is not asked faster than that. Milliseconds. */
export const NUDGE_EVERY_MS = 30_000;
/** Nudges an account gets between leaving `watching` and coming back to it. */
export const NUDGES_MAX = 3;
/** A nudged poll is spread over its start window (30 s), so a second nudge inside that window would only push it back. Milliseconds. */
export const POLL_NUDGE_EVERY_MS = 60_000;
/** Same cadence as the polling watchers' heartbeat (`MAIL_HEARTBEAT_MS`). Milliseconds. */
export const IMAP_HEARTBEAT_MS = 3_600_000;
/** An account that only watched, or is paused, says so once in this many hours. */
export const HEARTBEAT_QUIET_HOURS = 6;

/** Failures that say this PC had no way out (name lookup, route, timeout), not that the server refused. */
const NO_NETWORK =
  /\b(?:ENOTFOUND|ENOENT|EAI_AGAIN|EAI_FAIL|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ENETRESET|ETIMEDOUT|EADDRNOTAVAIL)\b|in required time|did not finish within/u;

export function looksOffline(detail: string): boolean {
  return NO_NETWORK.test(detail);
}

export interface WatchHealthDeps {
  readonly watchers: ReadonlyMap<string, { nudge(): boolean }>;
  /** The polling watchers (Gmail, Outlook): each nudges the lanes that wait out a passing failure. */
  readonly polls: () => readonly { nudge(): number }[];
  /** The IMAP server of an account. */
  readonly hostOf: (accountId: string) => string | undefined;
  readonly tagOf: (accountId: string) => string;
  readonly log: Log;
  readonly now?: () => number;
}

export interface WatchHealth {
  /** `refused`: the server answered and said no (`WatcherOptions.onState`). */
  imapState(accountId: string, state: WatcherState, detail?: string, refused?: boolean): void;
  /** A polling lane changed state. */
  pollState(laneId: string, state: PollState): void;
  /** A new mail was announced on this IMAP account. */
  announced(accountId: string): void;
  start(): void;
  stop(): void;
}

interface Beat {
  state: WatcherState;
  /** When the current `watching` began; null while not watching. Epoch milliseconds. */
  watchingSince: number | null;
  drops: number;
  found: number;
  /** Hours since the last line. */
  quiet: number;
}

interface Away {
  detail: string;
  refused: boolean;
  nudges: number;
}

export function createWatchHealth(deps: WatchHealthDeps): WatchHealth {
  const now = deps.now ?? Date.now;
  /** Accounts waiting out a failure, and what failed. */
  const away = new Map<string, Away>();
  const pollsAway = new Set<string>();
  const nudgedAt = new Map<string, number>();
  let pollsNudgedAt = Number.NEGATIVE_INFINITY;
  const beats = new Map<string, Beat>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Somebody got through: whoever waits for the same server, or for the network at all, tries now. `host` null: a polling provider. */
  const back = (host: string | null): void => {
    let nudged = 0;
    for (const [id, gone] of away) {
      const sameServer = host !== null && deps.hostOf(id) === host;
      if (!sameServer && !looksOffline(gone.detail)) continue;
      if (gone.refused || gone.nudges >= NUDGES_MAX) continue;
      if (now() - (nudgedAt.get(id) ?? Number.NEGATIVE_INFINITY) < NUDGE_EVERY_MS) continue;
      nudgedAt.set(id, now());
      if (deps.watchers.get(id)?.nudge() !== true) continue;
      gone.nudges += 1;
      nudged += 1;
    }
    let polls = 0;
    if (now() - pollsNudgedAt >= POLL_NUDGE_EVERY_MS) {
      for (const group of deps.polls()) polls += group.nudge();
      if (polls > 0) pollsNudgedAt = now();
    }
    if (nudged > 0 || polls > 0) deps.log("network-back", { nudged, polls });
  };

  const beatOf = (accountId: string): Beat => {
    const known = beats.get(accountId);
    if (known !== undefined) return known;
    const made: Beat = { state: "stopped", watchingSince: null, drops: 0, found: 0, quiet: 0 };
    beats.set(accountId, made);
    return made;
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      for (const [accountId, beat] of beats) {
        // An account removed since: its watcher is out of the map.
        if (!deps.watchers.has(accountId)) {
          beats.delete(accountId);
          away.delete(accountId);
          nudgedAt.delete(accountId);
          continue;
        }
        const calm = beat.state === "watching" || beat.state === "stopped";
        beat.quiet += 1;
        if (calm && beat.drops === 0 && beat.found === 0 && beat.quiet < HEARTBEAT_QUIET_HOURS) {
          continue;
        }
        beat.quiet = 0;
        deps.log("imap-heartbeat", {
          account: deps.tagOf(accountId),
          state: beat.state,
          upS: beat.watchingSince === null ? null : Math.round((now() - beat.watchingSince) / 1000),
          drops: beat.drops,
          found: beat.found,
        });
        beat.drops = 0;
        beat.found = 0;
      }
      schedule();
    }, IMAP_HEARTBEAT_MS);
    timer.unref();
  };

  return {
    imapState(accountId, state, detail, refused = false) {
      const beat = beatOf(accountId);
      beat.state = state;
      if (state === "watching") beat.watchingSince = now();
      else if (beat.watchingSince !== null) {
        beat.watchingSince = null;
        if (state === "backoff") beat.drops += 1;
      }
      if (state === "backoff") {
        away.set(accountId, {
          detail: detail ?? "",
          refused,
          nudges: away.get(accountId)?.nudges ?? 0,
        });
      } else if (state === "watching") {
        // Only one that was away says anything about the network: a first start or an un-pause does not.
        if (away.delete(accountId)) back(deps.hostOf(accountId) ?? null);
      } else if (state !== "connecting") away.delete(accountId);
    },
    pollState(laneId, state) {
      if (state === "backoff") pollsAway.add(laneId);
      else if (pollsAway.delete(laneId) && state === "watching") back(null);
    },
    announced(accountId) {
      beatOf(accountId).found += 1;
    },
    start() {
      if (timer === null) schedule();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
