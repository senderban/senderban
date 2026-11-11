import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@senderban/core";
import type { Settings } from "@senderban/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// accounts-file reaches for safeStorage at import; nothing here encrypts.
vi.mock("electron", () => ({ safeStorage: {} }));

const { SettingsStore } = await import("../src/settings-file.js");

const CHOSEN: Settings = {
  defaultAction: "trash",
  preferServerBlock: true,
  confirmBlocks: true,
  toastDuration: "short",
  checkUpdates: false,
};

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senderban-settings-"));
  path = join(dir, "settings.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("starts on the defaults with no file, and says nothing about it", async () => {
    const store = new SettingsStore(path);
    const unreadable = vi.fn();
    await store.load(unreadable);
    expect(store.current).toEqual(DEFAULT_SETTINGS);
    expect(unreadable).not.toHaveBeenCalled();
  });

  it("keeps the confirmation off and the toast long until the person changes them", () => {
    expect(DEFAULT_SETTINGS.confirmBlocks).toBe(false);
    expect(DEFAULT_SETTINGS.toastDuration).toBe("long");
    expect(DEFAULT_SETTINGS.preferServerBlock).toBe(false);
    expect(DEFAULT_SETTINGS.defaultAction).toBe("junk");
  });

  it("keeps a saved choice across a restart", async () => {
    await new SettingsStore(path).save(CHOSEN);
    const next = new SettingsStore(path);
    await next.load(() => undefined);
    expect(next.current).toEqual(CHOSEN);
  });

  it("reads a 0.2 file, which has no update switch, with the check on and the rest kept", async () => {
    writeFileSync(
      path,
      '{"version":1,"settings":{"defaultAction":"trash","preferServerBlock":true,"confirmBlocks":true,"toastDuration":"short"}}',
    );
    const store = new SettingsStore(path);
    const unreadable = vi.fn();
    await store.load(unreadable);
    expect(store.current).toEqual({ ...CHOSEN, checkUpdates: true });
    expect(unreadable).not.toHaveBeenCalled();
  });

  it.each([
    ["broken JSON", "{ not json", "unreadable"],
    ["a value out of the list", '{"version":1,"settings":{"defaultAction":"reject"}}', "invalid"],
    ["a key that is not ours", '{"version":1,"settings":{},"x":1}', "invalid"],
    ["a later version", '{"version":2,"settings":{}}', "invalid"],
    ["a file larger than any valid one", " ".repeat(5_000), "too-large"],
  ])("falls back to the defaults on %s, with a fixed reason", async (_name, text, reason) => {
    writeFileSync(path, text);
    const store = new SettingsStore(path);
    const unreadable = vi.fn();
    await store.load(unreadable);
    expect(store.current).toEqual(DEFAULT_SETTINGS);
    expect(unreadable).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it("keeps the old values when the write fails", async () => {
    const store = new SettingsStore(join(dir, "no-such-folder", "settings.json"));
    await expect(store.save(CHOSEN)).rejects.toThrow();
    expect(store.current).toEqual(DEFAULT_SETTINGS);
  });

  it("lands two quick saves in order, and a failed one does not stop the next", async () => {
    const store = new SettingsStore(path);
    await Promise.all([store.save({ ...CHOSEN, toastDuration: "long" }), store.save(CHOSEN)]);
    expect(store.current).toEqual(CHOSEN);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { settings: Settings };
    expect(onDisk.settings).toEqual(CHOSEN);
  });
});
