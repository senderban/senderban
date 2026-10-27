import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import type { AdapterErrorCode } from "../../src/adapter.js";
import {
  FilterExistsError,
  GMAIL_FILTERS_URL,
  GMAIL_LIST_MAX_BYTES,
  GMAIL_QUERY_MAX_CHARS,
  createGmailClient,
} from "../../src/gmail/client.js";
import type { GoogleCall } from "../../src/google/http.js";
import { FakeGmail, UNITS } from "./fake-gmail.js";

function setup(over: { timeoutMs?: number; token?: () => Promise<string> } = {}) {
  const fake = new FakeGmail();
  const calls: GoogleCall[] = [];
  const client = createGmailClient({
    getAccessToken: over.token ?? (() => Promise.resolve(fake.token)),
    fetch: fake.fetch,
    onCall: (c) => calls.push(c),
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
  return { fake, calls, client };
}

/** The error of a call that must fail: its code and message, or a marker the assertion cannot match. */
async function failed(
  promise: Promise<unknown>,
): Promise<{ code: AdapterErrorCode | "not an AdapterError" | "no error"; message: string }> {
  try {
    await promise;
    return { code: "no error", message: "" };
  } catch (error) {
    return error instanceof AdapterError
      ? { code: error.code, message: error.message }
      : { code: "not an AdapterError", message: String(error) };
  }
}
const codeOf = async (promise: Promise<unknown>) => (await failed(promise)).code;

const QUERY = 'from:("a@x.com" OR "b@y.com")';
const LEAK = {
  error: {
    message: "spammer@evil.example ya29.leaky-token-value",
    errors: [{ reason: "backendError", message: "spammer@evil.example" }],
  },
};

describe("Gmail filter client", () => {
  it("list: no `filter` key is an empty list", async () => {
    const { client } = setup();
    expect(await client.list()).toEqual({ filters: [], unreadable: 0 });
  });

  it("list: returns the person's own filters too, with keys this lane never writes kept", async () => {
    const { fake, client } = setup();
    fake.addForeign(
      { from: "boss@work.example", hasAttachment: true, unknownNew: 1 },
      { forward: "x@y.example" },
    );
    const { filters, unreadable } = await client.list();
    expect(unreadable).toBe(0);
    expect(filters[0]?.criteria).toMatchObject({
      from: "boss@work.example",
      hasAttachment: true,
      unknownNew: 1,
    });
    expect(filters[0]?.action).toMatchObject({ forward: "x@y.example" });
  });

  it("list: one filter of the person's that does not fit the bounds is counted, and the rest is still read", async () => {
    const { fake, client } = setup();
    fake.listBody = JSON.stringify({
      filter: [
        { id: "good-1", criteria: { query: QUERY }, action: { addLabelIds: ["TRASH"] } },
        { id: "has space" },
        { id: "ok", criteria: { query: 5 } },
        { criteria: {} },
        { id: "too-many", action: { addLabelIds: Array.from({ length: 101 }, () => "x") } },
        "not an object",
      ],
    });
    const { filters, unreadable } = await client.list();
    expect(filters.map((f) => f.id)).toEqual(["good-1"]);
    expect(unreadable).toBe(5);
  });

  it("list: GET with a bearer token, no redirect following, the caller's abort signal", async () => {
    const { fake, client } = setup();
    const ac = new AbortController();
    await client.list(ac.signal);
    const call = fake.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe(GMAIL_FILTERS_URL);
    expect(call?.headers["Authorization"]).toBe(`Bearer ${fake.token}`);
    expect(call?.redirect).toBe("error");
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it("create: sends exactly criteria.query and action TRASH, returns the filter", async () => {
    const { fake, client } = setup();
    const filter = await client.create(QUERY);
    expect(JSON.parse(fake.calls[0]?.body ?? "{}")).toEqual({
      criteria: { query: QUERY },
      action: { addLabelIds: ["TRASH"] },
    });
    expect(fake.calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(filter.id).toMatch(/^filter-/u);
    expect(fake.filters.get(filter.id)?.criteria).toEqual({ query: QUERY });
  });

  it("create: the longest measured-accepted query goes out, one character more and a non-ASCII one never do", async () => {
    const { fake, client } = setup();
    const longest = `from:(${"a".repeat(GMAIL_QUERY_MAX_CHARS - 7)})`;
    expect(longest).toHaveLength(GMAIL_QUERY_MAX_CHARS);
    await client.create(longest);
    expect(fake.calls).toHaveLength(1);
    for (const bad of ["", `${longest}a`, 'from:("é@x.com")', "from:(\u0000)", "a\nb"]) {
      expect(await codeOf(client.create(bad))).toBe("REJECTED");
    }
    expect(fake.calls).toHaveLength(1);
  });

  it("create: the same filter twice is a FilterExistsError (REJECTED), nothing else is", async () => {
    const { fake, client } = setup();
    await client.create(QUERY);
    const second = client.create(QUERY);
    expect(await codeOf(second)).toBe("REJECTED");
    await expect(client.create(QUERY)).rejects.toBeInstanceOf(FilterExistsError);
    expect(fake.filters.size).toBe(1);
    // A 400 that is not "already exists" is a plain REJECTED, and so is "already exists" under another reason.
    for (const body of [
      { error: { message: "Invalid label", errors: [{ reason: "invalidArgument" }] } },
      { error: { message: "Too many", errors: [{ reason: "failedPrecondition" }] } },
      { error: { message: "Filter already exists", errors: [{ reason: "invalidArgument" }] } },
      { error: { errors: [{ reason: "failedPrecondition" }] } },
    ]) {
      fake.forced.push({ status: 400, body });
      const error = await client.create(QUERY).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterError);
      expect(error).not.toBeInstanceOf(FilterExistsError);
    }
  });

  it("remove: 204 is removed and 404 is gone", async () => {
    const { fake, client } = setup();
    const filter = await client.create(QUERY);
    expect(await client.remove(filter.id)).toBe("removed");
    expect(fake.filters.size).toBe(0);
    expect(await client.remove(filter.id)).toBe("gone");
    expect(fake.calls[1]?.method).toBe("DELETE");
    expect(fake.calls[1]?.url).toBe(`${GMAIL_FILTERS_URL}/${filter.id}`);
  });

  it("remove: an id that could change the meaning of the path is refused before any request", async () => {
    const { fake, client } = setup();
    for (const id of [
      "",
      "../x",
      "a/b",
      "a\\b",
      "a b",
      "a?x=1",
      "a#b",
      "a%2Fb",
      "..",
      "...",
      "x".repeat(257),
    ]) {
      expect(await codeOf(client.remove(id))).toBe("REJECTED");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("remove: an id with URL-special but allowed characters is encoded into the path", async () => {
    const { fake, client } = setup();
    fake.filters.set("a+b=c", { id: "a+b=c", criteria: {}, action: {} });
    expect(await client.remove("a+b=c")).toBe("removed");
    expect(fake.calls[0]?.url).toBe(`${GMAIL_FILTERS_URL}/a%2Bb%3Dc`);
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "AUTH_REQUIRED"],
    [429, "QUOTA_EXCEEDED"],
    [400, "REJECTED"],
    [500, "TRANSIENT"],
    [503, "TRANSIENT"],
  ] as const)("a %i answer is %s, for list, create and remove alike", async (status, code) => {
    const { fake, client } = setup();
    fake.forced.push(status, status, status);
    expect(await codeOf(client.list())).toBe(code);
    expect(await codeOf(client.create(QUERY))).toBe(code);
    expect(await codeOf(client.remove("abc"))).toBe(code);
  });

  it.each(["list", "create", "remove"] as const)(
    "a 403 with a rate-limit reason is QUOTA_EXCEEDED on %s, not a missing permission",
    async (op) => {
      const { fake, client } = setup();
      fake.forced.push({
        status: 403,
        body: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
      });
      const run = {
        list: () => client.list(),
        create: () => client.create(QUERY),
        remove: () => client.remove("abc"),
      }[op];
      expect(await codeOf(run())).toBe("QUOTA_EXCEEDED");
    },
  );

  it("a wrong access token is AUTH_REQUIRED", async () => {
    const { client } = setup({ token: () => Promise.resolve("ya29.some-other-token") });
    expect(await codeOf(client.list())).toBe("AUTH_REQUIRED");
  });

  it("a token that is not a header-safe value is refused before any request", async () => {
    for (const bad of ["", "a b", "a\r\nX-Evil: 1", "x".repeat(2049)]) {
      const { fake, client } = setup({ token: () => Promise.resolve(bad) });
      expect(await codeOf(client.list())).toBe("REJECTED");
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("a token source that throws something else is a fixed TRANSIENT, its text is not repeated", async () => {
    const { fake, client } = setup({
      token: () =>
        Promise.reject(new Error("refresh failed for ya29.token-in-text spammer@evil.example")),
    });
    const { code, message } = await failed(client.list());
    expect(code).toBe("TRANSIENT");
    expect(message).not.toContain("ya29");
    expect(message).not.toContain("evil");
    expect(fake.calls).toHaveLength(0);
  });

  it.each([400, 401, 403, 429, 500])(
    "a %i answer whose body holds an address and a token reaches no message and no log call",
    async (status) => {
      const sent = "ya29.the-token-we-sent";
      const { fake, calls, client } = setup({ token: () => Promise.resolve(sent) });
      fake.token = sent;
      const messages: string[] = [];
      for (const run of [
        () => client.list(),
        () => client.create(QUERY),
        () => client.remove("abc"),
      ]) {
        fake.forced.push({ status, body: LEAK });
        messages.push((await failed(run())).message);
      }
      expect(messages.every((m) => m !== "")).toBe(true);
      for (const text of [...messages, JSON.stringify(calls)]) {
        expect(text).not.toContain("spammer@evil.example");
        expect(text).not.toContain("leaky-token");
        expect(text).not.toContain(sent);
      }
    },
  );

  it("a network failure is TRANSIENT and is logged without a status", async () => {
    const { fake, calls, client } = setup();
    fake.failNetwork = 1;
    expect(await codeOf(client.list())).toBe("TRANSIENT");
    expect(calls).toEqual([{ op: "filter-list", status: null, ms: expect.any(Number) as number }]);
  });

  it("a request that outlives its deadline is TRANSIENT", async () => {
    const { fake, client } = setup({ timeoutMs: 20 });
    fake.hold = new Promise(() => undefined);
    expect(await codeOf(client.list())).toBe("TRANSIENT");
  });

  it("the caller's AdapterError abort reason comes back as it is", async () => {
    const { fake, client } = setup();
    fake.hold = new Promise(() => undefined);
    const ac = new AbortController();
    const pending = codeOf(client.create(QUERY, ac.signal));
    ac.abort(new AdapterError("QUOTA_EXCEEDED", "round over"));
    expect(await pending).toBe("QUOTA_EXCEEDED");
  });

  it("a malformed answer is TRANSIENT, never a partial list", async () => {
    const { fake, client } = setup();
    for (const listBody of ["not json", JSON.stringify({ filter: "nope" }), "[]"]) {
      fake.listBody = listBody;
      expect(await codeOf(client.list())).toBe("TRANSIENT");
    }
    for (const body of [{ id: "../evil" }, { id: "" }, {}, { criteria: {} }]) {
      fake.forced.push({ status: 200, body });
      expect(await codeOf(client.create(QUERY))).toBe("TRANSIENT");
    }
  });

  it("a list over the byte cap is REJECTED (reading it again reads the same list), though every filter in it is valid", async () => {
    const { fake, client } = setup();
    // 1,900 filters (under the 2,000 entry cap) of about 1.2 KB: only the byte cap can reject this.
    const filter = (i: number) => ({ id: `f${String(i)}`, criteria: { query: "q".repeat(1_100) } });
    fake.listBody = JSON.stringify({ filter: Array.from({ length: 1_900 }, (_, i) => filter(i)) });
    expect(fake.listBody.length).toBeGreaterThan(GMAIL_LIST_MAX_BYTES);
    const { code, message } = await failed(client.list());
    expect(code).toBe("REJECTED");
    expect(message).toContain("larger than Senderban reads");
  });

  it("a list that declares a length over the cap is refused before its body is read", async () => {
    const { fake, client } = setup();
    fake.listBody = "{}";
    fake.listHeaders = { "content-length": String(GMAIL_LIST_MAX_BYTES + 1) };
    const { code, message } = await failed(client.list());
    expect(code).toBe("REJECTED");
    expect(message).toContain("larger than Senderban reads");
  });

  it("a list far over the old 64 KiB default but under the cap is read in full", async () => {
    const { fake, client } = setup();
    for (let i = 0; i < 300; i += 1) fake.addForeign({ query: "q".repeat(5_000) }, {});
    expect((await client.list()).filters.length).toBe(300);
  });

  it("reports operation, status and duration once per request, and a throwing listener breaks nothing", async () => {
    const { fake, calls, client } = setup();
    const filter = await client.create(QUERY);
    await client.list();
    await client.remove(filter.id);
    expect(calls.map((c) => [c.op, c.status])).toEqual([
      ["filter-create", 200],
      ["filter-list", 200],
      ["filter-delete", 204],
    ]);
    const loud = createGmailClient({
      getAccessToken: () => Promise.resolve(fake.token),
      fetch: fake.fetch,
      onCall: () => {
        throw new Error("listener bug");
      },
    });
    expect(await loud.list()).toEqual({ filters: [], unreadable: 0 });
  });

  it("a failure while the body is read does not add a second log entry for the request", async () => {
    const calls: GoogleCall[] = [];
    const client = createGmailClient({
      getAccessToken: () => Promise.resolve("ya29.t"),
      onCall: (c) => calls.push(c),
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("stream broke"));
              },
            }),
            { status: 200 },
          ),
        ),
    });
    expect(await codeOf(client.list())).toBe("TRANSIENT");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe(200);
  });

  it("the fake charges the quota units Google documents", async () => {
    const { fake, client } = setup();
    const filter = await client.create(QUERY);
    await client.list();
    await client.remove(filter.id);
    expect(fake.units).toBe(UNITS.create + UNITS.list + UNITS.delete);
  });
});
