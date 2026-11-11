import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_FIRST_DELAY_MS,
  UPDATE_INTERVAL_MS,
  UPDATE_MAX_BYTES,
  UPDATE_RETRY_MS,
  UPDATE_TIMEOUT_MS,
  UPDATE_URL,
} from "@senderban/core";
import type { UpdateState } from "@senderban/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateChecker } from "../src/update-check.js";

const NOW = 1_000_000_000;

let dir: string;
let statePath: string;
let written: UpdateState[];
let onNew: ReturnType<typeof vi.fn<(version: string) => void>>;
let log: ReturnType<typeof vi.fn<(event: string, fields?: unknown) => void>>;
let enabled: boolean;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senderban-update-"));
  statePath = join(dir, "update.json");
  written = [];
  onNew = vi.fn<(version: string) => void>();
  log = vi.fn<(event: string, fields?: unknown) => void>();
  enabled = true;
  clock = NOW;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function checker(fetch: Fetch, current = "0.2.0", random = () => 0) {
  return new UpdateChecker({
    statePath,
    current,
    fetch,
    writeState: (_path, value) => {
      written.push(value);
      return Promise.resolve();
    },
    enabled: () => enabled,
    onNew,
    log,
    now: () => clock,
    random,
  });
}

function saveState(state: Partial<UpdateState>) {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      nextAt: 0,
      etag: null,
      latest: null,
      notified: null,
      ...state,
    }),
  );
}

const lastLog = () => log.mock.calls.filter((c) => c[0] === "update-check").at(-1)?.[1];

describe("UpdateChecker.check", () => {
  it("asks the fixed URL with GitHub's headers, and tells once about a newer version", async () => {
    const fetch = vi.fn<Fetch>(() =>
      Promise.resolve(json({ tag_name: "v0.3.0" }, { headers: { etag: '"a1"' } })),
    );
    const c = checker(fetch);
    expect(await c.check()).toBe("new");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(UPDATE_URL);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ "X-GitHub-Api-Version": "2022-11-28" });
    expect(onNew).toHaveBeenCalledExactlyOnceWith("0.3.0");
    expect(c.available).toBe("0.3.0");
    expect(written.at(-1)).toMatchObject({
      etag: '"a1"',
      latest: "0.3.0",
      notified: "0.3.0",
      nextAt: NOW + UPDATE_INTERVAL_MS,
    });

    // The next day: the same release again is not a second notification.
    expect(await c.check()).toBe("same");
    expect(onNew).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1]?.[1].headers).toMatchObject({ "If-None-Match": '"a1"' });
  });

  it("keeps what it knew on a 304", async () => {
    saveState({ etag: '"a1"', latest: "0.3.0", notified: "0.3.0" });
    const c = checker(() => Promise.resolve(new Response(null, { status: 304 })));
    await c.start();
    c.stop();
    expect(await c.check()).toBe("not-modified");
    expect(c.available).toBe("0.3.0");
    expect(onNew).not.toHaveBeenCalled();
    expect(written.at(-1)?.nextAt).toBe(NOW + UPDATE_INTERVAL_MS);
  });

  it("says nothing when the running version is the latest", async () => {
    const c = checker(() => Promise.resolve(json({ tag_name: "v0.2.0" })));
    expect(await c.check()).toBe("same");
    expect(onNew).not.toHaveBeenCalled();
    expect(c.available).toBeNull();
  });

  it("asks nothing while switched off, and shows no update then", async () => {
    const fetch = vi.fn<Fetch>(() => Promise.resolve(json({ tag_name: "v0.3.0" })));
    const c = checker(fetch);
    await c.check();
    enabled = false;
    expect(c.available).toBeNull();
    expect(await c.check()).toBe("off");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the outcome when the notification itself fails", async () => {
    onNew.mockImplementation(() => {
      throw new Error("toast");
    });
    const c = checker(() => Promise.resolve(json({ tag_name: "v0.3.0" })));
    expect(await c.check()).toBe("new");
    expect(c.available).toBe("0.3.0");
  });

  it.each([
    ["a server error", "server", () => Promise.resolve(new Response("busy", { status: 503 }))],
    ["a network failure", "network", () => Promise.reject(new TypeError("offline"))],
  ] as const)(
    "on %s waits the 6 h retry, stored so a restart waits too",
    async (_name, reason, fetch) => {
      const c = checker(fetch);
      expect(await c.check()).toBe("failed");
      expect(written.at(-1)).toMatchObject({ nextAt: NOW + UPDATE_RETRY_MS, latest: null });
      expect(onNew).not.toHaveBeenCalled();
      expect(lastLog()).toMatchObject({ outcome: "failed", reason, ms: 0 });
    },
  );

  it.each([
    ["a missing repository", "status", () => Promise.resolve(new Response("", { status: 404 }))],
    [
      "an answer that is not a release",
      "parse",
      () => Promise.resolve(json({ tag_name: "latest" })),
    ],
    ["broken JSON", "parse", () => Promise.resolve(new Response("{", { status: 200 }))],
    [
      "a body past the cap",
      "size",
      () => Promise.resolve(new Response("x".repeat(UPDATE_MAX_BYTES + 1), { status: 200 })),
    ],
    [
      "a Content-Length past the cap",
      "size",
      () =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(UPDATE_MAX_BYTES + 1) },
          }),
        ),
    ],
  ] as const)("refuses %s for a day, and logs no body", async (_name, reason, fetch) => {
    const c = checker(fetch);
    expect(await c.check()).toBe("refused");
    expect(written.at(-1)).toMatchObject({ nextAt: NOW + UPDATE_INTERVAL_MS, latest: null });
    const fields = lastLog() as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["ms", "outcome", "reason", "status"]);
    expect(fields.reason).toBe(reason);
  });

  it("honours GitHub's rate-limit reset, within 6 h to a day", async () => {
    const reset = (NOW + 9 * 60 * 60 * 1000) / 1000;
    const c = checker(() =>
      Promise.resolve(
        new Response("", { status: 403, headers: { "x-ratelimit-reset": String(reset) } }),
      ),
    );
    expect(await c.check()).toBe("failed");
    expect(written.at(-1)?.nextAt).toBe(NOW + 9 * 60 * 60 * 1000);

    const far = checker(() =>
      Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "999999" } })),
    );
    await far.check();
    expect(written.at(-1)?.nextAt).toBe(NOW + UPDATE_INTERVAL_MS);
  });

  it("gives up on a body that drips past the deadline", async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"tag_'));
      },
    });
    const c = checker(() => Promise.resolve(new Response(stalled, { status: 200 })));
    const result = c.check();
    await vi.advanceTimersByTimeAsync(UPDATE_TIMEOUT_MS + 1);
    expect(await result).toBe("failed");
    expect(lastLog()).toMatchObject({ reason: "timeout" });
  });

  it("starts empty from a state file it cannot use", async () => {
    saveState({ latest: "<x>" });
    const c = checker(() => Promise.resolve(json({ tag_name: "v0.2.0" })));
    await c.start();
    c.stop();
    expect(c.available).toBeNull();
  });
});

describe("UpdateChecker timer", () => {
  it("runs one timer: first check after the first delay, then a day later, and nothing after stop", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<Fetch>(() => Promise.resolve(json({ tag_name: "v0.2.0" })));
    const c = checker(fetch);
    await c.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    clock += UPDATE_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    c.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("makes no request on a restart while the stored retry time is ahead", async () => {
    vi.useFakeTimers();
    saveState({ nextAt: NOW + UPDATE_RETRY_MS });
    const fetch = vi.fn<Fetch>(() => Promise.reject(new TypeError("offline")));
    const c = checker(fetch);
    await c.start();
    await vi.advanceTimersByTimeAsync(UPDATE_RETRY_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
    c.stop();
  });

  it("stretches waits by up to 25 %, so installs that start together spread out", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<Fetch>(() => Promise.resolve(json({ tag_name: "v0.2.0" })));
    const c = checker(fetch, "0.2.0", () => 1);
    await c.start();
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS / 4);
    expect(fetch).toHaveBeenCalledOnce();
    expect(written.at(-1)?.nextAt).toBe(NOW + UPDATE_INTERVAL_MS * 1.25);
    c.stop();
  });

  it("asks soon after the switch is turned back on, not at the next daily tick", async () => {
    vi.useFakeTimers();
    enabled = false;
    const fetch = vi.fn<Fetch>(() => Promise.resolve(json({ tag_name: "v0.2.0" })));
    const c = checker(fetch);
    await c.start();
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS);
    expect(fetch).not.toHaveBeenCalled();
    enabled = true;
    c.nudge();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS);
    expect(fetch).toHaveBeenCalledOnce();
    c.stop();
  });
});
