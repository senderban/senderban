import { readFile, stat } from "node:fs/promises";
import {
  EMPTY_UPDATE_STATE,
  LatestReleaseSchema,
  UPDATE_INTERVAL_MS,
  UPDATE_MAX_BYTES,
  UPDATE_RETRY_MS,
  UPDATE_TIMEOUT_MS,
  UPDATE_URL,
  UpdateStateSchema,
  isNewerVersion,
  nextCheckDelay,
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
  /** Read at each tick: the Settings switch, and false for a Store build (the Store updates it). */
  readonly enabled: () => boolean;
  /** A newer version, once per version. */
  readonly onNew: (version: string) => void;
  readonly log: (event: string, fields?: LogFields) => void;
  readonly now?: () => number;
}

export type Outcome = "new" | "same" | "not-modified" | "off" | "failed";

/**
 * One request a day to GitHub's latest-release endpoint (core update.ts has the budget). One timer, never two checks at
 * once, a 10 s deadline, a body cap, and the state on disk so a restart does not ask again.
 */
export class UpdateChecker {
  readonly #deps: UpdateCheckDeps;
  #state: UpdateState = EMPTY_UPDATE_STATE;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stopped = false;

  constructor(deps: UpdateCheckDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** The newer version GitHub last named, or null. Shown on the Help page; costs no request. */
  get available(): string | null {
    const latest = this.#state.latest;
    return latest !== null && isNewerVersion(latest, this.#deps.current) ? latest : null;
  }

  async start(): Promise<void> {
    this.#state = await this.#load();
    this.#schedule(nextCheckDelay(this.#state.checkedAt, this.#now()));
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
      void this.check().then((outcome) => {
        this.#schedule(afterCheck(outcome, this.#state.checkedAt, this.#now()));
      });
    }, delay);
  }

  /** One check. Exposed for tests; the timer is the only caller in the app. */
  async check(): Promise<Outcome> {
    if (this.#running) return "failed";
    if (!this.#deps.enabled()) return "off";
    this.#running = true;
    const started = this.#now();
    let outcome: Outcome = "failed";
    let status = 0;
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `Senderban/${this.#deps.current}`,
      };
      if (this.#state.etag !== null) headers["If-None-Match"] = this.#state.etag;
      const response = await this.#deps.fetch(UPDATE_URL, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      });
      status = response.status;
      let next: UpdateState;
      if (response.status === 304) {
        next = { ...this.#state, checkedAt: this.#now() };
        outcome = "not-modified";
      } else if (response.ok) {
        const latest = LatestReleaseSchema.parse(JSON.parse(await readCapped(response))).tag_name;
        const etag = response.headers.get("etag");
        next = {
          ...this.#state,
          checkedAt: this.#now(),
          etag: etag !== null && etag.length <= 256 ? etag : null,
          latest,
        };
        outcome = "same";
      } else {
        await response.body?.cancel();
        throw new Error(`status ${String(response.status)}`);
      }
      const available = next.latest !== null && isNewerVersion(next.latest, this.#deps.current);
      if (available && next.notified !== next.latest) {
        next = { ...next, notified: next.latest };
        outcome = "new";
      }
      await this.#deps.writeState(this.#deps.statePath, next);
      this.#state = next;
      if (outcome === "new" && next.latest !== null) this.#deps.onNew(next.latest);
      return outcome;
    } catch {
      outcome = "failed";
      return outcome;
    } finally {
      this.#running = false;
      // Never the body or an error text: a fixed outcome, the HTTP status and the time it took.
      this.#deps.log("update-check", { outcome, status, ms: this.#now() - started });
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
 * The next wait. A failure (offline, GitHub down) waits UPDATE_RETRY_MS, never the 60 s first delay, so a machine that stays
 * offline asks 4 times a day, not 1,440. Switched off: look again in a day (the switch is read at each tick).
 */
export function afterCheck(outcome: Outcome, checkedAt: number, now: number): number {
  if (outcome === "failed") return UPDATE_RETRY_MS;
  if (outcome === "off") return UPDATE_INTERVAL_MS;
  return nextCheckDelay(checkedAt, now);
}

/** The body as text, refused past UPDATE_MAX_BYTES whatever Content-Length claims. */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > UPDATE_MAX_BYTES) throw new Error("too large");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    size += value.byteLength;
    if (size > UPDATE_MAX_BYTES) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
