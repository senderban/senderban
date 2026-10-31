import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUIET_MAX } from "@senderban/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuietStore } from "../src/quiet-file.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senderban-quiet-"));
  path = join(dir, "quiet.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("QuietStore", () => {
  it("starts empty with no file, and says nothing", async () => {
    const onUnreadable = vi.fn();
    const store = new QuietStore(path);
    await store.load(onUnreadable);
    expect(store.entries.size).toBe(0);
    expect(onUnreadable).not.toHaveBeenCalled();
  });

  it("keeps an added entry across a restart, and takes one off", async () => {
    const first = new QuietStore(path);
    expect(await first.add("deals.example")).toBe(true);
    expect(await first.add("news@other.example")).toBe(true);
    await first.remove("deals.example");
    const second = new QuietStore(path);
    await second.load(() => undefined);
    expect([...second.entries]).toEqual(["news@other.example"]);
  });

  it("writes nothing for a value it already holds or does not hold", async () => {
    const store = new QuietStore(path);
    await store.add("deals.example");
    rmSync(path);
    await store.add("deals.example");
    await store.remove("other.example");
    expect(existsSync(path)).toBe(false);
  });

  it("loses neither of two quick clicks", async () => {
    const store = new QuietStore(path);
    await Promise.all([store.add("a.example"), store.add("b.example")]);
    expect(store.entries.size).toBe(2);
    expect((JSON.parse(readFileSync(path, "utf8")) as { entries: string[] }).entries).toHaveLength(
      2,
    );
  });

  it("sets aside a file too large to be ours, without reading it", async () => {
    writeFileSync(path, " ".repeat(QUIET_MAX * 300));
    const onUnreadable = vi.fn();
    await new QuietStore(path).load(onUnreadable);
    expect(onUnreadable).toHaveBeenCalledWith("too-large");
    expect(existsSync(`${path}.unreadable`)).toBe(true);
  });

  it("refuses an entry past the cap", async () => {
    const entries = Array.from({ length: QUIET_MAX }, (_, n) => `a${String(n)}.example`);
    writeFileSync(path, JSON.stringify({ version: 1, entries }));
    const store = new QuietStore(path);
    await store.load(() => undefined);
    expect(await store.add("one-more.example")).toBe(false);
    expect(store.entries.has("one-more.example")).toBe(false);
  });

  it.each([
    ["invalid", JSON.stringify({ version: 1, entries: ["Not Valid"] })],
    ["unreadable", "{"],
  ])(
    "sets a file it cannot use aside (%s), so a click does not write over it",
    async (reason, text) => {
      writeFileSync(path, text);
      const onUnreadable = vi.fn();
      const store = new QuietStore(path);
      await store.load(onUnreadable);
      expect(onUnreadable).toHaveBeenCalledWith(reason);
      expect(store.entries.size).toBe(0);
      expect(readFileSync(`${path}.unreadable`, "utf8")).toBe(text);
    },
  );
});
