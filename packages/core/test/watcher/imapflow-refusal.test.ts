import { beforeEach, describe, expect, it, vi } from "vitest";
import { FatalWatchError } from "../../src/watcher/watcher.js";

const refusal: { code: string | undefined } = { code: undefined };

vi.mock("imapflow", () => ({
  ImapFlow: class {
    on(): void {
      // Listeners are not needed: connect() fails before any event.
    }
    connect(): Promise<void> {
      return Promise.reject(
        Object.assign(new Error("Command failed"), {
          authenticationFailed: true,
          ...(refusal.code === undefined ? {} : { serverResponseCode: refusal.code }),
        }),
      );
    }
    close(): void {
      // Nothing was opened.
    }
  },
}));

const { MAX_TEMPORARY_REFUSALS, imapflowConnector } =
  await import("../../src/watcher/imapflow-session.js");

const config = { host: "mail.example.test", port: 993, secure: true, user: "u", password: "p" };

describe("imapflowConnector login refusals", () => {
  beforeEach(() => {
    refusal.code = undefined;
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

  it("counts per connector, so another account is not halted by this one", async () => {
    refusal.code = "UNAVAILABLE";
    const first = imapflowConnector(config);
    for (let i = 0; i < MAX_TEMPORARY_REFUSALS - 1; i += 1) await first().catch(() => undefined);
    const second: unknown = await imapflowConnector(config)().catch((e: unknown) => e);
    expect(second).not.toBeInstanceOf(FatalWatchError);
  });
});
