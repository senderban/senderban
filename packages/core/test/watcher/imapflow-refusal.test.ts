import { beforeEach, describe, expect, it, vi } from "vitest";
import { FatalWatchError } from "../../src/watcher/watcher.js";

const refusal: { code: string | undefined; hang: boolean; closes: number } = {
  code: undefined,
  hang: false,
  closes: 0,
};

vi.mock("imapflow", () => ({
  ImapFlow: class {
    #stop: (() => void) | null = null;
    on(): void {
      // Listeners are not needed: connect() fails before any event.
    }
    connect(): Promise<void> {
      // A stalled server: the login never answers until the socket is closed under it.
      if (refusal.hang) {
        return new Promise((_, reject) => {
          this.#stop = () => {
            reject(new Error("socket closed"));
          };
        });
      }
      return Promise.reject(
        Object.assign(new Error("Command failed"), {
          authenticationFailed: true,
          ...(refusal.code === undefined ? {} : { serverResponseCode: refusal.code }),
        }),
      );
    }
    close(): void {
      refusal.closes += 1;
      this.#stop?.();
    }
  },
}));

const { MAX_TEMPORARY_REFUSALS, imapflowConnector } =
  await import("../../src/watcher/imapflow-session.js");

const config = { host: "mail.example.test", port: 993, secure: true, user: "u", password: "p" };

describe("imapflowConnector login refusals", () => {
  beforeEach(() => {
    refusal.code = undefined;
    refusal.hang = false;
    refusal.closes = 0;
  });

  it("halts at once on a plain refusal (wrong password)", async () => {
    await expect(imapflowConnector(config)()).rejects.toBeInstanceOf(FatalWatchError);
  });

  it("retries a temporary refusal, then halts after MAX_TEMPORARY_REFUSALS in a row", async () => {
    refusal.code = "UNAVAILABLE";
    const connect = imapflowConnector(config);
    for (let i = 1; i < MAX_TEMPORARY_REFUSALS; i += 1) {
      const error: unknown = await connect().catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(FatalWatchError);
    }
    await expect(connect()).rejects.toBeInstanceOf(FatalWatchError);
  });

  // Pre-push performance review W1: the app built a new connector per attempt, so the counter never reached the limit.
  it("keeps counting across attempts when the password is read per attempt", async () => {
    refusal.code = "UNAVAILABLE";
    let reads = 0;
    const connect = imapflowConnector({
      ...config,
      password: () => {
        reads += 1;
        return Promise.resolve("p");
      },
    });
    for (let i = 1; i < MAX_TEMPORARY_REFUSALS; i += 1) await connect().catch(() => undefined);
    await expect(connect()).rejects.toBeInstanceOf(FatalWatchError);
    expect(reads).toBe(MAX_TEMPORARY_REFUSALS);
  });

  // Pre-push performance review W2: a login the watcher gave up on kept its socket for up to 300 s.
  it("closes the socket of a stalled login the moment its signal aborts", async () => {
    refusal.hang = true;
    const controller = new AbortController();
    const attempt = imapflowConnector(config)(controller.signal);
    const result = attempt.catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    expect(refusal.closes).toBe(0);
    const reason = new Error("login did not finish");
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(refusal.closes).toBeGreaterThan(0);
  });

  it("does not open a connection when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("late"));
    await expect(imapflowConnector(config)(controller.signal)).rejects.toThrow("late");
    expect(refusal.closes).toBe(0);
  });

  it("counts per connector, so another account is not halted by this one", async () => {
    refusal.code = "UNAVAILABLE";
    const first = imapflowConnector(config);
    for (let i = 0; i < MAX_TEMPORARY_REFUSALS - 1; i += 1) await first().catch(() => undefined);
    const second: unknown = await imapflowConnector(config)().catch((e: unknown) => e);
    expect(second).not.toBeInstanceOf(FatalWatchError);
  });
});
