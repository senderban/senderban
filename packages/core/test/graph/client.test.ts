import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import {
  GRAPH_LIST_MAX_BYTES,
  GRAPH_LIST_MAX_PAGES,
  GRAPH_MAX_STRINGS_IN_REQUEST,
  GRAPH_RETRY_AFTER_MAX_S,
  GRAPH_RULES_URL,
  RuleRefusedError,
  RuleSpaceError,
  createGraphClient,
} from "../../src/graph/client.js";
import type { GraphCall } from "../../src/graph/client.js";
import { ACCESS, FakeGraph } from "./fake-graph.js";

const NAME = "Senderban 0123456789abcdef";

function rig(now: { value: number } = { value: 0 }) {
  const fake = new FakeGraph();
  const calls: GraphCall[] = [];
  const client = createGraphClient({
    getAccessToken: () => Promise.resolve(ACCESS),
    fetch: fake.fetch,
    now: () => now.value,
    onCall: (call) => {
      calls.push(call);
    },
  });
  return { fake, client, calls, now };
}
const rule = {
  displayName: NAME,
  conditions: { fromAddresses: ["a@spam.example"] },
  action: { delete: true },
} as const;

describe("graph client", () => {
  it("sends the documented create and follows no redirect", async () => {
    const { fake, client } = rig();
    const created = await client.create(rule);
    const call = fake.calls[0];
    expect(call?.url).toBe(GRAPH_RULES_URL);
    expect(call?.redirect).toBe("error");
    expect(JSON.parse(call?.body ?? "")).toEqual({
      displayName: NAME,
      sequence: 1,
      isEnabled: true,
      conditions: { fromAddresses: [{ emailAddress: { address: "a@spam.example" } }] },
      actions: { delete: true, stopProcessingRules: true },
    });
    expect(created.displayName).toBe(NAME);
  });

  it("encodes a rule id into the path", async () => {
    const { fake, client } = rig();
    const created = await client.create(rule);
    await client.remove(created.id);
    expect(fake.calls[1]?.url).toBe(`${GRAPH_RULES_URL}/${encodeURIComponent(created.id)}`);
  });

  it("refuses what must not leave: a foreign name, an empty or oversized condition, a control character", async () => {
    const { fake, client } = rig();
    await expect(client.create({ ...rule, displayName: "x" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    for (const fromAddresses of [
      [],
      Array.from({ length: GRAPH_MAX_STRINGS_IN_REQUEST + 1 }, () => "a@spam.example"),
      ["a\r\n@spam.example"],
      [`${"a".repeat(255)}@x`],
    ]) {
      await expect(client.update("id", { fromAddresses })).rejects.toMatchObject({
        code: "REJECTED",
      });
    }
    await expect(client.remove("..")).rejects.toMatchObject({ code: "REJECTED" });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "AUTH_REQUIRED"],
    [429, "QUOTA_EXCEEDED"],
    [500, "TRANSIENT"],
    [503, "TRANSIENT"],
    [404, "REJECTED"],
  ])("maps %i to %s, with a fixed text that quotes nothing", async (status, code) => {
    const { fake, client } = rig();
    fake.forced.set("GET", [status]);
    const failure = await client.junkFolderId().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).code).toBe(code);
    expect((failure as AdapterError).message).not.toContain("secret words");
  });

  it("tells a rule that may be too big from a mailbox with no room", async () => {
    const { fake, client } = rig();
    fake.forced.set("POST", [
      { status: 400 },
      { status: 413 },
      { status: 507 },
      { status: 400, body: { error: { code: "ErrorRuleQuotaExceeded" } } },
    ]);
    await expect(client.create(rule)).rejects.toBeInstanceOf(RuleRefusedError);
    await expect(client.create(rule)).rejects.toBeInstanceOf(RuleRefusedError);
    await expect(client.create(rule)).rejects.toBeInstanceOf(RuleSpaceError);
    await expect(client.create(rule)).rejects.toBeInstanceOf(RuleSpaceError);
  });

  it("stays quiet for the Retry-After of a 429, then asks again", async () => {
    const { fake, client, now } = rig();
    fake.forced.set("GET", [{ status: 429, headers: { "retry-after": "10" } }]);
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    now.value = 9_999;
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(fake.calls).toHaveLength(1);
    now.value = 10_000;
    await expect(client.list()).resolves.toBeDefined();
    expect(fake.calls).toHaveLength(2);
  });

  it("honours a 503's Retry-After too, in the HTTP-date form, and caps it", async () => {
    const { fake, client, now } = rig();
    const date = new Date(now.value + 30_000).toUTCString();
    fake.forced.set("GET", [{ status: 503, headers: { "retry-after": date } }]);
    await expect(client.list()).rejects.toMatchObject({ code: "TRANSIENT" });
    now.value = 29_000;
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    now.value = 31_000;
    fake.forced.set("GET", [{ status: 429, headers: { "retry-after": "999999" } }]);
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    now.value += GRAPH_RETRY_AFTER_MAX_S * 1_000;
    await expect(client.list()).resolves.toBeDefined();
  });

  it("backs off without a Retry-After, or with one it cannot read", async () => {
    const { fake, client, now } = rig();
    fake.forced.set("GET", [{ status: 429, headers: { "retry-after": "soon" } }]);
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    now.value = 29_000;
    await expect(client.list()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(fake.calls).toHaveLength(1);
  });

  it("logs one line per request: the operation, the status and the time", async () => {
    const { fake, client, calls } = rig();
    fake.failNetwork = 1;
    await expect(client.list()).rejects.toMatchObject({ code: "TRANSIENT" });
    await client.list();
    expect(calls.map((c) => [c.op, c.status])).toEqual([
      ["rule-list", null],
      ["rule-list", 200],
    ]);
  });

  it("counts a rule it cannot read and goes on with the others", async () => {
    const { fake, client } = rig();
    fake.forced.set("GET", [
      {
        status: 200,
        body: {
          value: [
            { id: "one", displayName: NAME },
            { id: "two", displayName: 5 },
          ],
        },
      },
    ]);
    const list = await client.list();
    expect(list.rules.map((r) => r.id)).toEqual(["one"]);
    expect(list.unreadable).toBe(1);
  });

  it("follows a next link on Graph's own host and version, and no other", async () => {
    const { fake, client } = rig();
    const next =
      "https://graph.microsoft.com/v1.0/users('me')/mailFolders('inbox')/messageRules?%24skip=1";
    fake.forced.set("GET", [
      { status: 200, body: { value: [{ id: "one" }], "@odata.nextLink": next } },
      { status: 200, body: { value: [{ id: "two" }] } },
    ]);
    expect((await client.list()).rules.map((r) => r.id)).toEqual(["one", "two"]);
    expect(fake.calls[1]?.url).toBe(next);

    fake.calls.length = 0;
    for (const link of [
      "https://attacker.example/rules",
      "http://graph.microsoft.com/v1.0/rules",
      "https://graph.microsoft.com.attacker.example/v1.0/rules",
      "https://user@graph.microsoft.com/v1.0/rules",
      "https://graph.microsoft.com/beta/rules",
    ]) {
      fake.calls.length = 0;
      fake.forced.set("GET", [{ status: 200, body: { value: [], "@odata.nextLink": link } }]);
      await expect(client.list()).rejects.toMatchObject({ code: "TRANSIENT" });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("ends a list that never ends", async () => {
    const { fake, client } = rig();
    const next = `${GRAPH_RULES_URL}?$skip=1`;
    fake.forced.set(
      "GET",
      Array.from({ length: GRAPH_LIST_MAX_PAGES + 1 }, () => ({
        status: 200,
        body: { value: [], "@odata.nextLink": next },
      })),
    );
    await expect(client.list()).rejects.toMatchObject({ code: "REJECTED" });
    expect(fake.calls).toHaveLength(GRAPH_LIST_MAX_PAGES);
  });

  it("refuses a list too large to read for good, never reads half of it", async () => {
    const { fake, client } = rig();
    fake.forced.set("GET", [
      { status: 200, headers: { "content-length": String(GRAPH_LIST_MAX_BYTES + 1) } },
    ]);
    await expect(client.list()).rejects.toThrow("larger than Senderban reads");
  });

  it("treats a malformed answer as passing, not as an empty list", async () => {
    const { fake, client } = rig();
    fake.forced.set("GET", [{ status: 200, body: { value: "no" } }]);
    await expect(client.list()).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("answers gone for a rule that went away", async () => {
    const { client } = rig();
    await expect(client.remove("missing")).resolves.toBe("gone");
    await expect(client.update("missing", { senderContains: ["@x.example"] })).resolves.toBe(
      "gone",
    );
  });

  it("refuses a token that cannot go into a header", async () => {
    const fake = new FakeGraph();
    const client = createGraphClient({
      getAccessToken: () => Promise.resolve("a b\r\nX: y"),
      fetch: fake.fetch,
    });
    await expect(client.list()).rejects.toMatchObject({ code: "REJECTED" });
    expect(fake.calls).toEqual([]);
  });
});
