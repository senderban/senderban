import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  opens: [] as { path: string; readOnly: unknown }[],
  closeListeners: [] as (() => void)[],
  uidNext: 2,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    readonly mailbox = { uidNext: 2, readOnly: false };
    readonly capabilities = new Map([["MOVE", true]]);
    readonly usable = true;
    constructor(options: Record<string, unknown>) {
      seen.options.push(options);
    }
    on(event: string, listener: () => void): void {
      if (event === "close") seen.closeListeners.push(listener);
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    mailboxOpen(path: string, options: { readOnly: unknown }) {
      seen.opens.push({ path, readOnly: options.readOnly });
      return Promise.resolve({ uidValidity: 1n, uidNext: seen.uidNext });
    }
    close(): void {
      // Nothing is open.
    }
  },
}));

const { imapflowConnector, CLEAN_IDLE_DELAY_MS } =
  await import("../../src/watcher/imapflow-session.js");
const { cleanConnector } = await import("../../src/imap-clean/imapflow-mailbox.js");
const { CleanLink, UID_MAX } = await import("../../src/imap-clean/session.js");

const config = { host: "mail.example.test", port: 993, secure: true, user: "u", password: "p" };

beforeEach(() => {
  seen.options.length = 0;
  seen.opens.length = 0;
  seen.closeListeners.length = 0;
  seen.uidNext = 2;
});

describe("a session that only watches", () => {
  it("opens the Inbox read-only, with the library's own IDLE delay", async () => {
    await imapflowConnector(config)();
    expect(seen.opens).toEqual([{ path: "INBOX", readOnly: true }]);
    expect(seen.options[0]).not.toHaveProperty("autoIdleDelay");
  });
});

describe("a server's UIDNEXT", () => {
  it("is taken up to one past the largest UID", async () => {
    seen.uidNext = UID_MAX + 1;
    await expect(imapflowConnector(config)()).resolves.toBeDefined();
  });

  it("is refused past that: a saved cursor built on it would never read again", async () => {
    seen.uidNext = UID_MAX + 2;
    await expect(imapflowConnector(config)()).rejects.toThrow("UIDNEXT");
  });
});

describe("a cleaning session", () => {
  it("opens the Inbox writable and goes back to IDLE quickly", async () => {
    await cleanConnector(config, new CleanLink())();
    expect(seen.opens).toEqual([{ path: "INBOX", readOnly: false }]);
    expect(seen.options[0]).toMatchObject({ autoIdleDelay: CLEAN_IDLE_DELAY_MS });
  });

  it("is on the link while it lives", async () => {
    const link = new CleanLink();
    await cleanConnector(config, link)();
    expect(link.current).not.toBeNull();
    for (const listener of seen.closeListeners) listener();
    expect(link.current).toBeNull();
  });
});
