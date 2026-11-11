import { z } from "zod";

/**
 * The once-a-day "is there a newer Senderban" question (plan frontend-v0-3 step 5). Pure parts only: the desktop app does the
 * request. Scale budget (2026-11-11): one GET per install per 24-30 h; the time of the next allowed try is kept on disk, so a
 * restart adds none, a failure included. A failure that can pass (offline, 5xx, rate limit) waits 6-7.5 h, so 4 a day at most;
 * one that will not (404, an answer we cannot read) waits a day. GitHub allows 60 unauthenticated requests per hour per IP
 * (docs.github.com, rate limits for the REST API), and a 304 still counts there without a token, so the ETag only saves the body.
 * Fleet, from 3 downloads of 0.2.0 (gh releases, 2026-11-11): 3 / 30 / 150 requests a day at 1x / 10x / 50x, 12 / 120 / 600
 * if every install fails. The wall is per egress IP: 61 installs behind one address in one hour; the 25 % jitter spreads a
 * cohort that starts together over the following days.
 */
export const UPDATE_URL = "https://api.github.com/repos/senderban/senderban/releases/latest";
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The first check after a start waits this long, so it never competes with the mailboxes signing in. */
export const UPDATE_FIRST_DELAY_MS = 60 * 1000;
export const UPDATE_TIMEOUT_MS = 10_000;
/** After a failure that can pass: 4 tries a day at most while offline. */
export const UPDATE_RETRY_MS = 6 * 60 * 60 * 1000;
/** Each wait is stretched by a random 0-25 %, so installs that started together do not ask together. */
export const UPDATE_JITTER = 0.25;
/**
 * The /releases/latest answer measured 2026-11-11 for 0.2.0 was about 6 KB (notes plus 5 assets). GitHub allows a release body
 * of 125,000 characters, which can pass this cap in multi-byte text; we write our own notes, so the cap stays well above them.
 */
export const UPDATE_MAX_BYTES = 256 * 1024;

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
export const VersionSchema = z.string().regex(VERSION);

/**
 * The one field read from GitHub's answer. Not strict: the release object has dozens of fields we neither need nor trust;
 * only `tag_name` survives the parse. /releases/latest skips drafts and pre-releases (GitHub REST docs, "Get the latest release").
 */
export const LatestReleaseSchema = z.object({
  tag_name: z
    .string()
    .max(32)
    .transform((tag) => tag.replace(/^v/, ""))
    .pipe(VersionSchema),
});

/** What is kept between starts, in userData/update.json. */
export const UpdateStateSchema = z.strictObject({
  version: z.literal(1),
  /** Epoch ms before which no request is made: moved by every try, answered or not, so a restart never asks early. */
  nextAt: z.number().int().min(0).max(8_640_000_000_000_000),
  etag: z.string().max(256).nullable(),
  /** The newest version GitHub named, whatever this install runs. */
  latest: VersionSchema.nullable(),
  /** The version a notification was already shown for: one notification per release. */
  notified: VersionSchema.nullable(),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const EMPTY_UPDATE_STATE: UpdateState = {
  version: 1,
  nextAt: 0,
  etag: null,
  latest: null,
  notified: null,
};

/** True when `candidate` is a later x.y.z than `current`; anything that is not x.y.z is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = VERSION.exec(candidate);
  const b = VERSION.exec(current);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** `ms` stretched by 0-25 %; `random` is Math.random in the app, a fixed number in tests. */
export function jittered(ms: number, random: () => number): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(ms * (1 + UPDATE_JITTER * r));
}

/**
 * The wait after a start or after the switch is turned on: never sooner than the first delay, never past `nextAt`, and never
 * longer than one jittered interval, so a `nextAt` far in the future (a clock set back, an edited file) cannot stop the checks.
 */
export function startDelay(nextAt: number, now: number, random: () => number): number {
  const ceiling = Math.round(UPDATE_INTERVAL_MS * (1 + UPDATE_JITTER));
  return Math.min(ceiling, Math.max(jittered(UPDATE_FIRST_DELAY_MS, random), nextAt - now));
}
