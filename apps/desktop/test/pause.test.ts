import { describe, expect, it, vi } from "vitest";
import { AccountWatcher, FatalWatchError } from "@senderban/core";
import type { CursorStore, MailboxSession } from "@senderban/core";
import { applyPause } from "../src/pause.js";

const session = (logout: Promise<void>): MailboxSession => ({
  uidValidity: "1",
  uidNext: 1,
  fetchSince: () => Promise.resolve([]),
  onExists: () => undefined,
  onClose: () => undefined,
  close: () => logout,
});

const cursors: CursorStore = { get: () => undefined, set: () => undefined };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function watcher(connect: () => Promise<MailboxSession>): AccountWatcher {
  return new AccountWatcher({
    accountId: "a",
    connect,
    cursors,
    onMessage: () => undefined,
  });
}

const gmail = () => ({ stop: vi.fn(), resume: vi.fn() });

describe("applyPause", () => {
  it("a Resume that arrives during a Pause leaves every watcher running", async () => {
    let endLogout = (): void => undefined;
    const logout = new Promise<void>((resolve) => {
      endLogout = resolve;
    });
    const watchers = [1, 2, 3].map(() => watcher(() => Promise.resolve(session(logout))));
    for (const w of watchers) w.start();
    await flush();
    expect(watchers.map((w) => w.current)).toEqual(["watching", "watching", "watching"]);

    const pausing = applyPause(true, watchers, gmail());
    expect(watchers.map((w) => w.current)).toEqual(["stopped", "stopped", "stopped"]);
    await applyPause(false, watchers, gmail());
    endLogout();
    await pausing;
    await flush();

    expect(watchers.map((w) => w.current)).toEqual(["watching", "watching", "watching"]);
    await Promise.all(watchers.map((w) => w.stop()));
  });

  it("waits for logouts together, not one after another", async () => {
    let closing = 0;
    let most = 0;
    const slow: MailboxSession = {
      ...session(Promise.resolve()),
      close: async () => {
        closing += 1;
        most = Math.max(most, closing);
        await flush();
        closing -= 1;
      },
    };
    const watchers = [1, 2, 3].map(() => watcher(() => Promise.resolve(slow)));
    for (const w of watchers) w.start();
    await flush();
    await applyPause(true, watchers, gmail());
    expect(most).toBe(3);
  });

  it("a halted account sends no refused password, however often the person toggles", async () => {
    const connect = vi.fn(() => Promise.reject(new FatalWatchError("authentication failed")));
    const halted = watcher(connect);
    halted.start();
    await flush();
    const g = gmail();
    for (let i = 0; i < 5; i += 1) {
      await applyPause(true, [halted], g);
      const result = await applyPause(false, [halted], g);
      expect(result).toEqual({ watchers: 1, halted: 1 });
    }
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(halted.current).toBe("halted");
    expect(g.resume).toHaveBeenCalledTimes(5);
  });
});
