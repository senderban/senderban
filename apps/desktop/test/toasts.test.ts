import { beforeEach, describe, expect, it, vi } from "vitest";

const created: FakeNotification[] = [];

// Just enough of Electron's Notification: it records what was created and closed.
vi.mock("electron", () => {
  class FakeNotification {
    static handleActivation = (): void => undefined;
    closed = false;
    constructor() {
      created.push(this);
    }
    on = (): void => undefined;
    show = (): void => undefined;
    close = (): void => {
      this.closed = true;
    };
  }
  return { Notification: FakeNotification };
});

interface FakeNotification {
  closed: boolean;
}

const { Toasts } = await import("../src/toasts.js");

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

describe("Toasts tracking", () => {
  it("keeps at most 50 live toasts, dropping the oldest", () => {
    const toasts = new Toasts({
      choose: () => Promise.resolve({ tone: "ok", text: "" }),
      onActivation: () => undefined,
      onIgnored: () => undefined,
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
