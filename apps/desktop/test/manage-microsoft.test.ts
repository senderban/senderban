import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftAuthUrl, newPkce, newState } from "@senderban/core";
import { openMicrosoftAuthUrl } from "../src/google-url.js";

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();

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

const { ManageWindow, RESTART_AFTER_ADD_MS } = await import("../src/manage.js");

const trusted = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 2 } };
const otherFrame = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 99 } };
const otherWindow = { sender: { id: 8 }, senderFrame: { processId: 1, routingId: 2 } };

const call = (channel: string, event: unknown, payload?: unknown) => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler(event, payload));
};

let microsoftState: ReturnType<typeof vi.fn>;
let microsoftSignIn: ReturnType<typeof vi.fn>;
let microsoftRemove: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
let restart: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  microsoftState = vi.fn(() => Promise.resolve({ available: true, accounts: [] }));
  microsoftSignIn = vi.fn(() => Promise.resolve("signed-in"));
  microsoftRemove = vi.fn(() => Promise.resolve("removed"));
  onError = vi.fn();
  restart = vi.fn();
  new ManageWindow("assets", {
    list: () => [],
    microsoftState,
    microsoftSignIn,
    microsoftRemove,
    restart,
    googleCancel: () => undefined,
    status: () => Promise.resolve({ version: "1.2.3", paused: false, behind: [], accounts: [] }),
    onError,
  } as never).show();
});

const due = async () =>
  ((await call("manage:status", trusted)) as { restartPending: boolean }).restartPending;

describe("Microsoft IPC", () => {
  it.each([
    ["manage:microsoft-sign-in", undefined],
    ["manage:microsoft-remove", "ms-1"],
  ])("%s refuses any sender but the page", async (channel, payload) => {
    expect(await call(channel, otherFrame, payload)).toBe("denied");
    expect(await call(channel, otherWindow, payload)).toBe("denied");
    expect(microsoftSignIn).not.toHaveBeenCalled();
    expect(microsoftRemove).not.toHaveBeenCalled();
  });

  it("gives the state to the page only", async () => {
    expect(await call("manage:microsoft-state", otherFrame)).toBeNull();
    expect(await call("manage:microsoft-state", trusted)).toEqual({
      available: true,
      accounts: [],
    });
  });

  it.each([{ accountId: "bad id!" }, { accountId: "ms-1", url: "https://evil.example" }, "text"])(
    "refuses a sign-in request that is not the schema's: %j",
    async (payload) => {
      expect(await call("manage:microsoft-sign-in", trusted, payload)).toBe("invalid");
      expect(microsoftSignIn).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 5, "bad id!", "x".repeat(65)])("refuses the account id %j", async (id) => {
    expect(await call("manage:microsoft-remove", trusted, id)).toBe("invalid");
    expect(microsoftRemove).not.toHaveBeenCalled();
  });

  it("offers a restart after a sign-in that worked, and not after one that did not", async () => {
    microsoftSignIn.mockResolvedValueOnce("cancelled");
    await call("manage:microsoft-sign-in", trusted);
    expect(await due()).toBe(false);
    await call("manage:microsoft-sign-in", trusted, { accountId: "ms-1" });
    expect(microsoftSignIn).toHaveBeenLastCalledWith({ accountId: "ms-1" });
    expect(await due()).toBe(true);
  });

  it("offers a restart after a removal", async () => {
    await call("manage:microsoft-remove", trusted, "ms-1");
    expect(await due()).toBe(true);
  });

  it("restarts on its own after a sign-in that worked, and not after a removal", async () => {
    vi.useFakeTimers();
    try {
      await call("manage:microsoft-remove", trusted, "ms-1");
      await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS);
      expect(restart).not.toHaveBeenCalled();
      await call("manage:microsoft-sign-in", trusted);
      await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS);
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a fixed word when a handler throws, and logs the channel", async () => {
    microsoftSignIn.mockRejectedValueOnce(new Error("token xyz"));
    expect(await call("manage:microsoft-sign-in", trusted)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:microsoft-sign-in", expect.any(Error));
  });
});

describe("the browser door", () => {
  const real = buildMicrosoftAuthUrl({
    clientId: "00000000-1111-2222-3333-444444444444",
    redirectUri: "http://localhost:51234",
    state: newState(),
    challenge: newPkce().challenge,
  });

  it("opens Microsoft's sign-in page", async () => {
    const open = vi.fn(() => Promise.resolve());
    await openMicrosoftAuthUrl(open)(real);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each([
    "https://login.microsoftonline.com.evil.example/common/oauth2/v2.0/authorize?x=1",
    "http://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    "file:///C:/Windows/System32/calc.exe",
  ])("refuses %s", async (url) => {
    const open = vi.fn(() => Promise.resolve());
    await expect(openMicrosoftAuthUrl(open)(url)).rejects.toThrow("not Microsoft's consent page");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the page", () => {
  const assets = join(import.meta.dirname, "../assets/manage");
  const html = readFileSync(join(assets, "manage.html"), "utf8");

  it("loads the Microsoft script and starts with the button off, with its reason in the page", () => {
    expect(html).toContain('<script src="microsoft.js"></script>');
    expect(html).toMatch(/id="microsoft-add"[^>]*disabled/u);
    expect(html).toContain('id="microsoft-unavailable"');
    expect(html).toContain('id="microsoft-approval"');
    expect(html).toContain('id="microsoft-approval-link"');
  });

  it("sets text with textContent, and never as markup", () => {
    const script = readFileSync(join(assets, "microsoft.js"), "utf8");
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  });

  it("exposes exactly three Microsoft calls", () => {
    const preload = readFileSync(join(assets, "preload.cjs"), "utf8");
    expect(preload.match(/manage:microsoft-[a-z-]+/gu)).toEqual([
      "manage:microsoft-state",
      "manage:microsoft-sign-in",
      "manage:microsoft-remove",
    ]);
  });
});
