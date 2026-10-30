import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const sent = vi.hoisted(() => [] as string[]);

// Just enough of Electron for ManageWindow to build one window and register its IPC handlers.
vi.mock("electron", () => {
  class FakeWindow {
    readonly webContents = {
      id: 7,
      mainFrame: { processId: 1, routingId: 2 },
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      send: (channel: string) => {
        sent.push(channel);
      },
    };
    isDestroyed = () => false;
    isMinimized = () => false;
    restore = () => undefined;
    focus = () => undefined;
    removeMenu = () => undefined;
    once = () => undefined;
    on = () => undefined;
    show = () => undefined;
    close = () => undefined;
    loadFile = () => Promise.resolve();
  }
  return {
    BrowserWindow: FakeWindow,
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {
      handle: (channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      },
    },
  };
});

const { ManageWindow } = await import("../src/manage.js");

const trusted = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 2 } };
const otherFrame = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 99 } };
const otherWindow = { sender: { id: 8 }, senderFrame: { processId: 1, routingId: 2 } };
const noFrame = { sender: { id: 7 }, senderFrame: null };
const ID = "0b8c4e1a-6f2d-4c3b-9a7e-5d1f3b2a4c6e";

const call = (channel: string, event: unknown, payload?: unknown) => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler(event, payload));
};

let list: Mock<() => unknown>;
let unblock: Mock<(id: string) => Promise<unknown>>;
let onError: ReturnType<typeof vi.fn>;
let status: Mock<() => Promise<unknown>>;
let pause: Mock<(value: boolean) => Promise<void>>;
let page: InstanceType<typeof ManageWindow>;

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
  status = vi.fn(() =>
    Promise.resolve({ version: "1.2.3", paused: false, behind: [], accounts: [] as unknown[] }),
  );
  pause = vi.fn(() => Promise.resolve());
  list = vi.fn(() => []);
  unblock = vi.fn(() => Promise.resolve({ tone: "ok", text: "Unblocked." }));
  onError = vi.fn();
  page = new ManageWindow("assets", {
    list,
    unblock,
    status,
    pause,
    mxrouteList: () => Promise.resolve({ accounts: [], keys: [], keysUnreadable: false }),
    mxrouteSave: () => Promise.resolve("saved"),
    mxrouteRemove: () => Promise.resolve("saved"),
    mxrouteEnable: () => Promise.resolve("saved"),
    onError,
  } as never);
  page.show();
});

describe("manage:status", () => {
  it("answers the trusted page with the status and whether a restart is due", async () => {
    expect(await call("manage:status", trusted)).toEqual({
      version: "1.2.3",
      paused: false,
      behind: [],
      accounts: [],
      restartPending: false,
    });
  });

  it("answers null to another frame, another window or no frame, without reading anything", async () => {
    for (const event of [otherFrame, otherWindow, noFrame]) {
      expect(await call("manage:status", event)).toBeNull();
    }
    expect(status).not.toHaveBeenCalled();
  });

  it("answers null and logs the channel when the accounts cannot be read", async () => {
    status.mockRejectedValueOnce(new Error("bad file"));
    expect(await call("manage:status", trusted)).toBeNull();
    expect(onError).toHaveBeenCalledWith("manage:status", expect.any(Error));
  });
});

describe("the status signal", () => {
  it("sends one signal for a burst of state changes, and another after the gap", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 100; i += 1) page.notifyStatus();
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(499);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(["manage:status-changed"]);
      page.notifyStatus();
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(["manage:status-changed", "manage:status-changed"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manage:pause", () => {
  it("passes the wish on and answers done", async () => {
    expect(await call("manage:pause", trusted, true)).toBe("done");
    expect(pause).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("refuses an untrusted sender without pausing", async () => {
    for (const event of [otherFrame, otherWindow, noFrame]) {
      expect(await call("manage:pause", event, true)).toBe("denied");
    }
    expect(pause).not.toHaveBeenCalled();
  });

  it.each([
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
    ["nothing", undefined],
    ["an object", { paused: true }],
  ])("refuses %s", async (_name, payload) => {
    expect(await call("manage:pause", trusted, payload)).toBe("invalid");
    expect(pause).not.toHaveBeenCalled();
  });

  it("answers busy to a second click while a pause runs, and a restart waits for it", async () => {
    const gate = Promise.withResolvers<undefined>();
    pause.mockReturnValueOnce(gate.promise);
    const first = call("manage:pause", trusted, true);
    expect(await call("manage:pause", trusted, false)).toBe("busy");
    expect(await call("manage:restart", trusted)).toBe("busy");
    gate.resolve(undefined);
    expect(await first).toBe("done");
    expect(pause).toHaveBeenCalledOnce();
  });

  it("answers failed, logs the channel and frees the guard", async () => {
    pause.mockRejectedValueOnce(new Error("logout broke"));
    expect(await call("manage:pause", trusted, true)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:pause", expect.any(Error));
    expect(await call("manage:pause", trusted, true)).toBe("done");
  });
});

describe("manage:init", () => {
  it("answers the trusted page with the entries and nothing else", async () => {
    expect(await call("manage:init", trusted)).toEqual({ entries: [] });
  });

  it("answers null to another frame, another window or no frame, without reading the list", async () => {
    for (const event of [otherFrame, otherWindow, noFrame]) {
      expect(await call("manage:init", event)).toBeNull();
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("answers null and logs the channel when the list cannot be read", async () => {
    list.mockImplementationOnce(() => {
      throw new Error("db locked");
    });
    expect(await call("manage:init", trusted)).toBeNull();
    expect(onError).toHaveBeenCalledWith("manage:init", expect.any(Error));
  });
});

describe("manage:unblock", () => {
  it("ignores an untrusted sender: no sync round starts", async () => {
    for (const event of [otherFrame, otherWindow, noFrame]) {
      expect(await call("manage:unblock", event, ID)).toBeNull();
    }
    expect(unblock).not.toHaveBeenCalled();
  });

  it.each([
    ["not a string", 5],
    ["null", null],
    ["empty", ""],
    ["a path", "../../accounts"],
    ["an id with a suffix", `${ID}x`],
  ])("refuses %s as an entry id", async (_name, payload) => {
    expect(await call("manage:unblock", trusted, payload)).toBeNull();
    expect(unblock).not.toHaveBeenCalled();
  });

  it("unblocks a valid id once and returns the outcome with the list read after it", async () => {
    // The list is read only after the unblock ran: a list taken before it would still hold the old entry.
    let current: unknown[] = [{ id: "before" }];
    list.mockImplementation(() => current);
    unblock.mockImplementationOnce(() => {
      current = [{ id: "after" }];
      return Promise.resolve({ tone: "ok", text: "Unblocked." });
    });
    expect(await call("manage:unblock", trusted, ID)).toEqual({
      tone: "ok",
      text: "Unblocked.",
      entries: [{ id: "after" }],
    });
    expect(unblock).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("ignores a second click while one unblock runs, and allows the next after it ends", async () => {
    const gate = Promise.withResolvers<{ tone: string; text: string }>();
    unblock.mockReturnValueOnce(gate.promise);
    const first = call("manage:unblock", trusted, ID);
    expect(await call("manage:unblock", trusted, ID)).toBeNull();
    gate.resolve({ tone: "ok", text: "Done." });
    await first;
    expect(await call("manage:unblock", trusted, ID)).not.toBeNull();
    expect(unblock).toHaveBeenCalledTimes(2);
  });

  it("answers a failing unblock with null, logs the channel and frees the guard", async () => {
    unblock.mockRejectedValueOnce(new Error("sync broke"));
    expect(await call("manage:unblock", trusted, ID)).toBeNull();
    expect(onError).toHaveBeenCalledWith("manage:unblock", expect.any(Error));
    expect(await call("manage:unblock", trusted, ID)).not.toBeNull();
  });
});
