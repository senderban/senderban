import { afterEach, describe, expect, it, vi } from "vitest";

const client: { usable: boolean; closes: number; hangLogout: boolean } = {
  usable: true,
  closes: 0,
  hangLogout: true,
};

vi.mock("imapflow", () => ({
  ImapFlow: class {
    #stop: (() => void) | null = null;
    get usable(): boolean {
      return client.usable;
    }
    on(): void {
      // Nothing here emits.
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    mailboxOpen(): Promise<{ uidNext: number; uidValidity: bigint }> {
      return Promise.resolve({ uidNext: 5, uidValidity: 1n });
    }
    logout(): Promise<void> {
      if (!client.hangLogout) return Promise.resolve();
      // A server that takes the login and then never answers LOGOUT.
      return new Promise((_, reject) => {
        this.#stop = () => {
          reject(new Error("socket closed"));
        };
      });
    }
    close(): void {
      client.closes += 1;
      this.#stop?.();
    }
  },
}));

const { LOGOUT_TIMEOUT_MS, imapflowConnector } =
  await import("../../src/watcher/imapflow-session.js");

const config = { host: "mail.example.test", port: 993, secure: true, user: "u", password: "p" };

describe("MailboxSession.close", () => {
  afterEach(() => {
    vi.useRealTimers();
    client.usable = true;
    client.closes = 0;
    client.hangLogout = true;
  });

  it("closes the socket when the server never answers LOGOUT", async () => {
    const session = await imapflowConnector(config)();
    vi.useFakeTimers();
    const closing = session.close();
    const failed = expect(closing).rejects.toThrow("socket closed");
    await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS - 1);
    expect(client.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.closes).toBe(1);
    await failed;
  });

  it("leaves no timer behind after a clean LOGOUT", async () => {
    client.hangLogout = false;
    const session = await imapflowConnector(config)();
    vi.useFakeTimers();
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.closes).toBe(0);
  });
});
