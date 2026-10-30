import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state: {
    listeners: Map<string, (value?: unknown) => void>;
    fetchError: Error | null;
    connectError: Error | null;
  } = { listeners: new Map(), fetchError: null, connectError: null };
  return state;
});

vi.mock("imapflow", () => ({
  ImapFlow: class {
    usable = true;
    on(name: string, listener: (value?: unknown) => void): void {
      fake.listeners.set(name, listener);
    }
    connect(): Promise<void> {
      const error = fake.connectError;
      if (error === null) return Promise.resolve();
      fake.listeners.get("error")?.(error);
      return Promise.reject(error);
    }
    mailboxOpen(): Promise<{ uidNext: number; uidValidity: bigint }> {
      return Promise.resolve({ uidNext: 5, uidValidity: 1n });
    }
    fetch(): AsyncIterable<never> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(fake.fetchError ?? new Error("no error set")),
        }),
      };
    }
    close(): void {
      // Nothing to close.
    }
  },
}));

const { imapflowConnector } = await import("../../src/watcher/imapflow-session.js");
const { UnreadableMailError } = await import("../../src/watcher/watcher.js");

const config = { host: "mail.example.test", port: 993, secure: true, user: "u", password: "p" };
const coded = (code: string) => Object.assign(new Error("too large"), { code });

beforeEach(() => {
  fake.listeners.clear();
  fake.fetchError = null;
  fake.connectError = null;
});

describe("a size limit after login", () => {
  it.each(["LineTooLarge", "LiteralTooLarge", "ResponseTooLarge", "TooManyTokens"])(
    "calls %s from a fetch an unreadable mail",
    async (code) => {
      const session = await imapflowConnector(config)();
      fake.fetchError = coded(code);
      await expect(session.fetchSince(1)).rejects.toBeInstanceOf(UnreadableMailError);
    },
  );

  it("says the same through the close event, which the stream limits reach first", async () => {
    const session = await imapflowConnector(config)();
    const causes: unknown[] = [];
    session.onClose((cause) => {
      causes.push(cause);
    });
    fake.listeners.get("error")?.(coded("LineTooLarge"));
    fake.listeners.get("close")?.();
    expect(causes[0]).toBeInstanceOf(UnreadableMailError);
  });

  it("leaves any other failure as it is", async () => {
    const session = await imapflowConnector(config)();
    fake.fetchError = coded("ECONNRESET");
    await expect(session.fetchSince(1)).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  it("does not blame a mail before the mailbox is open: that is the server", async () => {
    fake.connectError = coded("LineTooLarge");
    await expect(imapflowConnector(config)()).rejects.toMatchObject({ code: "LineTooLarge" });
  });
});
