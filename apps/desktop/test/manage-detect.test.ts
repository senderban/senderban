import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const closers = vi.hoisted(() => [] as (() => void)[]);

// Just enough of Electron for ManageWindow to build one window and register its IPC handlers.
vi.mock("electron", () => {
  class FakeWindow {
    readonly webContents = {
      id: 7,
      mainFrame: { processId: 1, routingId: 2 },
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      send: () => undefined,
    };
    isDestroyed = () => false;
    isMinimized = () => false;
    restore = () => undefined;
    focus = () => undefined;
    removeMenu = () => undefined;
    once = () => undefined;
    on = (event: string, listener: () => void) => {
      if (event === "closed") closers.push(listener);
    };
    show = () => undefined;
    close = () => undefined;
    loadFile = () => Promise.resolve();
  }
  return {
    BrowserWindow: FakeWindow,
    dialog: {},
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {
      handle: (channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      },
    },
  };
});

const { ManageWindow } = await import("../src/manage.js");
type Handlers = ConstructorParameters<typeof ManageWindow>[1];

const trusted = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 2 } };
const stranger = { sender: { id: 8 }, senderFrame: { processId: 1, routingId: 2 } };

const call = (event: unknown, payload?: unknown) => {
  const handler = handlers.get("manage:account-detect");
  if (handler === undefined) throw new Error("no handler");
  return Promise.resolve(handler(event, payload));
};

let accountDetect: Mock<(address: string, signal: AbortSignal) => Promise<unknown>>;
let onError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  closers.length = 0;
  accountDetect = vi.fn(() => Promise.resolve({ kind: "gmail" }));
  onError = vi.fn();
  new ManageWindow("assets", {
    accountDetect,
    onError,
    googleCancel: () => undefined,
  } as unknown as Handlers).show();
});

describe("manage:account-detect", () => {
  it("refuses a sender that is not the page", async () => {
    expect(await call(stranger, { address: "you@example.com" })).toBe("denied");
    expect(accountDetect).not.toHaveBeenCalled();
  });

  it.each([
    [undefined],
    ["you@example.com"],
    [{ address: "not an address" }],
    [{ address: "you@example.com", host: "evil.example.net" }],
    [{ address: `${"a".repeat(70)}@example.com` }],
  ])("refuses a bad payload %j", async (payload) => {
    expect(await call(trusted, payload)).toBe("invalid");
    expect(accountDetect).not.toHaveBeenCalled();
  });

  it("passes the address on in its canonical form, with a way to stop", async () => {
    expect(await call(trusted, { address: " You@Example.COM " })).toEqual({ kind: "gmail" });
    expect(accountDetect.mock.calls[0]?.[0]).toBe("you@example.com");
    expect(accountDetect.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("runs one at a time, and frees the slot when it ends", async () => {
    let finish: (reply: unknown) => void = () => undefined;
    accountDetect.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = call(trusted, { address: "you@example.com" });
    expect(await call(trusted, { address: "you@example.com" })).toBe("busy");
    finish({ kind: "unknown" });
    expect(await first).toEqual({ kind: "unknown" });
    expect(await call(trusted, { address: "you@example.com" })).toEqual({ kind: "gmail" });
  });

  it("takes a handful a minute, and frees them after it", async () => {
    vi.useFakeTimers();
    try {
      const replies = [];
      for (let i = 0; i < 7; i += 1) {
        replies.push(await call(trusted, { address: "you@example.com" }));
      }
      expect(replies.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => ({ kind: "gmail" })));
      expect(replies[6]).toBe("limit");
      expect(accountDetect).toHaveBeenCalledTimes(6);
      vi.advanceTimersByTime(60_000);
      expect(await call(trusted, { address: "you@example.com" })).toEqual({ kind: "gmail" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends with the window", async () => {
    let seen: AbortSignal | undefined;
    accountDetect.mockImplementationOnce((_, signal) => {
      seen = signal;
      return new Promise(() => undefined);
    });
    void call(trusted, { address: "you@example.com" });
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    for (const close of closers) close();
    expect(seen?.aborted).toBe(true);
  });

  it("reports a failure as a fixed word, and logs it under the channel", async () => {
    accountDetect.mockRejectedValueOnce(new Error("resolver said example.com"));
    expect(await call(trusted, { address: "you@example.com" })).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:account-detect", expect.any(Error));
  });
});
