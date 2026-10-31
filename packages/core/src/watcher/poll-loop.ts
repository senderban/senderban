import { AdapterError } from "../adapter.js";
import type { AdapterErrorCode } from "../adapter.js";
import { unlimited } from "../gate.js";
import type { Gate } from "../gate.js";

/**
 * `starting`: started, no poll has worked yet. `watching`: the last poll worked (`lastOkAt` says when). `backoff`: it failed and the next try is later (`detail` says why).
 * `halted-auth`: the provider refused the sign-in. `halted-rejected`: it refused `rejectedHalt` polls in a row. Nothing is polled in
 * either until `start()` again. Silence is never read as "all quiet":
 * a watcher that is not `watching` is not looking.
 */
export type PollState =
  "stopped" | "starting" | "watching" | "backoff" | "halted-auth" | "halted-rejected";
export type PollBackoffDetail = "quota" | "transient" | "rejected";

export interface PollTiming {
  /** The gap between two polls. Milliseconds; the jitter is drawn uniformly, so the mean stays `baseMs`. */
  readonly poll: { readonly baseMs: number; readonly jitterMs: number };
  /** A start or a resume schedules the first poll somewhere in this window. Milliseconds. */
  readonly startSpreadMs: number;
  /** After a failure the delay's ceiling doubles from `baseMs` to `maxMs`, and equal jitter draws half of it fixed and half random. Milliseconds. */
  readonly backoff: { readonly baseMs: number; readonly maxMs: number };
  /** One poll, from its first request to its last, at most: past this it is dead, not slow. Milliseconds. */
  readonly deadlineMs: number;
  /** Polls in a row the provider refused (a 4xx that is not about the sign-in or our quota) before the loop stops asking. Polls. */
  readonly rejectedHalt: number;
}

/** A poll's view of its own life: nothing may be written or announced once `alive()` is false. */
export interface PollContext {
  readonly signal: AbortSignal;
  alive(): boolean;
}

export interface PollLoopOptions<Summary> {
  readonly timing: PollTiming;
  /** One poll. It may throw `AdapterError`; anything else counts as a passing failure. */
  readonly poll: (context: PollContext) => Promise<Summary>;
  readonly onState: (state: PollState, detail?: PollBackoffDetail) => void;
  /** A poll that worked, and how long it took. Milliseconds. */
  readonly onDone: (summary: Summary, ms: number) => void;
  readonly onFailed: (code: AdapterErrorCode, ms: number) => void;
  /** `stop()` was called: what a poll keeps between tries is dropped. */
  readonly onStop?: () => void;
  /** Shared by every watcher of the device; bounds simultaneous polls. Unlimited when absent. */
  readonly gate?: Gate;
  /** Injectable for tests; returns [0, 1). */
  readonly random?: () => number;
  readonly now?: () => number;
}

/** A poll in the air: its epoch, and the abort that `stop()` and the deadline use. */
interface Flight {
  readonly epoch: number;
  readonly controller: AbortController;
}

export function classifyPollError(error: unknown): {
  halt: boolean;
  detail: PollBackoffDetail;
  code: AdapterErrorCode;
} {
  if (error instanceof AdapterError) {
    if (error.code === "AUTH_REQUIRED") return { halt: true, detail: "rejected", code: error.code };
    if (error.code === "QUOTA_EXCEEDED") return { halt: false, detail: "quota", code: error.code };
    if (error.code === "REJECTED") return { halt: false, detail: "rejected", code: error.code };
    return { halt: false, detail: "transient", code: error.code };
  }
  return { halt: false, detail: "transient", code: "TRANSIENT" };
}

/**
 * The lifecycle of a polling watcher, without knowing what a poll reads: one poll in the air, the next timer set when the last poll
 * ends (never a repeating timer), a start or resume spread over a window, failures backing off with equal jitter, a deadline that
 * frees the gate slot, and a halt that only `start()` lifts.
 */
export class PollLoop<Summary> {
  readonly #options: PollLoopOptions<Summary>;
  readonly #gate: Gate;
  readonly #random: () => number;
  readonly #now: () => number;
  #state: PollState = "stopped";
  #detail: PollBackoffDetail | undefined;
  /** Bumped on every start and stop; the result of an older epoch belongs to nobody. */
  #epoch = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** The poll in the air, if any. A stale one (older epoch) may still be winding down while a newer epoch polls. */
  #flight: Flight | null = null;
  /** A resume came while a poll ran: the next poll comes soon, not after a full interval. */
  #soon = false;
  #failures = 0;
  #rejected = 0;
  #lastOkAt: number | null = null;

  constructor(options: PollLoopOptions<Summary>) {
    this.#options = options;
    this.#gate = options.gate ?? unlimited;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  get current(): PollState {
    return this.#state;
  }

  /**
   * When the last poll worked (epoch milliseconds), or null before the first one: what tells "no new mail" from "not looking". It is
   * kept across `stop()` and `start()`, so read it together with `current`: only a `watching` watcher has polled lately.
   */
  get lastOkAt(): number | null {
    return this.#lastOkAt;
  }

  start(): void {
    if (this.#isRunning()) return;
    this.#epoch += 1;
    this.#failures = 0;
    this.#rejected = 0;
    this.#setState("starting");
    this.#schedule(this.#spread());
  }

  stop(): void {
    this.#epoch += 1;
    this.#clearTimer();
    // A poll in the air is called off, not waited for: its request is aborted and its gate slot comes back.
    this.#flight?.controller.abort();
    this.#soon = false;
    this.#options.onStop?.();
    // A halt outlives a stop: only `start()`, after a new sign-in or a restart, may ask the provider again.
    if (this.#state !== "halted-auth" && this.#state !== "halted-rejected") {
      this.#setState("stopped");
    }
  }

  /** The end of a pause: picks up what the pause stopped, and leaves a halted account alone. */
  resume(): void {
    if (this.#state === "stopped") this.start();
  }

  /** After system resume (a sleeping poll may have died unreported): look soon, spread like a start so 50 accounts do not tick together. */
  resumeNow(): void {
    if (!this.#isRunning()) return;
    if (this.#flight?.epoch === this.#epoch) {
      this.#soon = true;
      return;
    }
    this.#schedule(this.#spread());
  }

  /** Started and not stopped or halted: a timer or a poll is, or is about to be, in the air. */
  #isRunning(): boolean {
    return this.#state === "starting" || this.#state === "watching" || this.#state === "backoff";
  }

  #spread(): number {
    return Math.round(this.#random() * this.#options.timing.startSpreadMs);
  }

  #setState(state: PollState, detail?: PollBackoffDetail): void {
    if (this.#state === state && this.#detail === detail) return;
    this.#state = state;
    this.#detail = detail;
    try {
      this.#options.onState(state, detail);
    } catch {
      // a listener must not break the watcher
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    this.#clearTimer();
    const epoch = this.#epoch;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#poll(epoch);
    }, delayMs);
  }

  /** Uniform around the base: the mean stays `baseMs`, so the daily call count is the one the budget was derived from. */
  #interval(): number {
    const { baseMs, jitterMs } = this.#options.timing.poll;
    return Math.round(baseMs - jitterMs + 2 * jitterMs * this.#random());
  }

  /** Equal jitter: half fixed, half random, so 50 accounts do not retry in lockstep after a network blip. */
  #backoffDelay(): number {
    const { baseMs, maxMs } = this.#options.timing.backoff;
    const ceiling = Math.min(maxMs, baseMs * 2 ** (this.#failures - 1));
    return Math.round(ceiling / 2 + (ceiling / 2) * this.#random());
  }

  #report(report: () => void): void {
    try {
      report();
    } catch {
      // a log must not break the watcher
    }
  }

  /** Still the current epoch, and not called off or past its deadline: nothing may be written or announced otherwise. */
  #alive(epoch: number, signal: AbortSignal): boolean {
    return epoch === this.#epoch && !signal.aborted;
  }

  async #poll(epoch: number): Promise<void> {
    if (epoch !== this.#epoch) return;
    // One poll per epoch. An older epoch's poll may still be winding down (it was aborted by `stop()`); it is not waited for.
    // A poll that was called off while it WAITED for a gate slot is not settled by `stop()`: it ends only when its turn comes, so it can
    // outlive its epoch. This check and the `finally` below keep it from blocking, or clearing the bookkeeping of, a newer epoch's poll.
    if (this.#flight?.epoch === epoch) return;
    const controller = new AbortController();
    const flight: Flight = { epoch, controller };
    this.#flight = flight;
    const signal = controller.signal;
    const started = this.#now();
    const took = (): number => Math.max(0, this.#now() - started);
    let next: number | null;
    try {
      const summary = await this.#gate(() => this.#gated(epoch, signal, controller));
      if (!this.#alive(epoch, signal)) return;
      this.#failures = 0;
      this.#rejected = 0;
      this.#lastOkAt = this.#now();
      this.#setState("watching");
      this.#report(() => {
        this.#options.onDone(summary, took());
      });
      next = this.#soon ? this.#spread() : this.#interval();
    } catch (error) {
      // A poll of an older epoch, or one that was called off, ends here without a word: `stop()` already said "stopped".
      if (epoch !== this.#epoch) return;
      const { halt, detail, code } = classifyPollError(error);
      this.#report(() => {
        this.#options.onFailed(code, took());
      });
      if (halt) {
        this.#setState("halted-auth");
        next = null;
      } else {
        this.#failures += 1;
        this.#rejected = detail === "rejected" ? this.#rejected + 1 : 0;
        if (this.#rejected >= this.#options.timing.rejectedHalt) {
          // Asking again is not going to change what the provider answers: stop, and say so (state), until a start begins again.
          this.#setState("halted-rejected");
          next = null;
        } else {
          this.#setState("backoff", detail);
          next = this.#backoffDelay();
        }
      }
    } finally {
      // Only this poll's own bookkeeping: a newer epoch's flight and its `#soon` are not this one's to clear.
      if (this.#flight === flight) {
        this.#flight = null;
        this.#soon = false;
      }
    }
    if (next !== null && epoch === this.#epoch) this.#schedule(next);
  }

  /**
   * What runs once the gate has given this poll its slot. A poll that was called off while it queued sends nothing and ends at once.
   * The deadline starts here (the queue is not the poll's time), with our own timer rather than `AbortSignal.timeout`, so `stop()` and
   * the deadline end a poll the same way. The race against `dead` covers what the signal cannot reach (a token refresh that never ends)
   * and frees the slot; `dead` is made here, after the check, so an abort can never reach a promise nobody is listening to.
   */
  async #gated(epoch: number, signal: AbortSignal, controller: AbortController): Promise<Summary> {
    if (!this.#alive(epoch, signal)) throw new AdapterError("TRANSIENT", "the poll was called off");
    const deadline = setTimeout(() => {
      controller.abort(new AdapterError("TRANSIENT", "the poll did not finish in time"));
    }, this.#options.timing.deadlineMs);
    try {
      const dead = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new AdapterError("TRANSIENT", "the poll was called off"),
            );
          },
          { once: true },
        );
      });
      const context: PollContext = { signal, alive: () => this.#alive(epoch, signal) };
      return await Promise.race([this.#options.poll(context), dead]);
    } finally {
      clearTimeout(deadline);
    }
  }
}
