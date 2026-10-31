import { describe, expect, it } from "vitest";
import {
  DeltaExpiredError,
  DeltaTooLargeError,
  GRAPH_BODY_MAX_BYTES,
  GRAPH_DELTA_LINK_MAX_CHARS,
  GRAPH_DELTA_PAGE_SIZE,
  GRAPH_INBOX_DELTA_URL,
  createGraphClient,
} from "../../src/graph/client.js";

const LINK = `${GRAPH_INBOX_DELTA_URL}?$deltatoken=abc`;
const NEXT = `${GRAPH_INBOX_DELTA_URL}?$skiptoken=def`;
const START = Date.UTC(2026, 10, 1, 12, 0, 0, 500);

interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

function rig(answers: Answer[], now: { value: number } = { value: 0 }) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const client = createGraphClient({
    getAccessToken: () => Promise.resolve("access-token"),
    now: () => now.value,
    fetch: ((url: string, init: RequestInit) => {
      urls.push(url);
      headers.push(init.headers as Record<string, string>);
      const answer = answers.shift() ?? { body: { value: [], "@odata.deltaLink": LINK } };
      const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      return Promise.resolve(
        new Response(text, {
          status: answer.status ?? 200,
          ...(answer.headers === undefined ? {} : { headers: answer.headers }),
        }),
      );
    }) as unknown as typeof fetch,
  });
  return { client, urls, headers };
}

const mail = (over: Record<string, unknown> = {}) => ({
  id: "AAMkAD=",
  receivedDateTime: "2026-11-01T12:00:05Z",
  subject: "WIN NOW",
  from: { emailAddress: { name: "Spam Co", address: "Spam@News.Example.com" } },
  ...over,
});

describe("graph mail client: delta", () => {
  it("starts a round with new mail only, from the given time, asking for no more than it shows", async () => {
    const { client, urls, headers } = rig([]);
    await client.delta({ sinceMs: START });
    expect(urls[0]).toBe(
      `${GRAPH_INBOX_DELTA_URL}?changeType=created&$select=from,subject,receivedDateTime&$filter=receivedDateTime+ge+2026-11-01T12:00:00Z`,
    );
    expect(headers[0]?.["Prefer"]).toBe(`odata.maxpagesize=${String(GRAPH_DELTA_PAGE_SIZE)}`);
    expect(headers[0]?.["Authorization"]).toBe("Bearer access-token");
  });

  it("reads a link as given: the token keeps the query", async () => {
    const { client, urls } = rig([]);
    await client.delta({ link: LINK });
    expect(urls[0]).toBe(LINK);
  });

  it("gives the sender in canonical form, a clean subject and the time", async () => {
    const { client } = rig([
      {
        body: {
          value: [mail({ subject: "a‮b\r\nc" })],
          "@odata.deltaLink": LINK,
        },
      },
    ]);
    const page = await client.delta({ link: LINK });
    expect(page).toEqual({
      mail: [
        {
          id: "AAMkAD=",
          from: "spam@news.example.com",
          subject: "a b c",
          receivedMs: Date.UTC(2026, 10, 1, 12, 0, 5),
        },
      ],
      unreadable: 0,
      link: LINK,
      more: false,
    });
  });

  it("says when the round goes on", async () => {
    const { client } = rig([{ body: { value: [], "@odata.nextLink": NEXT } }]);
    await expect(client.delta({ link: LINK })).resolves.toMatchObject({ link: NEXT, more: true });
  });

  it("keeps a mail whose sender cannot be trusted, with no sender", async () => {
    const { client } = rig([
      {
        body: {
          value: [
            mail({ id: "a", from: { emailAddress: { address: "/O=EXCHANGELABS/OU=X/CN=Y" } } }),
            mail({ id: "b", from: null }),
          ],
          "@odata.deltaLink": LINK,
        },
      },
    ]);
    const page = await client.delta({ link: LINK });
    expect(page.mail.map((m) => m.from)).toEqual([null, null]);
    expect(page.unreadable).toBe(0);
  });

  it("does not take a deletion or a change that names no time for mail, and does not count them", async () => {
    const { client } = rig([
      {
        body: {
          value: [
            { id: "gone", "@removed": { reason: "deleted" } },
            mail({ id: "gone-with-fields", "@removed": { reason: "deleted" } }),
            { id: "read", isRead: true },
          ],
          "@odata.deltaLink": LINK,
        },
      },
    ]);
    await expect(client.delta({ link: LINK })).resolves.toMatchObject({ mail: [], unreadable: 0 });
  });

  it("counts an entry it cannot read, and it costs that entry only", async () => {
    const { client } = rig([
      {
        body: {
          value: [
            { id: "bad id with spaces\n" },
            mail({ id: "bad-time", receivedDateTime: "yesterday" }),
            mail({ id: "long", subject: "x".repeat(9_000) }),
            mail({ id: "fine" }),
          ],
          "@odata.deltaLink": LINK,
        },
      },
    ]);
    const page = await client.delta({ link: LINK });
    expect(page.mail.map((m) => m.id)).toEqual(["fine"]);
    expect(page.unreadable).toBe(3);
  });

  it.each([
    ["404", { status: 404, body: { error: { code: "ErrorItemNotFound" } } }],
    ["410", { status: 410, body: {} }],
    [
      "an error code about the sync state",
      { status: 400, body: { error: { code: "syncStateNotFound" } } },
    ],
    ["resync", { status: 400, body: { error: { code: "resyncRequired" } } }],
  ])("reads %s on a stored link as a lost place", async (_name, answer) => {
    const { client } = rig([answer]);
    await expect(client.delta({ link: LINK })).rejects.toBeInstanceOf(DeltaExpiredError);
  });

  it("does not read a refused start as a lost place: that would ask for ever", async () => {
    const { client } = rig([{ status: 400, body: { error: { code: "BadRequest" } } }]);
    const error = await client.delta({ sinceMs: START }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DeltaExpiredError);
    expect(error).toMatchObject({ code: "REJECTED" });
  });

  it("stops the sign-in on a 401 and a 403", async () => {
    await expect(rig([{ status: 401 }]).client.delta({ link: LINK })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(rig([{ status: 403 }]).client.delta({ link: LINK })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("keeps quiet for as long as Microsoft asks, for rules as well", async () => {
    const now = { value: 1_000 };
    const { client, urls } = rig(
      [{ status: 429, body: {}, headers: { "Retry-After": "120" } }],
      now,
    );
    await expect(client.delta({ link: LINK })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(client.delta({ link: LINK })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(urls).toHaveLength(1);
    now.value += 121_000;
    await expect(client.delta({ link: LINK })).resolves.toBeDefined();
  });

  it("reads a page too big as its own class", async () => {
    const { client } = rig([{ body: "x".repeat(GRAPH_BODY_MAX_BYTES + 1) }]);
    await expect(client.delta({ link: LINK })).rejects.toBeInstanceOf(DeltaTooLargeError);
  });

  it.each([
    ["no link", { value: [] }],
    ["both links", { value: [], "@odata.nextLink": NEXT, "@odata.deltaLink": LINK }],
    ["a link to another host", { value: [], "@odata.deltaLink": "https://evil.example/v1.0/x" }],
    [
      "a link to another scheme",
      { value: [], "@odata.nextLink": "http://graph.microsoft.com/v1.0/x" },
    ],
    [
      "a link with a user",
      { value: [], "@odata.deltaLink": "https://a@graph.microsoft.com/v1.0/x" },
    ],
    [
      "too many entries",
      { value: new Array(GRAPH_DELTA_PAGE_SIZE * 4 + 1).fill({}), "@odata.deltaLink": LINK },
    ],
  ])("refuses an answer with %s", async (_name, body) => {
    const { client } = rig([{ body }]);
    await expect(client.delta({ link: LINK })).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("refuses a link longer than what is kept", async () => {
    const long = `${GRAPH_INBOX_DELTA_URL}?$deltatoken=${"a".repeat(GRAPH_DELTA_LINK_MAX_CHARS)}`;
    const { client } = rig([{ body: { value: [], "@odata.deltaLink": long } }]);
    await expect(client.delta({ link: LINK })).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it.each([
    ["another host", "https://evil.example/v1.0/me/mailFolders/inbox/messages/delta"],
    ["another version", "https://graph.microsoft.com/beta/me/messages"],
    ["no URL", "not a url"],
  ])("sends no token to a stored link on %s", async (_name, link) => {
    const { client, urls } = rig([]);
    await expect(client.delta({ link })).rejects.toMatchObject({ code: "REJECTED" });
    expect(urls).toEqual([]);
  });

  it("sends nothing for a time that is no time", async () => {
    const { client, urls } = rig([]);
    await expect(client.delta({ sinceMs: Number.NaN })).rejects.toMatchObject({ code: "REJECTED" });
    expect(urls).toEqual([]);
  });
});
