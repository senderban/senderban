import { readFile, stat } from "node:fs/promises";
import {
  EMPTY_UPDATE_STATE,
  LatestReleaseSchema,
  UPDATE_FIRST_DELAY_MS,
  UPDATE_INTERVAL_MS,
  UPDATE_MAX_BYTES,
  UPDATE_RETRY_MS,
  UPDATE_TIMEOUT_MS,
  UPDATE_URL,
  UpdateStateSchema,
  isNewerVersion,
  jittered,
  startDelay,
} from "@senderban/core";
import type { UpdateState } from "@senderban/core";
import type { LogFields } from "./log.js";
import type { ReadableStreamReadResult } from "node:stream/web";

export interface UpdateCheckDeps {
  readonly statePath: string;
  /** The running version (app.getVersion()). */
  readonly current: string;
  /** Electron's net.fetch in the app: the system proxy and certificates apply. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly writeState: (path: string, value: UpdateState) => Promise<void>;
  /** Read at each tick: the Settings switch. A Store build never starts the checker (main.ts). */
  readonly enabled: () => boolean;
  /** A newer version, once per version. */
  readonly onNew: (version: string) => void;
  readonly log: (event: string, fields?: LogFields) => void;
  readonly now?: () => number;
  /** Math.random in the app; fixed in tests. */
  readonly random?: () => number;
}

/**
 * `failed`: may pass by itself (offline, timeout, 5xx, rate limit, a state file we could not write), try again in 6 h.
 * `refused`: will not pass by itself (404, a redirect, an answer we cannot read, too large), try again in a day.
 */
export type Outcome = "new" | "same" | "not-modified" | "off" | "failed" | "refused";

/** Why a check failed, as one fixed word for the log: never an error text. */
type Reason =
  "network" | "timeout" | "server" | "rate-limit" | "status" | "parse" | "size" | "write";

class CheckError extends Error {
  constructor(
    readonly reason: Reason,
    readonly waitMs: number | null = null,
  ) {
    super(reason);
  }
}

const PERMANENT: ReadonlySet<Reason> = new Set(["status", "parse", "size"]);

/**
 * One request a day to GitHub's latest-release endpoint (core update.ts has the budget). One timer, never two checks at
 * once, a 10 s deadline on the whole answer, a body cap, and the next allowed try on disk so a restart does not ask again.
 */
export class UpdateChecker {
  readonly #deps: UpdateCheckDeps;
  #state: UpdateState = EMPTY_UPDATE_STATE;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #started = false;
  #stopped = false;

  constructor(deps: UpdateCheckDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #random(): number {
    return (this.#deps.random ?? Math.random)();
  }

  /** The newer version GitHub last named, or null; null too while the switch is off. Costs no request. */
  get available(): string | null {
    if (!this.#deps.enabled()) return null;
    const latest = this.#state.latest;
    return latest !== null && isNewerVersion(latest, this.#deps.current) ? latest : null;
  }

  async start(): Promise<void> {
    this.#state = await this.#load();
    this.#started = true;
    this.#schedule(startDelay(this.#state.nextAt, this.#now(), () => this.#random()));
  }

  /**
   * The switch was turned on: ask after the first delay (or at `nextAt` if that is later) instead of at the next daily tick,
   * which may be a day away. Never a second timer, never during a check.
   */
  nudge(): void {
    if (!this.#started || this.#running) return;
    this.#schedule(startDelay(this.#state.nextAt, this.#now(), () => this.#random()));
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.check()
        .catch((): Outcome => "failed")
        .then((outcome) => {
          this.#schedule(this.#afterCheck(outcome));
        });
    }, delay);
  }

  /** The next wait: after a check that ran, until the `nextAt` it stored; switched off, look again in a day. */
  #afterCheck(outcome: Outcome): number {
    if (outcome === "off") return jittered(UPDATE_INTERVAL_MS, () => this.#random());
    // Never sooner than the first delay: no path can turn this timer into a tight loop.
    return Math.max(UPDATE_FIRST_DELAY_MS, this.#state.nextAt - this.#now());
  }

  /** One check. Exposed for tests; the timer is the only caller in the app. */
  async check(): Promise<Outcome> {
    if (this.#running) return "failed";
    if (!this.#deps.enabled()) return "off";
    this.#running = true;
    const started = this.#now();
    let outcome: Outcome = "failed";
    let status = 0;
    let reason: Reason | null = null;
    // One deadline for the request and the body together; cleared in finally, so it never outlives the check.
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadline.abort();
    }, UPDATE_TIMEOUT_MS);
    try {
      const signal = deadline.signal;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `Senderban/${this.#deps.current}`,
      };
      if (this.#state.etag !== null) headers["If-None-Match"] = this.#state.etag;
      let response: Response;
      try {
        response = await this.#deps.fetch(UPDATE_URL, { headers, redirect: "error", signal });
      } catch {
        throw new CheckError(signal.aborted ? "timeout" : "network");
      }
      status = response.status;
      const nextAt = this.#now() + jittered(UPDATE_INTERVAL_MS, () => this.#random());
      let next: UpdateState;
      if (response.status === 304) {
        await response.body?.cancel();
        next = { ...this.#state, nextAt };
        outcome = "not-modified";
      } else if (response.ok) {
        const body = await readCapped(response, signal);
        let latest: string;
        try {
          latest = LatestReleaseSchema.parse(JSON.parse(body)).tag_name;
        } catch {
          throw new CheckError("parse");
        }
        const etag = response.headers.get("etag");
        next = {
          ...this.#state,
          nextAt,
          etag: etag !== null && etag.length <= 256 ? etag : null,
          latest,
        };
        outcome = "same";
      } else {
        await response.body?.cancel();
        if (response.status === 403 || response.status === 429) {
          throw new CheckError("rate-limit", rateLimitWait(response, this.#now()));
        }
        throw new CheckError(response.status >= 500 ? "server" : "status");
      }
      const available = next.latest !== null && isNewerVersion(next.latest, this.#deps.current);
      if (available && next.notified !== next.latest) {
        next = { ...next, notified: next.latest };
        outcome = "new";
      }
      try {
        await this.#deps.writeState(this.#deps.statePath, next);
      } catch {
        throw new CheckError("write");
      }
      this.#state = next;
      if (outcome === "new" && next.latest !== null) {
        try {
          this.#deps.onNew(next.latest);
        } catch {
          // The notification failed; the Help badge still shows the version.
          this.#deps.log("update-notice-failed", {});
        }
      }
      return outcome;
    } catch (error) {
      reason = error instanceof CheckError ? error.reason : "network";
      const permanent = PERMANENT.has(reason);
      outcome = permanent ? "refused" : "failed";
      const wait =
        error instanceof CheckError && error.waitMs !== null
          ? error.waitMs
          : jittered(permanent ? UPDATE_INTERVAL_MS : UPDATE_RETRY_MS, () => this.#random());
      await this.#remember({ ...this.#state, nextAt: this.#now() + wait });
      return outcome;
    } finally {
      clearTimeout(deadlineTimer);
      this.#running = false;
      // Never the body or an error text: a fixed outcome and reason, the HTTP status and the time it took.
      this.#deps.log("update-check", { outcome, reason, status, ms: this.#now() - started });
    }
  }

  /** Keeps the next allowed try after a failure, so a restart does not ask early. A failed write keeps it in memory only. */
  async #remember(next: UpdateState): Promise<void> {
    this.#state = next;
    try {
      await this.#deps.writeState(this.#deps.statePath, next);
    } catch {
      // In memory it still holds for this run; the log line already says the check failed.
    }
  }

  async #load(): Promise<UpdateState> {
    try {
      if ((await stat(this.#deps.statePath)).size > 4096) return EMPTY_UPDATE_STATE;
      const parsed = UpdateStateSchema.safeParse(
        JSON.parse(await readFile(this.#deps.statePath, "utf8")),
      );
      return parsed.success ? parsed.data : EMPTY_UPDATE_STATE;
    } catch {
      return EMPTY_UPDATE_STATE;
    }
  }
}

/**
 * How long to wait after a 403 or 429. GitHub: do not retry before `x-ratelimit-reset` (epoch seconds) or `retry-after`
 * (seconds) (docs.github.com, rate limits for the REST API). Never less than the 6 h retry, never more than a day.
 */
function rateLimitWait(response: Response, now: number): number {
  const after = Number(response.headers.get("retry-after") ?? "NaN");
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? "NaN");
  let asked = 0;
  if (Number.isFinite(after) && after > 0) asked = after * 1000;
  if (Number.isFinite(reset) && reset * 1000 > now) asked = Math.max(asked, reset * 1000 - now);
  return Math.min(UPDATE_INTERVAL_MS, Math.max(UPDATE_RETRY_MS, asked));
}

/**
 * The body as text, refused past UPDATE_MAX_BYTES whatever Content-Length claims, and under the same deadline as the request:
 * a body that drips past it is cancelled, so a check always settles.
 */
async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > UPDATE_MAX_BYTES) {
    await response.body?.cancel();
    throw new CheckError("size");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new CheckError("parse");
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new CheckError("timeout"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // The race below may never await `aborted`: keep an unobserved rejection from being reported.
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk: ReadableStreamReadResult<Uint8Array> = await Promise.race([
        reader.read(),
        aborted,
      ]);
      if (chunk.done) break;
      const value = chunk.value;
      size += value.byteLength;
      if (size > UPDATE_MAX_BYTES) throw new CheckError("size");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof CheckError ? error : new CheckError("network");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw new CheckError("timeout");
  return new TextDecoder().decode(Buffer.concat(chunks));
}
