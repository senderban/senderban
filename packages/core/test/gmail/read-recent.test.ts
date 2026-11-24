import { describe, expect, it } from "vitest";
import { GmailBudgets } from "../../src/gmail/budget.js";
import type { GmailRecentReader } from "../../src/gmail/budget.js";
import { createGmailMailClient } from "../../src/gmail/mail-client.js";
import type { MessageMetadata } from "../../src/gmail/mail-client.js";
import { GMAIL_RECENT_CONCURRENCY, readGmailRecent } from "../../src/recent.js";
import type { RecentMail } from "../../src/recent.js";
import { RECENT_MAX } from "../../src/watcher/watcher.js";
import { FakeGmail, MAIL_UNITS } from "./fake-gmail.js";

function wired() {
  const fake = new FakeGmail();
  const reader = new GmailBudgets().wrapRecent(
    createGmailMailClient({ getAccessToken: () => Promise.resolve(fake.token), fetch: fake.fetch }),
    { key: "k", account: "acct-k" },
  );
  return { fake, reader };
}

describe("readGmailRecent", () => {
  it("reads sender, subject and time of the newest Inbox mail, newest first", async () => {
    const { fake, reader } = wired();
    const a = fake.deliver({ from: "Shop <News@Shop.Example>", subject: "sale‮!" });
    const b = fake.deliver({ from: ["x@one.example", "y@two.example"], subject: "two froms" });
    const rows = await readGmailRecent(reader, new Map(), RECENT_MAX);
    expect(rows).toEqual([
      { id: b, from: null, subject: "two froms", receivedMs: fake.mail.get(b)?.receivedMs },
      {
        id: a,
        from: "news@shop.example",
        subject: "sale !",
        receivedMs: fake.mail.get(a)?.receivedMs,
      },
    ]);
    expect(fake.mailUnits).toBe(MAIL_UNITS.inbox + 2 * MAIL_UNITS.message);
  });

  it("asks again only for ids it has not read: a second look after one new mail costs 25 units", async () => {
    const { fake, reader } = wired();
    for (let i = 0; i < 4; i += 1) fake.deliver({ from: `s${String(i)}@x.example` });
    const known = new Map<string, RecentMail>();
    await readGmailRecent(reader, known, RECENT_MAX);
    const before = fake.mailUnits;
    const fresh = fake.deliver({ from: "new@x.example" });
    const rows = await readGmailRecent(reader, known, RECENT_MAX);
    expect(fake.mailUnits - before).toBe(MAIL_UNITS.inbox + MAIL_UNITS.message);
    expect(rows[0]?.id).toBe(fresh);
    expect(rows).toHaveLength(5);
  });

  it("keeps only the ids of the last answer, so what it holds never outgrows one look", async () => {
    const { fake, reader } = wired();
    const known = new Map<string, RecentMail>();
    for (let i = 0; i < 30; i += 1) {
      fake.deliver({ from: `s${String(i)}@x.example` });
      await readGmailRecent(reader, known, 3);
      expect(known.size).toBeLessThanOrEqual(3);
    }
  });

  it("leaves out a message deleted between the list and the read", async () => {
    const { fake, reader } = wired();
    const kept = fake.deliver({ from: "a@x.example" });
    const gone = fake.deliver({ from: "b@x.example" });
    const real = reader.message.bind(reader);
    const racing: GmailRecentReader = {
      inbox: (max, signal) => reader.inbox(max, signal),
      message: (id, signal) => {
        if (id === gone) fake.mail.delete(gone);
        return real(id, signal);
      },
    };
    expect((await readGmailRecent(racing, new Map(), RECENT_MAX)).map((r) => r.id)).toEqual([kept]);
  });

  it("never has more than GMAIL_RECENT_CONCURRENCY reads in flight", async () => {
    let running = 0;
    let most = 0;
    const ids = Array.from({ length: RECENT_MAX }, (_, i) => `id${String(i)}`);
    const reader: GmailRecentReader = {
      inbox: () => Promise.resolve(ids),
      message: async (id): Promise<MessageMetadata> => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return {
          id,
          labelIds: ["INBOX"],
          headers: [{ name: "From", value: "a@x.example" }],
          headersComplete: true,
          receivedMs: null,
        };
      },
    };
    const rows = await readGmailRecent(reader, new Map(), RECENT_MAX);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(most).toBe(GMAIL_RECENT_CONCURRENCY);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const reader: GmailRecentReader = {
      inbox: () => Promise.resolve(["a", "b", "c", "d"]),
      message: () => {
        controller.abort(new Error("closed"));
        return Promise.resolve("gone");
      },
    };
    await expect(readGmailRecent(reader, new Map(), 4, controller.signal)).rejects.toThrow(
      "closed",
    );
  });

  it("stops the other reads at the first failure, so no more quota goes after it, and keeps `known` to this answer", async () => {
    const ids = Array.from({ length: RECENT_MAX }, (_, i) => `id${String(i)}`);
    const asked: string[] = [];
    let aborted = 0;
    const reader: GmailRecentReader = {
      inbox: () => Promise.resolve(ids),
      message: (id, signal) => {
        asked.push(id);
        if (id === "id0") return Promise.reject(new Error("429"));
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted += 1;
            reject(new Error("aborted"));
          });
        });
      },
    };
    const known = new Map<string, RecentMail>([
      ["old", { id: "old", from: null, subject: "", receivedMs: null }],
    ]);
    await expect(readGmailRecent(reader, known, RECENT_MAX)).rejects.toThrow("429");
    // The two reads already out are called back; nothing after them goes.
    expect(asked).toEqual(["id0", "id1", "id2"]);
    expect(aborted).toBe(2);
    expect(known.has("old")).toBe(false);
  });

  it("sends no get when the deadline fired while the list came back", async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    const reader: GmailRecentReader = {
      inbox: () => {
        controller.abort(new Error("deadline"));
        return Promise.resolve(["a", "b"]);
      },
      message: (id) => {
        asked.push(id);
        return Promise.resolve("gone");
      },
    };
    await expect(readGmailRecent(reader, new Map(), 2, controller.signal)).rejects.toThrow(
      "deadline",
    );
    expect(asked).toEqual([]);
  });
});
