import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_QUIET_HOURS,
  IMAP_HEARTBEAT_MS,
  NUDGES_MAX,
  NUDGE_EVERY_MS,
  POLL_NUDGE_EVERY_MS,
  createWatchHealth,
  looksOffline,
} from "../src/watch-health.js";

describe("looksOffline", () => {
  it.each([
    "getaddrinfo ENOTFOUND mail.example.net",
    "getaddrinfo ENOENT mail.example.net",
    "getaddrinfo EAI_AGAIN mail.example.net",
    "connect ETIMEDOUT 192.0.2.1:993",
    "connect ENETUNREACH 192.0.2.1:993",
    "Failed to establish connection in required time",
    "login did not finish within 60000 ms",
  ])("%s", (detail) => {
    expect(looksOffline(detail)).toBe(true);
  });

  it.each([
    "connection closed",
    "read ECONNRESET",
    "connect ECONNREFUSED 192.0.2.1:993",
    "authentication failed",
    "server keeps refusing the login as temporarily unavailable",
    "",
  ])("not: %s", (detail) => {
    expect(looksOffline(detail)).toBe(false);
  });
});

function setup() {
  const nudges = { a: vi.fn(() => true), b: vi.fn(() => true), c: vi.fn(() => true) };
  const watchers = new Map(Object.entries(nudges).map(([id, nudge]) => [id, { nudge }]));
  const polls = vi.fn(() => 1);
  const log = vi.fn<(event: string, fields?: object) => void>();
  const health = createWatchHealth({
    watchers,
    polls: () => [{ nudge: polls }],
    // a and b share a server, c is elsewhere.
    hostOf: (id) => (id === "c" ? "other.example" : "mail.example"),
    tagOf: (id) => `tag-${id}`,
    log,
  });
  return { ...nudges, watchers, polls, log, health };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the network is back", () => {
  it("nudges the other account of the same server whose connection broke, and not itself", () => {
    const t = setup();
    t.health.imapState("a", "backoff", "read ECONNRESET");
    t.health.imapState("b", "backoff", "read ECONNRESET");
    t.health.imapState("a", "connecting");
    t.health.imapState("a", "watching");
    expect(t.b).toHaveBeenCalledTimes(1);
    expect(t.a).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith("network-back", { nudged: 1, polls: 1 });
  });

  it("nudges an account elsewhere only when it had no network", () => {
    const t = setup();
    t.health.imapState("a", "backoff", "read ECONNRESET");
    t.health.imapState("c", "backoff", "read ECONNRESET");
    t.health.imapState("a", "watching");
    expect(t.c).not.toHaveBeenCalled();
    t.health.imapState("c", "backoff", "getaddrinfo ENOTFOUND other.example");
    t.health.imapState("a", "backoff", "connection closed");
    t.health.imapState("a", "watching");
    expect(t.c).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a first start, an un-pause, or an account that halted", () => {
    const t = setup();
    t.health.imapState("b", "backoff", "getaddrinfo ENOTFOUND mail.example");
    t.health.imapState("a", "connecting");
    t.health.imapState("a", "watching");
    expect(t.b).not.toHaveBeenCalled();
    t.health.imapState("a", "backoff", "x");
    t.health.imapState("b", "halted", "authentication failed");
    t.health.imapState("a", "watching");
    expect(t.b).not.toHaveBeenCalled();
  });

  it("a flapping account cannot make another one sign in faster than the limit, nor for ever", () => {
    const t = setup();
    t.health.imapState("b", "backoff", "read ECONNRESET");
    const at: number[] = [];
    const began = Date.now();
    t.b.mockImplementation(() => {
      at.push(Date.now() - began);
      return true;
    });
    for (let s = 0; s < 3_600; s += 1) {
      t.health.imapState("a", "backoff", "connection closed");
      t.health.imapState("a", "watching");
      // Every try of b fails again.
      t.health.imapState("b", "connecting");
      t.health.imapState("b", "backoff", "read ECONNRESET");
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect(at).toEqual([0, NUDGE_EVERY_MS, 2 * NUDGE_EVERY_MS]);
    expect(at).toHaveLength(NUDGES_MAX);
    expect(t.polls).toHaveBeenCalledTimes(3_600_000 / POLL_NUDGE_EVERY_MS);
    // Back and away again: a new absence.
    t.health.imapState("b", "watching");
    t.health.imapState("b", "backoff", "read ECONNRESET");
    t.health.imapState("a", "backoff", "connection closed");
    t.health.imapState("a", "watching");
    expect(at).toHaveLength(NUDGES_MAX + 1);
  });

  it("leaves a server that answered no to its own wait, on the same host and elsewhere", () => {
    const t = setup();
    t.health.imapState("b", "backoff", "Command failed", true);
    t.health.imapState("c", "backoff", "login did not finish within 60000 ms", true);
    t.health.imapState("a", "backoff", "connection closed");
    t.health.imapState("a", "watching");
    expect(t.b).not.toHaveBeenCalled();
    expect(t.c).not.toHaveBeenCalled();
    // The same account with a broken connection later is nudged.
    t.health.imapState("b", "backoff", "connection closed", false);
    t.health.imapState("a", "backoff", "connection closed");
    t.health.imapState("a", "watching");
    expect(t.b).toHaveBeenCalledTimes(1);
  });

  it("a poll that works again nudges the IMAP accounts that had no network", () => {
    const t = setup();
    t.health.imapState("a", "backoff", "getaddrinfo ENOTFOUND mail.example");
    t.health.imapState("c", "backoff", "read ECONNRESET");
    t.health.pollState("g", "watching");
    expect(t.a).not.toHaveBeenCalled();
    t.health.pollState("g", "backoff");
    t.health.pollState("g", "watching");
    expect(t.a).toHaveBeenCalledTimes(1);
    expect(t.c).not.toHaveBeenCalled();
    t.health.pollState("g", "backoff");
    t.health.pollState("g", "stopped");
    t.health.pollState("g", "watching");
    expect(t.a).toHaveBeenCalledTimes(1);
  });
});

describe("the heartbeat", () => {
  it("writes one line an hour per account with what happened, and drops a removed one", async () => {
    const t = setup();
    t.health.start();
    t.health.imapState("a", "connecting");
    t.health.imapState("a", "watching");
    t.health.announced("a");
    t.health.imapState("a", "backoff", "connection closed");
    t.health.imapState("a", "connecting");
    t.health.imapState("a", "backoff", "connection closed");
    t.health.imapState("a", "watching");
    t.health.imapState("b", "halted", "authentication failed");
    t.health.imapState("c", "watching");
    t.watchers.delete("c");
    await vi.advanceTimersByTimeAsync(IMAP_HEARTBEAT_MS);
    const beats = t.log.mock.calls.filter((c) => c[0] === "imap-heartbeat").map((c) => c[1]);
    expect(beats).toEqual([
      { account: "tag-a", state: "watching", upS: 3600, drops: 1, found: 1 },
      { account: "tag-b", state: "halted", upS: null, drops: 0, found: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(IMAP_HEARTBEAT_MS);
    expect(t.log).toHaveBeenLastCalledWith("imap-heartbeat", {
      account: "tag-b",
      state: "halted",
      upS: null,
      drops: 0,
      found: 0,
    });
    t.health.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is quiet about an account that only watched, but not for ever", async () => {
    const t = setup();
    t.health.start();
    t.health.imapState("a", "watching");
    const lines = () => t.log.mock.calls.filter((c) => c[0] === "imap-heartbeat").length;
    await vi.advanceTimersByTimeAsync(IMAP_HEARTBEAT_MS * (HEARTBEAT_QUIET_HOURS - 1));
    expect(lines()).toBe(0);
    await vi.advanceTimersByTimeAsync(IMAP_HEARTBEAT_MS);
    expect(lines()).toBe(1);
    t.health.announced("a");
    await vi.advanceTimersByTimeAsync(IMAP_HEARTBEAT_MS);
    expect(lines()).toBe(2);
    t.health.stop();
  });
});
