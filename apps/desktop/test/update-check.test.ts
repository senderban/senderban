import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_INTERVAL_MS, UPDATE_MAX_BYTES, UPDATE_RETRY_MS, UPDATE_URL } from "@senderban/core";
import type { UpdateState } from "@senderban/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateChecker, afterCheck } from "../src/update-check.js";

let dir: string;
let statePath: string;
let written: UpdateState[];
let onNew: ReturnType<typeof vi.fn<(version: string) => void>>;
let log: ReturnType<typeof vi.fn<(event: string, fields?: unknown) => void>>;
let enabled: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senderban-update-"));
  statePath = join(dir, "update.json");
  written = [];
  onNew = vi.fn<(version: string) => void>();
  log = vi.fn<(event: string, fields?: unknown) => void>();
  enabled = true;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

function checker(fetch: (url: string, init: RequestInit) => Promise<Response>, current = "0.2.0") {
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
    now: () => 1_000_000,
  });
}

describe("UpdateChecker", () => {
  it("asks the fixed URL with GitHub's headers, and tells once about a newer version", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(json({ tag_name: "v0.3.0" }, { headers: { etag: '"a1"' } })),
    );
    const c = checker(fetch);
    await c.start();
    c.stop();
    expect(await c.check()).toBe("new");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPDATE_URL);
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ "X-GitHub-Api-Version": "2022-11-28" });
    expect(onNew).toHaveBeenCalledExactlyOnceWith("0.3.0");
    expect(c.available).toBe("0.3.0");
    expect(written.at(-1)).toMatchObject({ etag: '"a1"', latest: "0.3.0", notified: "0.3.0" });

    // The next day: the same release again is not a second notification.
    expect(await c.check()).toBe("same");
    expect(onNew).toHaveBeenCalledOnce();
    const second = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(second[1].headers).toMatchObject({ "If-None-Match": '"a1"' });
  });

  it("keeps what it knew on a 304", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        checkedAt: 5,
        etag: '"a1"',
        latest: "0.3.0",
        notified: "0.3.0",
      }),
    );
    const c = checker(() => Promise.resolve(new Response(null, { status: 304 })));
    await c.start();
    c.stop();
    expect(await c.check()).toBe("not-modified");
    expect(c.available).toBe("0.3.0");
    expect(onNew).not.toHaveBeenCalled();
    expect(written.at(-1)?.checkedAt).toBe(1_000_000);
  });

  it("says nothing when the running version is the latest", async () => {
    const c = checker(() => Promise.resolve(json({ tag_name: "v0.2.0" })));
    expect(await c.check()).toBe("same");
    expect(onNew).not.toHaveBeenCalled();
    expect(c.available).toBeNull();
  });

  it("asks nothing while switched off", async () => {
    enabled = false;
    const fetch = vi.fn();
    expect(await checker(fetch).check()).toBe("off");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a server error", () => Promise.resolve(new Response("busy", { status: 503 }))],
    ["a network failure", () => Promise.reject(new TypeError("offline"))],
    ["an answer that is not a release", () => Promise.resolve(json({ tag_name: "latest" }))],
    ["broken JSON", () => Promise.resolve(new Response("{", { status: 200 }))],
    [
      "a body past the cap",
      () => Promise.resolve(new Response("x".repeat(UPDATE_MAX_BYTES + 1), { status: 200 })),
    ],
    [
      "a Content-Length past the cap",
      () =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(UPDATE_MAX_BYTES + 1) },
          }),
        ),
    ],
  ])("fails on %s, writes nothing and logs no body", async (_name, fetch) => {
    const c = checker(fetch);
    expect(await c.check()).toBe("failed");
    expect(written).toEqual([]);
    expect(onNew).not.toHaveBeenCalled();
    const fields = log.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["ms", "outcome", "status"]);
  });

  it("starts empty from a state file it cannot use", async () => {
    writeFileSync(
      statePath,
      '{"version":1,"checkedAt":0,"etag":null,"latest":"<x>","notified":null}',
    );
    const c = checker(() => Promise.resolve(json({ tag_name: "v0.2.0" })));
    await c.start();
    c.stop();
    expect(c.available).toBeNull();
  });
});

describe("afterCheck", () => {
  it("waits hours after a failure and a day while off, never the first delay", () => {
    expect(afterCheck("failed", 0, UPDATE_INTERVAL_MS * 3)).toBe(UPDATE_RETRY_MS);
    expect(afterCheck("off", 0, UPDATE_INTERVAL_MS * 3)).toBe(UPDATE_INTERVAL_MS);
    expect(afterCheck("same", 1000, 1000)).toBe(UPDATE_INTERVAL_MS);
  });
});
