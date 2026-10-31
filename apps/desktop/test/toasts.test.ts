import { DEFAULT_SETTINGS } from "@senderban/core";
import type { Settings } from "@senderban/core";
import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: FakeNotification[] = [];
const activate = vi.hoisted((): { click: (details: unknown) => void } => ({
  click: () => undefined,
}));

// Just enough of Electron's Notification: it records what was created and closed.
vi.mock("electron", () => {
  class FakeNotification {
    static handleActivation = (handler: (details: unknown) => void): void => {
      activate.click = handler;
    };
    closed = false;
    constructor(readonly options: { readonly toastXml?: string; readonly body?: string }) {
      created.push(this);
    }
    listeners = new Map<string, () => void>();
    on = (name: string, listener: () => void): void => {
      this.listeners.set(name, listener);
    };
    show = (): void => undefined;
    close = (): void => {
      this.closed = true;
    };
  }
  return { Notification: FakeNotification };
});

interface FakeNotification {
  closed: boolean;
  listeners: Map<string, () => void>;
  options: { readonly toastXml?: string; readonly body?: string };
}

const { Toasts, spamStripUrls } = await import("../src/toasts.js");

const STRIPS = spamStripUrls(join("C:", sep, "Senderban", "assets"));

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const toast = (n: number) => ({
  id: uuid(n),
  sender: "a@example.com",
  subject: "hi",
  account: "me",
  spamScore: null,
  domain: null,
  rejectsAtServer: false,
});

beforeEach(() => {
  created.length = 0;
});

describe("the person's settings", () => {
  const ID = uuid(1);
  let settings: Settings;
  const make = (tone: "ok" | "warn" | "error") => {
    const choose = vi.fn(() => Promise.resolve({ tone, text: "done" }));
    const quiet = vi.fn(() => Promise.resolve({ tone, text: "quiet done" }));
    const onRefused = vi.fn();
    return {
      choose,
      quiet,
      onRefused,
      toasts: new Toasts({
        settings: () => settings,
        spamStrips: STRIPS,
        choose,
        quiet,
        onActivation: () => undefined,
        onIgnored: () => undefined,
        onRefused,
        onError: () => undefined,
      }),
    };
  };
  const click = async (): Promise<void> => {
    activate.click({ arguments: `act=sender;id=${ID}` });
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    settings = DEFAULT_SETTINGS;
  });

  it("stays quiet after a block that worked, with confirmation off", async () => {
    const { choose } = make("ok");
    await click();
    expect(choose).toHaveBeenCalledOnce();
    expect(created).toHaveLength(0);
  });

  it("confirms a block that worked, with confirmation on", async () => {
    settings = { ...DEFAULT_SETTINGS, confirmBlocks: true };
    make("ok");
    await click();
    expect(created[0]?.options.body).toBe("done");
  });

  it.each([
    ["warn", "! done"],
    ["error", "✗ done"],
  ] as const)("always shows a %s", async (tone, body) => {
    make(tone);
    await click();
    expect(created[0]?.options.body).toBe(body);
  });

  it("hands a click with no choice the default action of that moment", async () => {
    const { choose } = make("ok");
    settings = { ...DEFAULT_SETTINGS, defaultAction: "trash" };
    await click();
    expect(choose).toHaveBeenCalledWith(ID, "address", "trash");
  });

  it("builds a toast from the settings of that moment", () => {
    const { toasts } = make("ok");
    settings = { ...DEFAULT_SETTINGS, toastDuration: "short", defaultAction: "trash" };
    toasts.show(toast(1));
    expect(created[0]?.options.toastXml).toContain('<toast duration="short"');
    expect(created[0]?.options.toastXml).toContain('defaultInput="trash"');
  });

  it("sends Don't ask again to the list, never to a block", async () => {
    const { choose, quiet } = make("ok");
    activate.click({ arguments: `act=sender;id=${ID}`, userInputs: { target: "quiet" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(quiet).toHaveBeenCalledWith(ID, "address");
    expect(choose).not.toHaveBeenCalled();
  });

  it("reports a toast Windows refused, and stops tracking it", () => {
    const { toasts, onRefused } = make("ok");
    toasts.show(toast(1));
    created[0]?.listeners.get("failed")?.();
    expect(onRefused).toHaveBeenCalledOnce();
    toasts.closeAll();
    expect(created[0]?.closed).toBe(false);
  });

  it("gives a toast with a score its strip", () => {
    const { toasts } = make("ok");
    toasts.show({ ...toast(1), spamScore: 9 });
    expect(created[0]?.options.toastXml).toContain(`<image src="${STRIPS.high}"`);
  });
});

describe("spamStripUrls", () => {
  it("points a development build at the assets folder", () => {
    const urls = spamStripUrls(join("C:", sep, "my folder", "assets"));
    expect(urls.high).toMatch(/^file:\/\/.*my%20folder\/assets\/toast\/spam-high\.png$/u);
    expect(urls.low).toMatch(/spam-low\.png$/u);
    expect(urls.medium).toMatch(/spam-medium\.png$/u);
  });

  it("points an installed build outside app.asar, where Windows can read the file", () => {
    const urls = spamStripUrls(join("C:", sep, "Senderban", "resources", "app.asar", "assets"));
    expect(urls.high).toContain("/resources/app.asar.unpacked/assets/toast/spam-high.png");
  });
});

describe("Toasts tracking", () => {
  it("keeps at most 50 live toasts, dropping the oldest", () => {
    const toasts = new Toasts({
      settings: () => DEFAULT_SETTINGS,
      spamStrips: STRIPS,
      choose: () => Promise.resolve({ tone: "ok", text: "" }),
      quiet: () => Promise.resolve({ tone: "ok", text: "" }),
      onActivation: () => undefined,
      onIgnored: () => undefined,
      onRefused: () => undefined,
      onError: () => undefined,
    });
    for (let n = 0; n < 60; n += 1) toasts.show(toast(n));
    expect(created).toHaveLength(60);

    toasts.closeAll();
    const closed = created.filter((notification) => notification.closed);
    expect(closed).toHaveLength(50);
    // The ten oldest were forgotten before quit; the newest fifty are the ones closed.
    expect(created.slice(0, 10).every((notification) => !notification.closed)).toBe(true);
    expect(created.slice(10).every((notification) => notification.closed)).toBe(true);

    // A second call finds nothing left to close.
    created.forEach((notification) => {
      notification.closed = false;
    });
    toasts.closeAll();
    expect(created.some((notification) => notification.closed)).toBe(false);
  });
});
