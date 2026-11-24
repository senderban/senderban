import { DEFAULT_SETTINGS, createActivationSigner } from "@senderban/core";
import type { Settings } from "@senderban/core";
import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: FakeNotification[] = [];
const activate = vi.hoisted((): { click: (details: unknown) => void; registeredAfter: number } => ({
  click: () => undefined,
  registeredAfter: -1,
}));

// Just enough of Electron's Notification: it records what was created and closed.
vi.mock("electron", () => {
  class FakeNotification {
    static handleActivation = (handler: (details: unknown) => void): void => {
      activate.click = handler;
      activate.registeredAfter = created.length;
    };
    closed = false;
    shown = false;
    constructor(readonly options: { readonly toastXml?: string; readonly body?: string }) {
      created.push(this);
    }
    listeners = new Map<string, () => void>();
    on = (name: string, listener: () => void): void => {
      this.listeners.set(name, listener);
    };
    show = (): void => {
      this.shown = true;
    };
    close = (): void => {
      this.closed = true;
    };
  }
  return { Notification: FakeNotification };
});

interface FakeNotification {
  closed: boolean;
  shown: boolean;
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
    const made = build(tone);
    created.length = 0;
    return made;
  };
  const build = (tone: "ok" | "warn" | "error") => {
    const choose = vi.fn(() => Promise.resolve({ tone, text: "done" }));
    const quiet = vi.fn(() => Promise.resolve({ tone, text: "quiet done" }));
    const onRefused = vi.fn();
    const onError = vi.fn();
    const openRecent = vi.fn();
    const held: string[] = [];
    return {
      choose,
      quiet,
      openRecent,
      onRefused,
      onError,
      held,
      toasts: new Toasts({
        settings: () => settings,
        spamStrips: STRIPS,
        signer: () => Promise.resolve(null),
        choose,
        quiet,
        openRecent,
        onActivation: () => undefined,
        onIgnored: () => undefined,
        onRefused,
        onError,
        hold: async <T>(work: () => Promise<T>): Promise<T> => {
          held.push("start");
          const value = await work();
          held.push("end");
          return value;
        },
      }),
    };
  };
  const click = async (): Promise<void> => {
    activate.click({ arguments: `act=junk;id=${ID}` });
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    settings = DEFAULT_SETTINGS;
  });

  it("creates the Notification a click made while the app was closed needs, before listening, and never shows it", () => {
    build("ok");
    expect(activate.registeredAfter).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.shown).toBe(false);
  });

  describe("a click on the toast's body", () => {
    const body = async (): Promise<void> => {
      activate.click({ arguments: `act=open;id=${ID}` });
      await new Promise((resolve) => setImmediate(resolve));
    };

    it("opens Recent mail, blocks nothing, and shows no toast", async () => {
      const t = make("ok");
      await body();
      expect(t.openRecent).toHaveBeenCalledTimes(1);
      expect(t.choose).not.toHaveBeenCalled();
      expect(t.quiet).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
    });

    it("leaves the toast's buttons usable after it", async () => {
      const t = make("ok");
      await body();
      await click();
      expect(t.choose).toHaveBeenCalledTimes(1);
    });

    it("opens Recent mail for a click on a notice about mail too, and for nothing else", async () => {
      const t = make("ok");
      activate.click({ arguments: "act=recent" });
      await new Promise((resolve) => setImmediate(resolve));
      activate.click({ arguments: "act=recent;id=x" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(t.openRecent).toHaveBeenCalledTimes(1);
    });

    it("logs a failure to open, and does not throw from the activation", async () => {
      const t = make("ok");
      t.openRecent.mockImplementation(() => {
        throw new Error("no window");
      });
      await body();
      expect(t.onError).toHaveBeenCalledWith("toast:open", expect.any(Error));
    });

    it("opens nothing after quit", async () => {
      const t = make("ok");
      t.toasts.closeAll();
      await body();
      expect(t.openRecent).not.toHaveBeenCalled();
    });
  });

  describe("a notice about mail", () => {
    it("is a toast whose click opens Recent mail, with no buttons", () => {
      const t = make("ok");
      t.toasts.noticeMail(
        "Senderban",
        "3 more new messages in me were not announced. Click to see them.",
      );
      const xml = created[0]?.options.toastXml ?? "";
      expect(xml).toMatch(/^<toast launch="act=recent">/u);
      expect(xml).not.toMatch(/<action /u);
      expect(created[0]?.shown).toBe(true);
    });
  });

  describe("a click from the Recent mail view", () => {
    it("takes the toast's own step and hands the outcome back instead of a notice", async () => {
      settings = { ...DEFAULT_SETTINGS, confirmBlocks: true };
      const t = make("ok");
      const result = await t.toasts.answer(ID, "address", "trash");
      expect(result).toEqual({ tone: "ok", text: "done" });
      expect(t.choose).toHaveBeenCalledWith(ID, "address", "trash", undefined);
      expect(t.held).toEqual(["start", "end"]);
      expect(created).toHaveLength(0);
    });

    it("sends Mute to the Don't ask again list", async () => {
      const t = make("ok");
      await t.toasts.answer(ID, "address", "quiet");
      expect(t.quiet).toHaveBeenCalledWith(ID, "address", undefined);
      expect(t.choose).not.toHaveBeenCalled();
    });

    it("says something went wrong when the step throws", async () => {
      const t = make("ok");
      t.choose.mockImplementation(() => Promise.reject(new Error("boom")));
      expect(await t.toasts.answer(ID, "address", "junk")).toEqual({
        tone: "error",
        text: "Something went wrong. See the log.",
      });
      expect(t.onError).toHaveBeenCalledWith("toast:choose", expect.any(Error));
    });
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

  it("hands a click on a toast of an earlier version, with no choice, the default action of that moment", async () => {
    const { choose } = make("ok");
    settings = { ...DEFAULT_SETTINGS, defaultAction: "trash" };
    activate.click({ arguments: `act=sender;id=${ID}` });
    await new Promise((resolve) => setImmediate(resolve));
    expect(choose).toHaveBeenCalledWith(ID, "address", "trash", undefined);
  });

  it("builds a toast from the settings of that moment", () => {
    const { toasts } = make("ok");
    settings = {
      ...DEFAULT_SETTINGS,
      toastDuration: "short",
      defaultAction: "trash",
      preferServerBlock: true,
    };
    toasts.show({ ...toast(1), domain: "example.com", rejectsAtServer: true });
    expect(created[0]?.options.toastXml).toContain('<toast duration="short"');
    expect(created[0]?.options.toastXml).toContain("A domain moves to Trash");
    expect(created[0]?.options.toastXml).toContain('<action content="Block"');
  });

  it("sends Mute to the Don't ask again list, never to a block", async () => {
    const { choose, quiet } = make("ok");
    activate.click({ arguments: `act=quiet;id=${ID}` });
    await new Promise((resolve) => setImmediate(resolve));
    expect(quiet).toHaveBeenCalledWith(ID, "address", undefined);
    expect(choose).not.toHaveBeenCalled();
  });

  it("runs a block and a Don't ask again click as a held step, so a restart after an add waits for both", async () => {
    const { held } = make("ok");
    await click();
    activate.click({ arguments: `act=quiet;id=${ID}` });
    await new Promise((resolve) => setImmediate(resolve));
    expect(held).toEqual(["start", "end", "start", "end"]);
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
      signer: () => Promise.resolve(null),
      choose: () => Promise.resolve({ tone: "ok", text: "" }),
      quiet: () => Promise.resolve({ tone: "ok", text: "" }),
      openRecent: () => undefined,
      onActivation: () => undefined,
      onIgnored: () => undefined,
      onRefused: () => undefined,
      onError: () => undefined,
      hold: (work) => work(),
    });
    created.length = 0;
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

describe("a click that outlives the app, through the toast", () => {
  const signer = createActivationSigner(Buffer.alloc(32, 3));
  const build = () => {
    const choose = vi.fn((...args: unknown[]) =>
      Promise.resolve({ tone: "ok" as const, text: String(args.length) }),
    );
    const onIgnored = vi.fn();
    const toasts = new Toasts({
      settings: () => DEFAULT_SETTINGS,
      spamStrips: STRIPS,
      signer: () => Promise.resolve(signer),
      choose,
      quiet: () => Promise.resolve({ tone: "ok", text: "" }),
      openRecent: () => undefined,
      onActivation: () => undefined,
      onIgnored,
      onRefused: () => undefined,
      onError: () => undefined,
      hold: (work) => work(),
    });
    return { toasts, choose, onIgnored };
  };
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  /** The `arguments` of the first button of the last toast shown. */
  const buttonArguments = (): string => {
    const xml = created.at(-1)?.options.toastXml ?? "";
    const found = /action content="Junk" arguments="([^"]*)"/u.exec(xml);
    return found?.[1] ?? "";
  };

  it("hands the sender of a signed button to the click, as the restore of an earlier run", async () => {
    const { toasts, choose } = build();
    await settle();
    toasts.show({ ...toast(1), accountId: "acct-1", issuedAt: 1_700_000_000 });
    activate.click({ arguments: buttonArguments() });
    await settle();
    expect(choose.mock.calls[0]?.[3]).toEqual({
      accountId: "acct-1",
      sender: "a@example.com",
      issuedAt: 1_700_000_000,
    });
  });

  it("refuses a button whose sender was changed after it was signed", async () => {
    const { toasts, choose, onIgnored } = build();
    await settle();
    toasts.show({ ...toast(1), accountId: "acct-1", issuedAt: 1_700_000_000 });
    activate.click({ arguments: buttonArguments().replace("from=a@", "from=b@") });
    await settle();
    expect(choose).not.toHaveBeenCalled();
    expect(onIgnored).toHaveBeenCalledWith("tail-refused");
  });
});
