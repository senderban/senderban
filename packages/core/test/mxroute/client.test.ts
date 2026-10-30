import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import {
  EntryRefusedError,
  RateLimitedError,
  MXROUTE_API,
  MXROUTE_BODY_MAX_BYTES,
  createMxrouteClient,
} from "../../src/mxroute/client.js";
import { FakeMxroute } from "./fake-mxroute.js";

const KEY = "test-mxroute-key-not-real-0000";

function setup() {
  const fake = new FakeMxroute();
  let keyReads = 0;
  const client = createMxrouteClient({
    server: "mx.example.net",
    username: "exampleuser",
    getKey: () => {
      keyReads += 1;
      return Promise.resolve(KEY);
    },
    fetch: fake.fetch,
    timeoutMs: 500,
  });
  return { fake, client, keyReads: () => keyReads };
}

const code = async (work: Promise<unknown>): Promise<{ code: string; message: string } | null> =>
  work.then(
    () => null,
    (error: unknown) =>
      error instanceof AdapterError ? { code: error.code, message: error.message } : null,
  );

describe("MXroute client requests", () => {
  it("talks only to the fixed host, with the three headers and no redirects", async () => {
    const { fake, client } = setup();
    await client.add("example.com", "a@example.com");
    const call = fake.calls[0];
    expect(call?.url).toBe(`${MXROUTE_API}/domains/example.com/spam/blacklist`);
    expect(call?.headers).toMatchObject({
      "X-Server": "mx.example.net",
      "X-Username": "exampleuser",
      "X-API-Key": KEY,
    });
    expect(call?.redirect).toBe("error");
    expect(call?.body).toBe(JSON.stringify({ entry: "a@example.com" }));
  });

  it("reads the key again for every request instead of holding it", async () => {
    const { client, keyReads } = setup();
    await client.add("example.com", "a@example.com");
    await client.list("example.com");
    await client.remove("example.com", "a@example.com");
    expect(keyReads()).toBe(3);
  });

  it("treats an entry that is already there (409) or already gone (404) as done", async () => {
    const { fake, client } = setup();
    await client.add("example.com", "a@example.com");
    await client.add("example.com", "a@example.com");
    await client.remove("example.com", "a@example.com");
    await client.remove("example.com", "a@example.com");
    expect(fake.entries.size).toBe(0);
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "AUTH_REQUIRED"],
    [429, "TRANSIENT"],
    [500, "TRANSIENT"],
    [503, "TRANSIENT"],
    [400, "REJECTED"],
    [422, "REJECTED"],
  ])("maps status %i to %s without quoting the key", async (status, expected) => {
    const { fake, client } = setup();
    fake.forced.push(status);
    const result = await code(client.add("example.com", "a@example.com"));
    expect(result?.code).toBe(expected);
    expect(result?.message).not.toContain(KEY);
  });

  it("reports a network failure as TRANSIENT with a fixed text", async () => {
    const { fake, client } = setup();
    fake.failNetwork = 1;
    const result = await code(client.list("example.com"));
    expect(result?.code).toBe("TRANSIENT");
    expect(result?.message).not.toContain(KEY);
  });

  it("reports an unreadable stored key as REJECTED, not as a network problem", async () => {
    const fake = new FakeMxroute();
    const client = createMxrouteClient({
      server: "s",
      username: "u",
      getKey: () => Promise.reject(new Error("decrypt failed")),
      fetch: fake.fetch,
    });
    expect((await code(client.list("example.com")))?.code).toBe("REJECTED");
    expect(fake.calls).toHaveLength(0);
  });

  it("tells a rate limit (429) from other busy answers, and reports every request without its content", async () => {
    const { fake } = setup();
    const calls: unknown[] = [];
    const client = createMxrouteClient({
      server: "s",
      username: "u",
      getKey: () => Promise.resolve(KEY),
      fetch: fake.fetch,
      onCall: (call) => calls.push(call),
    });
    fake.forced.push(429, 503);
    await expect(client.add("example.com", "a@example.com")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    const busy = await client.add("example.com", "a@example.com").catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(AdapterError);
    expect(busy).not.toBeInstanceOf(RateLimitedError);
    fake.failNetwork = 1;
    await client.list("example.com").catch(() => undefined);
    expect(calls.map((c) => (c as { op: string; status: number | null }).status)).toEqual([
      429,
      503,
      null,
    ]);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(JSON.stringify(calls)).not.toContain("a@example.com");
  });

  it("tells a refused entry (400/422 on add) from every other refusal", async () => {
    const { fake, client } = setup();
    for (const status of [400, 422]) {
      fake.forced.push(status);
      await expect(client.add("example.com", "a@example.com")).rejects.toBeInstanceOf(
        EntryRefusedError,
      );
    }
    fake.forced.push(400);
    const removal = await client.remove("example.com", "a@example.com").catch((e: unknown) => e);
    expect(removal).toBeInstanceOf(AdapterError);
    expect(removal).not.toBeInstanceOf(EntryRefusedError);
  });

  it.each([
    "has space@example.com",
    "*@gmail.com",
    "a*b@example.com",
    "*@163.com",
    "@163.com",
    ".",
    "..",
    "a@b.com\r\nX-Evil: 1",
    "",
    "x".repeat(255),
    "a/b@c.com",
    "ü@x.com",
  ])("refuses entry %j before any request", async (entry) => {
    const { fake, client } = setup();
    expect((await code(client.add("example.com", entry)))?.code).toBe("REJECTED");
    expect((await code(client.remove("example.com", entry)))?.code).toBe("REJECTED");
    expect(fake.calls).toHaveLength(0);
  });

  it("passes the caller's abort signal on, and surfaces its reason", async () => {
    const { fake, client } = setup();
    let release: () => void = () => undefined;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const pending = code(client.add("example.com", "a@example.com", controller.signal));
    await new Promise((r) => setTimeout(r, 5));
    const reason = new AdapterError("TRANSIENT", "provider did not answer");
    controller.abort(reason);
    release();
    expect((await pending)?.message).toBe("provider did not answer");
    expect(fake.entries.size).toBe(0);
  });
});

describe("MXroute client domains", () => {
  it("reads the login's domains from the fixed host, naming no domain", async () => {
    const { fake, client } = setup();
    expect(await client.domains()).toEqual(["example.com"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(`${MXROUTE_API}/domains`);
    expect(fake.calls[0]?.method).toBe("GET");
    expect(fake.calls[0]?.headers["X-API-Key"]).toBe(KEY);
  });

  it("maps a refused key to AUTH_REQUIRED and a busy server to TRANSIENT", async () => {
    const { fake, client } = setup();
    fake.forced.push(401);
    expect((await code(client.domains()))?.code).toBe("AUTH_REQUIRED");
    fake.forced.push(403);
    expect((await code(client.domains()))?.code).toBe("AUTH_REQUIRED");
    fake.forced.push(503);
    expect((await code(client.domains()))?.code).toBe("TRANSIENT");
  });

  it("reports the call under its own name", async () => {
    const fake = new FakeMxroute();
    const calls: unknown[] = [];
    const client = createMxrouteClient({
      server: "mx.example.net",
      username: "exampleuser",
      getKey: () => Promise.resolve(KEY),
      fetch: fake.fetch,
      onCall: (call) => {
        calls.push(call);
      },
    });
    await client.domains();
    expect(calls).toEqual([{ op: "domains", status: 200, ms: expect.any(Number) as number }]);
  });
});

describe("MXroute client list", () => {
  it("returns the entries of a well-formed answer", async () => {
    const { fake, client } = setup();
    fake.entries.add("@163.com");
    fake.entries.add("a@example.com");
    expect(await client.list("example.com")).toEqual(["@163.com", "a@example.com"]);
  });

  it.each([
    ["not JSON", "<html>"],
    ["wrong shape", JSON.stringify({ success: true, data: "x" })],
    ["success false", JSON.stringify({ success: false, data: [] })],
    ["entry too long", JSON.stringify({ success: true, data: ["x".repeat(300)] })],
    ["entry not a string", JSON.stringify({ success: true, data: [1] })],
  ])("treats %s as a malformed answer", async (_name, body) => {
    const { fake, client } = setup();
    fake.listBody = body;
    expect((await code(client.list("example.com")))?.code).toBe("TRANSIENT");
  });

  it("cuts off an answer that declares or streams more than the bound", async () => {
    const { fake, client } = setup();
    fake.listHeaders = { "content-length": String(MXROUTE_BODY_MAX_BYTES + 1) };
    expect((await code(client.list("example.com")))?.code).toBe("TRANSIENT");

    fake.listHeaders = {};
    fake.listBody =
      JSON.stringify({ success: true, data: ["a@x.com"] }) + " ".repeat(MXROUTE_BODY_MAX_BYTES);
    expect((await code(client.list("example.com")))?.code).toBe("TRANSIENT");
  });

  it("maps a refused list to AUTH_REQUIRED", async () => {
    const { fake, client } = setup();
    fake.forced.push(401);
    expect((await code(client.list("example.com")))?.code).toBe("AUTH_REQUIRED");
  });
});
