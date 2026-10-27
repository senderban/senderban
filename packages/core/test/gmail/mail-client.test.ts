import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import type { AdapterErrorCode } from "../../src/adapter.js";
import {
  GMAIL_USER_URL,
  HISTORY_PAGE_SIZE,
  HistoryExpiredError,
  MESSAGE_FIELDS,
  MESSAGE_HEADERS_MAX,
  createGmailMailClient,
  senderOf,
} from "../../src/gmail/mail-client.js";
import type { GoogleCall } from "../../src/google/http.js";
import { FakeGmail, MAIL_UNITS } from "./fake-gmail.js";

function setup() {
  const fake = new FakeGmail();
  const calls: GoogleCall[] = [];
  const client = createGmailMailClient({
    getAccessToken: () => Promise.resolve(fake.token),
    fetch: fake.fetch,
    onCall: (c) => calls.push(c),
  });
  return { fake, calls, client };
}

async function codeOf(promise: Promise<unknown>): Promise<AdapterErrorCode | "other" | "none"> {
  try {
    await promise;
    return "none";
  } catch (error) {
    return error instanceof AdapterError ? error.code : "other";
  }
}

describe("Gmail mail client", () => {
  it("profile: the current historyId, one unit, only the profile path", async () => {
    const { fake, client } = setup();
    fake.historyId = 4242;
    expect(await client.profile()).toEqual({ historyId: "4242" });
    expect(fake.mailUnits).toBe(MAIL_UNITS.profile);
    expect(fake.calls.map((c) => c.url)).toEqual([`${GMAIL_USER_URL}/profile`]);
  });

  it("history: asks for INBOX additions only, from the cursor, with a page size", async () => {
    const { fake, client } = setup();
    await client.history("1000");
    const url = new URL(fake.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe(`${GMAIL_USER_URL}/history`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startHistoryId: "1000",
      historyTypes: "messageAdded",
      labelId: "INBOX",
      maxResults: String(HISTORY_PAGE_SIZE),
    });
    expect(fake.mailUnits).toBe(MAIL_UNITS.history);
  });

  it("history: no records is an empty page that still carries the new cursor", async () => {
    const { fake, client } = setup();
    expect(await client.history("1000")).toEqual({
      messages: [],
      historyId: "1000",
      unreadable: 0,
    });
    fake.deliver({ from: "a@x.example" });
    const page = await client.history("1000");
    expect(page.messages.map((m) => m.labelIds)).toEqual([["INBOX", "UNREAD"]]);
    expect(page.historyId).toBe("1001");
  });

  it("history: mail in other labels (sent, draft) is not listed; INBOX only", async () => {
    const { fake, client } = setup();
    fake.deliver({ from: "me@gmail.com", labels: ["SENT"] });
    const inbox = fake.deliver({ from: "a@x.example" });
    expect((await client.history("1000")).messages.map((m) => m.id)).toEqual([inbox]);
  });

  it("history: pages through a long answer with the token Google gave", async () => {
    const { fake, client } = setup();
    for (let i = 0; i < HISTORY_PAGE_SIZE + 3; i += 1)
      fake.deliver({ from: `a${String(i)}@x.example` });
    const first = await client.history("1000");
    expect(first.messages).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.nextPageToken).toBeDefined();
    const second = await client.history("1000", first.nextPageToken);
    expect(second.messages).toHaveLength(3);
    expect(second.nextPageToken).toBeUndefined();
    expect(new Set([...first.messages, ...second.messages].map((m) => m.id)).size).toBe(
      HISTORY_PAGE_SIZE + 3,
    );
  });

  it("history: a message named twice in one page is listed once", async () => {
    const { fake, client } = setup();
    const id = fake.deliver({ from: "a@x.example" });
    fake.history.push({ id: 1500, added: [id] });
    fake.historyId = 1500;
    expect((await client.history("1000")).messages.map((m) => m.id)).toEqual([id]);
  });

  it("history: 404 is the expired cursor, a class of its own, not a plain refusal", async () => {
    const { fake, client } = setup();
    fake.oldestHistoryId = 5000;
    await expect(client.history("1000")).rejects.toBeInstanceOf(HistoryExpiredError);
    expect(await codeOf(client.history("1000"))).toBe("REJECTED");
  });

  it("history: an unreadable record is counted and skipped, the rest is read", async () => {
    const { fake, client } = setup();
    fake.forced.push({
      status: 200,
      body: {
        history: [
          { messagesAdded: "nonsense" },
          { messagesAdded: [{ message: { id: "abc123" } }] },
        ],
        historyId: "1200",
      },
    });
    const page = await client.history("1000");
    expect(page.unreadable).toBe(1);
    expect(page.messages).toEqual([{ id: "abc123", labelIds: [] }]);
  });

  it.each([
    ["no historyId", { history: [] }],
    ["a historyId that is not digits", { historyId: "12a" }],
    ["a historyId of 21 digits", { historyId: "1".repeat(21) }],
    ["a page token with a space", { historyId: "1", nextPageToken: "a b" }],
    ["a page token over 512", { historyId: "1", nextPageToken: "t".repeat(513) }],
  ])("history: %s fails the whole page as TRANSIENT, never a partial result", async (_n, body) => {
    const { fake, client } = setup();
    fake.forced.push({ status: 200, body });
    expect(await codeOf(client.history("1000"))).toBe("TRANSIENT");
  });

  it("history: one odd id in a record costs that message only, its siblings are read", async () => {
    const { fake, client } = setup();
    fake.forced.push({
      status: 200,
      body: {
        historyId: "1",
        history: [{ messagesAdded: [{ message: { id: "a/b" } }, { message: { id: "good1" } }] }],
      },
    });
    expect(await client.history("1000")).toEqual({
      messages: [{ id: "good1", labelIds: [] }],
      historyId: "1",
      unreadable: 1,
    });
  });

  it("history: a record whose message id is not a value is skipped and counted", async () => {
    const { fake, client } = setup();
    fake.forced.push({
      status: 200,
      body: { historyId: "1", history: [{ messagesAdded: [{ message: { id: "a/b" } }] }] },
    });
    expect(await client.history("1000")).toEqual({ messages: [], historyId: "1", unreadable: 1 });
  });

  it("history: refuses an id or token that is not a value before it leaves (no request sent)", async () => {
    const { fake, client } = setup();
    for (const bad of ["", "abc", "1 2", "1&x=2", "1".repeat(21), "-1"]) {
      expect(await codeOf(client.history(bad))).toBe("REJECTED");
    }
    for (const token of ["", "a b", "a&b=c\n", "t".repeat(513)]) {
      expect(await codeOf(client.history("1000", token))).toBe("REJECTED");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("message: From and Subject only, no body, 20 units", async () => {
    const { fake, client } = setup();
    const id = fake.deliver({
      from: "Spam <x@spam.example>",
      subject: "hi",
      extraHeaders: [{ name: "X-Secret", value: "do not read" }],
    });
    const message = await client.message(id);
    expect(message).toEqual({
      id,
      labelIds: ["INBOX", "UNREAD"],
      headers: [
        { name: "From", value: "Spam <x@spam.example>" },
        { name: "Subject", value: "hi" },
      ],
      headersComplete: true,
    });
    const url = new URL(fake.calls[0]?.url ?? "");
    expect(url.searchParams.get("format")).toBe("metadata");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject"]);
    expect(fake.mailUnits).toBe(MAIL_UNITS.message);
  });

  it("message: the answer is cut to the id, labels and headers, so no body fragment is downloaded", async () => {
    const { fake, client } = setup();
    const id = fake.deliver({ from: "a@x.example" });
    await client.message(id);
    const url = fake.calls[0]?.url ?? "";
    expect(new URL(url).searchParams.get("fields")).toBe(MESSAGE_FIELDS);
    // The fake adds a body fragment to every answer that is not cut: the one our request got has none.
    const cut = await (
      await fake.fetch(url, { headers: { Authorization: `Bearer ${fake.token}` } })
    ).text();
    expect(cut).not.toMatch(/SECRET BODY/u);
    const uncut = new URL(url);
    uncut.searchParams.delete("fields");
    const full = await (
      await fake.fetch(uncut, { headers: { Authorization: `Bearer ${fake.token}` } })
    ).text();
    expect(full).toMatch(/SECRET BODY/u);
  });

  it("senderOf: one readable From is the sender", async () => {
    const { fake, client } = setup();
    const message = await client.message(fake.deliver({ from: "Spam <X@Spam.Example>" }));
    expect(message).not.toBe("gone");
    if (message !== "gone")
      expect(senderOf(message)).toEqual({ ok: true, address: "x@spam.example" });
  });

  it("senderOf: a hidden second From (too long to read) makes the sender untrusted, through the client and the parser together", async () => {
    const { fake, client } = setup();
    const id = fake.deliver({
      from: ["<victim@bank.example>", `<${"x".repeat(9_000)}@y.example>`],
    });
    const message = await client.message(id);
    expect(message).not.toBe("gone");
    if (message === "gone") return;
    // the dropped header leaves exactly one readable From behind: the parser alone would trust it
    expect(message.headers.filter((h) => h.name === "From")).toHaveLength(1);
    expect(senderOf(message)).toEqual({ ok: false, reason: "from-unparsable" });
  });

  it("senderOf: two readable From headers and more headers than asked for are refused too", async () => {
    const { fake, client } = setup();
    const two = await client.message(fake.deliver({ from: ["a@x.example", "b@y.example"] }));
    expect(two !== "gone" && senderOf(two).ok).toBe(false);
    fake.forced.push({
      status: 200,
      body: {
        id: "abc123",
        payload: {
          headers: Array.from({ length: MESSAGE_HEADERS_MAX + 1 }, () => ({
            name: "Subject",
            value: "x",
          })).concat([{ name: "From", value: "<a@x.example>" }] as never),
        },
      },
    });
    const many = await client.message("abc123");
    expect(many !== "gone" && senderOf(many).ok).toBe(false);
  });

  it("message: a second From header comes back as a second entry, so the parser can refuse it", async () => {
    const { fake, client } = setup();
    const id = fake.deliver({ from: ["a@x.example", "b@y.example"] });
    const message = await client.message(id);
    expect(message).not.toBe("gone");
    if (message !== "gone")
      expect(message.headers.filter((h) => h.name === "From")).toHaveLength(2);
  });

  it("message: deleted before we asked is `gone`, not an error", async () => {
    const { client } = setup();
    expect(await client.message("deadbeef00000000")).toBe("gone");
  });

  it("message: a header that cannot be read makes the sender untrusted (a hidden second From)", async () => {
    const { fake, client } = setup();
    const long = "x".repeat(9_000);
    fake.forced.push({
      status: 200,
      body: {
        id: "abc123",
        payload: {
          headers: [
            { name: "From", value: "<a@x.example>" },
            { name: "From", value: long },
          ],
        },
      },
    });
    const message = await client.message("abc123");
    expect(message).not.toBe("gone");
    if (message !== "gone") {
      expect(message.headersComplete).toBe(false);
      expect(message.headers).toEqual([{ name: "From", value: "<a@x.example>" }]);
    }
  });

  it("message: more headers than we ask for is not trusted", async () => {
    const { fake, client } = setup();
    fake.forced.push({
      status: 200,
      body: {
        id: "abc123",
        payload: {
          headers: Array.from({ length: MESSAGE_HEADERS_MAX + 1 }, () => ({
            name: "From",
            value: "<a@x.example>",
          })),
        },
      },
    });
    const message = await client.message("abc123");
    expect(message !== "gone" && message.headersComplete).toBe(false);
  });

  it("message: an answer for another id is malformed", async () => {
    const { fake, client } = setup();
    fake.forced.push({ status: 200, body: { id: "other", payload: { headers: [] } } });
    expect(await codeOf(client.message("abc123"))).toBe("TRANSIENT");
  });

  it("message: an id that is not a value is refused before it leaves", async () => {
    const { fake, client } = setup();
    for (const bad of ["", "a/b", "a?b", "a b", "..", "x".repeat(65)]) {
      expect(await codeOf(client.message(bad))).toBe("REJECTED");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("errors map like the filter client: 401 and 403 auth, 429 and rate 403 quota, 5xx transient", async () => {
    const { fake, client } = setup();
    const cases: [number | { status: number; body: unknown }, AdapterErrorCode][] = [
      [401, "AUTH_REQUIRED"],
      [403, "AUTH_REQUIRED"],
      [429, "QUOTA_EXCEEDED"],
      [
        { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
        "QUOTA_EXCEEDED",
      ],
      [503, "TRANSIENT"],
    ];
    for (const [forced, code] of cases) {
      fake.forced.push(forced);
      expect(await codeOf(client.history("1000"))).toBe(code);
      fake.forced.push(forced);
      expect(await codeOf(client.message("abc123"))).toBe(code);
      fake.forced.push(forced);
      expect(await codeOf(client.profile())).toBe(code);
    }
  });

  it("never repeats what Google wrote: an error body with an address and a token stays out of the message", async () => {
    const { fake, client } = setup();
    fake.forced.push({
      status: 500,
      body: { error: { message: "spammer@evil.example ya29.leaky-token-value" } },
    });
    const error = await client.history("1000").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).message).not.toMatch(/spammer|ya29/u);
  });

  it("every request is reported once, with its own operation word", async () => {
    const { fake, calls, client } = setup();
    const id = fake.deliver({ from: "a@x.example" });
    await client.profile();
    await client.history("1000");
    await client.message(id);
    expect(calls.map((c) => [c.op, c.status])).toEqual([
      ["profile", 200],
      ["history-list", 200],
      ["message-get", 200],
    ]);
  });

  it("a request has a deadline and does not follow redirects, like every Google call", async () => {
    const { fake, client } = setup();
    await client.history("1000");
    expect(fake.calls[0]?.redirect).toBe("error");
    expect(fake.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
