import type { ImapFlow } from "imapflow";
import { describe, expect, it, vi } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import { cleanMailboxOf } from "../../src/imap-clean/imapflow-mailbox.js";
import { CLEAN_UIDS_PER_COMMAND, FOLDER_PATH, UID_MAX } from "../../src/imap-clean/session.js";
import { UnreadableMailError } from "../../src/watcher/watcher.js";

type Stub = Record<string, unknown>;

const stubClient = (over: Stub = {}): ImapFlow =>
  ({
    mailbox: { uidNext: 11, readOnly: false },
    capabilities: new Map([["MOVE", true]]),
    enabled: new Set<string>(),
    usable: true,
    ...over,
  }) as unknown as ImapFlow;

const hooks = () => ({ reading: { old: false, oversized: false } });

async function* rows(items: readonly Stub[]) {
  await Promise.resolve();
  yield* items;
}

describe("canMove", () => {
  it.each([
    [{ capabilities: new Map([["MOVE", true]]) }, true],
    [{ capabilities: new Map([["IMAP4rev2", true]]) }, true],
    // Listed beside rev1 and never enabled: rev1 rules apply, and the library would send a plain EXPUNGE.
    [
      {
        capabilities: new Map([
          ["IMAP4rev1", true],
          ["IMAP4rev2", true],
        ]),
      },
      false,
    ],
    [
      {
        capabilities: new Map([
          ["IMAP4rev1", true],
          ["IMAP4rev2", true],
        ]),
        enabled: new Set(["IMAP4REV2"]),
      },
      true,
    ],
    [{ capabilities: new Map([["UIDPLUS", true]]) }, true],
    // COPY + plain EXPUNGE would also delete whatever else the person marked \Deleted.
    [{ capabilities: new Map() }, false],
    [{ mailbox: { uidNext: 1, readOnly: true } }, false],
    [{ mailbox: false }, false],
  ])("%j -> %s", (over, want) => {
    expect(cleanMailboxOf(stubClient(over), hooks()).canMove()).toBe(want);
  });
});

describe("topUid", () => {
  it("is the UID before UIDNEXT, and 0 with nothing open", () => {
    expect(cleanMailboxOf(stubClient(), hooks()).topUid()).toBe(10);
    expect(cleanMailboxOf(stubClient({ mailbox: false }), hooks()).topUid()).toBe(0);
    const empty = stubClient({ mailbox: { uidNext: 1, readOnly: false } });
    expect(cleanMailboxOf(empty, hooks()).topUid()).toBe(0);
  });
});

describe("uidValidity", () => {
  it("is the mailbox's own, as text", () => {
    const client = stubClient({ mailbox: { uidNext: 1, readOnly: false, uidValidity: 7n } });
    expect(cleanMailboxOf(client, hooks()).uidValidity()).toBe("7");
  });
});

describe("search", () => {
  it("asks by UID, within the range, and keeps each address one value", async () => {
    const search = vi.fn(() => Promise.resolve([3, 4]));
    const box = cleanMailboxOf(stubClient({ search }), hooks());
    expect(await box.searchFrom("1:9", ["a@x.example"])).toEqual([3, 4]);
    await box.searchFrom("1:9", ["a@x.example", "b@y.example"]);
    expect(search.mock.calls).toEqual([
      [{ uid: "1:9", from: "a@x.example" }, { uid: true }],
      [{ uid: "1:9", or: [{ from: "a@x.example" }, { from: "b@y.example" }] }, { uid: true }],
    ]);
  });

  it("passes the date through", async () => {
    const search = vi.fn(() => Promise.resolve([]));
    const since = new Date("2026-10-01T00:00:00.000Z");
    await cleanMailboxOf(stubClient({ search }), hooks()).uidsSince("1:9", since);
    expect(search).toHaveBeenCalledWith({ uid: "1:9", since }, { uid: true });
  });

  it.each([
    ["a refusal", false],
    ["a UID of zero", [0]],
    ["a UID past 32 bits", [UID_MAX + 1]],
    ["a fraction", [1.5]],
    ["more than was asked for", new Array(50_001).fill(1)],
  ])("treats %s as a failed step, not as an answer", async (_, answer) => {
    const search = vi.fn(() => Promise.resolve(answer));
    const box = cleanMailboxOf(stubClient({ search }), hooks());
    await expect(box.searchFrom("1:9", ["a@x.example"])).rejects.toMatchObject({
      code: "TRANSIENT",
    });
  });
});

describe("readFrom", () => {
  it("reads envelopes by UID and drops a sender that is no address", async () => {
    const fetch = vi.fn(() =>
      rows([
        { uid: 2, envelope: { from: [{ address: "A@Blocked.Example" }] } },
        { uid: 3, envelope: { from: [{ address: "not an address" }] } },
        { uid: 4, envelope: {} },
      ]),
    );
    const box = cleanMailboxOf(stubClient({ fetch }), hooks());
    expect(await box.readFrom([4, 2, 3])).toEqual([{ uid: 2, from: "a@blocked.example" }]);
    expect(fetch).toHaveBeenCalledWith("2,3,4", { uid: true, envelope: true }, { uid: true });
  });

  it("refuses more than one command should carry", async () => {
    const box = cleanMailboxOf(stubClient(), hooks());
    const uids = Array.from({ length: CLEAN_UIDS_PER_COMMAND + 1 }, (_, i) => i + 1);
    await expect(box.readFrom(uids)).rejects.toThrow(RangeError);
  });

  it("marks the read, so a size limit is about old mail and not about the watcher's", async () => {
    const shared = hooks();
    const seen: boolean[] = [];
    const fetch = vi.fn(async function* () {
      seen.push(shared.reading.old);
      await Promise.resolve();
      yield { uid: 1, envelope: { from: [{ address: "a@x.example" }] } };
    });
    await cleanMailboxOf(stubClient({ fetch }), shared).readFrom([1]);
    expect(seen).toEqual([true]);
    expect(shared.reading.old).toBe(false);
  });

  it("keeps to what was asked for, whatever else the server sends", async () => {
    const fetch = vi.fn(() =>
      rows([
        { uid: 7, envelope: { from: [{ address: "a@x.example" }] } },
        { uid: 99, envelope: { from: [{ address: "b@x.example" }] } },
      ]),
    );
    const box = cleanMailboxOf(stubClient({ fetch }), hooks());
    expect(await box.readFrom([7])).toEqual([{ uid: 7, from: "a@x.example" }]);
  });

  it("stops reading a server that streams without end", async () => {
    let served = 0;
    const fetch = vi.fn(async function* () {
      await Promise.resolve();
      for (;;) {
        served += 1;
        yield { uid: 1, envelope: { from: [{ address: "a@x.example" }] } };
      }
    });
    await cleanMailboxOf(stubClient({ fetch }), hooks()).readFrom([1]);
    expect(served).toBe(5);
  });

  it("does not read silence as no match", async () => {
    const fetch = vi.fn(() => rows([]));
    const box = cleanMailboxOf(stubClient({ fetch }), hooks());
    await expect(box.readFrom([1])).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("reads a failed fetch on a live connection as a refusal", async () => {
    const fetch = vi.fn(async function* () {
      await Promise.resolve();
      yield* [];
      throw new Error("NO");
    });
    const box = cleanMailboxOf(stubClient({ fetch }), hooks());
    await expect(box.readFrom([1])).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("names a limit the stream only saw as the connection closing", async () => {
    const shared = hooks();
    const fetch = vi.fn(async function* () {
      await Promise.resolve();
      yield* [];
      // imapflow's order: the stream fails first, the limit reaches the 'error' event after it.
      setImmediate(() => {
        shared.reading.oversized = true;
      });
      throw Object.assign(new Error("closed"), { code: "NoConnection" });
    });
    const box = cleanMailboxOf(stubClient({ fetch, usable: false }), shared);
    await expect(box.readFrom([1])).rejects.toBeInstanceOf(UnreadableMailError);
  });

  it("names an answer past a limit, and ends the mark", async () => {
    const shared = hooks();
    const fetch = vi.fn(async function* () {
      await Promise.resolve();
      yield* [];
      throw Object.assign(new Error("too long"), { code: "LineTooLarge" });
    });
    const box = cleanMailboxOf(stubClient({ fetch }), shared);
    await expect(box.readFrom([1])).rejects.toBeInstanceOf(UnreadableMailError);
    expect(shared.reading.old).toBe(false);
  });
});

describe("folders", () => {
  const row = (path: string, specialUse?: string, flags: string[] = []) => ({
    path,
    specialUse,
    flags: new Set(flags),
  });

  it("finds the roles the server or the name gives", async () => {
    const list = vi.fn(() =>
      Promise.resolve([
        row("INBOX", "\\Inbox"),
        row("Bulk Mail", "\\Junk"),
        row("Deleted Messages", "\\Trash"),
      ]),
    );
    const box = cleanMailboxOf(stubClient({ list }), hooks());
    expect(await box.folders()).toEqual({ junk: "Bulk Mail", trash: "Deleted Messages" });
    expect(list).toHaveBeenCalledWith({ listOnly: true });
  });

  it.each([
    ["no such folder", []],
    ["a folder that cannot be selected", [row("Junk", "\\Junk", ["\\Noselect"])]],
    ["the Inbox under another role", [row("inbox", "\\Junk")]],
    ["a control character in the name", [row("Ju\r\nnk", "\\Junk")]],
    ["a name past the bound", [row("J".repeat(FOLDER_PATH.max + 1), "\\Junk")]],
  ])("takes no Junk folder from %s", async (_, answer) => {
    const list = vi.fn(() => Promise.resolve(answer));
    const box = cleanMailboxOf(stubClient({ list }), hooks());
    expect((await box.folders()).junk).toBeNull();
  });
});

describe("a server that says no", () => {
  it("is a refusal when the connection is still up, for every kind of step", async () => {
    const no = () => Promise.reject(new Error("NO"));
    const box = cleanMailboxOf(stubClient({ mailboxCreate: no, list: no }), hooks());
    await expect(box.createFolder("Junk")).rejects.toMatchObject({ code: "REJECTED" });
    await expect(box.folders()).rejects.toMatchObject({ code: "REJECTED" });
  });

  it.each(["LIMIT", "UNAVAILABLE", "INUSE", "limit"])(
    "is only for now when the server answers %s",
    async (code) => {
      const mailboxCreate = () =>
        Promise.reject(Object.assign(new Error("NO"), { serverResponseCode: code }));
      const box = cleanMailboxOf(stubClient({ mailboxCreate }), hooks());
      await expect(box.createFolder("Junk")).rejects.toMatchObject({ code: "TRANSIENT" });
    },
  );

  it("is the connection going when it is not, so the queue simply waits", async () => {
    const gone = new Error("socket closed");
    const mailboxCreate = () => Promise.reject(gone);
    const box = cleanMailboxOf(stubClient({ mailboxCreate, usable: false }), hooks());
    await expect(box.createFolder("Junk")).rejects.toBe(gone);
  });

  it("reads no selected mailbox as a failed move, never as done", async () => {
    const messageMove = vi.fn(() => Promise.resolve(undefined));
    const box = cleanMailboxOf(stubClient({ messageMove }), hooks());
    await expect(box.move([1], "Junk")).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("move", () => {
  it("moves by UID, sorted, to the folder", async () => {
    const messageMove = vi.fn(() => Promise.resolve({ path: "INBOX", destination: "Junk" }));
    await cleanMailboxOf(stubClient({ messageMove }), hooks()).move([9, 2], "Junk");
    expect(messageMove).toHaveBeenCalledWith("2,9", "Junk", { uid: true });
  });

  it("tells a refusal from a lost connection", async () => {
    const messageMove = vi.fn(() => Promise.resolve(false));
    const refused = cleanMailboxOf(stubClient({ messageMove }), hooks());
    await expect(refused.move([1], "Junk")).rejects.toBeInstanceOf(AdapterError);
    const lost = cleanMailboxOf(stubClient({ messageMove, usable: false }), hooks());
    const error: unknown = await lost.move([1], "Junk").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AdapterError);
  });

  it("refuses more than one command should carry", async () => {
    const box = cleanMailboxOf(stubClient(), hooks());
    const uids = Array.from({ length: CLEAN_UIDS_PER_COMMAND + 1 }, (_, i) => i + 1);
    await expect(box.move(uids, "Junk")).rejects.toThrow(RangeError);
  });
});
