import { z } from "zod";

/**
 * The once-a-day "is there a newer Senderban" question (plan frontend-v0-3 step 5). Pure parts only: the desktop app does the
 * request. Scale budget (2026-11-11): one GET per install per 24 h, the last check time kept on disk so restarts add none.
 * GitHub allows 60 unauthenticated requests per hour per IP (docs.github.com, rate limits for the REST API); 100 installs
 * behind one address make 100 a day. A 304 still counts there without a token, so the ETag only saves the body.
 */
export const UPDATE_URL = "https://api.github.com/repos/senderban/senderban/releases/latest";
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The first check after a start waits this long, so it never competes with the mailboxes signing in. */
export const UPDATE_FIRST_DELAY_MS = 60 * 1000;
export const UPDATE_TIMEOUT_MS = 10_000;
/** After a failed check: 4 tries a day at most while offline. */
export const UPDATE_RETRY_MS = 6 * 60 * 60 * 1000;
/** A release with its notes and assets is a few KB; anything far larger is not the answer we asked for. */
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
  /** Epoch ms of the last answered check; a failed check does not move it, so the next start tries again. */
  checkedAt: z.number().int().min(0).max(8_640_000_000_000_000),
  etag: z.string().max(256).nullable(),
  /** The newest version GitHub named, whatever this install runs. */
  latest: VersionSchema.nullable(),
  /** The version a notification was already shown for: one notification per release. */
  notified: VersionSchema.nullable(),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const EMPTY_UPDATE_STATE: UpdateState = {
  version: 1,
  checkedAt: 0,
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

/** How long to wait before the next check, from the last answered one. */
export function nextCheckDelay(
  checkedAt: number,
  now: number,
  firstDelay = UPDATE_FIRST_DELAY_MS,
): number {
  const due = checkedAt + UPDATE_INTERVAL_MS - now;
  return Math.min(UPDATE_INTERVAL_MS, Math.max(firstDelay, due));
}
