import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphBudgets, PendingBlocks, blockableDomain, createGate } from "@senderban/core";
import type { AccountConfig, MailToast, MicrosoftOAuthClient, OwnMail } from "@senderban/core";
import { Store, openDatabase } from "@senderban/core/store";
import { buildMicrosoftLanes } from "../src/microsoft-lanes.js";
import { createOutlookWatchers } from "../src/outlook-watchers.js";

const MINUTE = 60_000;
/** Joined here: a look-alike of a real domain is what this test is about, and the repository holds none as a word. */
const dot = (a: string, b: string): string => `${a}.${b}`;
const LINK = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=";
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const account = {
  id: "ms-1",
  microsoft: { email: "me@outlook.example", userId: "u1", refreshCipher: "aGVsbG8=" },
} as unknown as AccountConfig;

const entry = (id: string, address: string, subject = "WIN NOW") => ({
  id,
  receivedDateTime: new Date(NOW + 5_000).toISOString(),
  subject,
  from: { emailAddress: { name: "A Name", address } },
});

function setup(
  over: { own?: OwnMail; isOwn?: (a: string) => boolean; isQuiet?: (a: string) => boolean } = {},
) {
  const inbox: unknown[] = [];
  const answers: Response[] = [];
  const urls: string[] = [];
  let serial = 0;
  const fetch = vi.fn((url: string) => {
    urls.push(url);
    const forced = answers.shift();
    if (forced !== undefined) return Promise.resolve(forced);
    serial += 1;
    return Promise.resolve(
      Response.json({ value: inbox.splice(0), "@odata.deltaLink": `${LINK}${String(serial)}` }),
    );
  });
  const own = over.own ?? { domains: new Set<string>(), addresses: new Set<string>() };
  const store = new Store(openDatabase(":memory:"));
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    logs.push({ event, fields });
  };
  const budgets = new GraphBudgets();
  const { lanes } = buildMicrosoftLanes({
    accounts: [account],
    oauth: {
      refresh: () => Promise.resolve({ accessToken: "access", expiresInSeconds: 3_599 }),
    } as unknown as MicrosoftOAuthClient,
    budgets,
    saveState: () => undefined,
    decrypt: () => Promise.resolve("refresh"),
    saveRefreshToken: () => Promise.resolve(null),
    own: () => own,
    log,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const pending = new PendingBlocks();
  const shown: MailToast[] = [];
  const notices: { title: string; body: string }[] = [];
  const watchers = createOutlookWatchers({
    lanes,
    cursors: store.outlookCursors,
    gate: createGate(5),
    own: () => own,
    pending,
    showMail: (toast) => void shown.push(toast),
    notice: (title, body) => void notices.push({ title, body }),
    ...(over.isOwn === undefined ? {} : { isOwn: over.isOwn }),
    ...(over.isQuiet === undefined ? {} : { isQuiet: over.isQuiet }),
    labelOf: () => "me@outlook.example (Outlook)",
    onState: () => undefined,
    log,
    random: () => 0,
    now: Date.now,
  });
  return { inbox, answers, urls, fetch, store, logs, pending, shown, notices, watchers, lanes };
}

async function started(t: ReturnType<typeof setup>) {
  t.watchers.start();
  await tick(0);
  await tick(0);
}

describe("createOutlookWatchers", () => {
  it("offers both Junk and Trash, the domain, and comes back to the lane the engine knows", async () => {
    const t = setup();
    await started(t);
    t.inbox.push(entry("a", "Spam@News.Example.com"));
    await tick(2 * MINUTE);
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]).toMatchObject({
      sender: "spam@news.example.com",
      subject: "WIN NOW",
      account: "me@outlook.example (Outlook)",
      spamScore: null,
      domain: "news.example.com",
      rejectsAtServer: false,
    });
    expect(t.shown[0]?.trashOnly).toBeUndefined();
    expect(t.pending.consume(t.shown[0]?.id ?? "")).toEqual({
      status: "ok",
      block: { accountId: "ms-1.graph", sender: "spam@news.example.com" },
    });
    t.watchers.stop();
  });

  it("does not offer a domain the Outlook rule could not take", async () => {
    const own: OwnMail = { domains: new Set([dot("fabrikam", "com")]), addresses: new Set() };
    const sender = `x@${dot("fabrikam", "co")}`;
    expect(blockableDomain(sender, own)).toBe(dot("fabrikam", "co"));
    const t = setup({ own });
    await started(t);
    t.inbox.push(entry("a", sender));
    await tick(2 * MINUTE);
    expect(t.shown[0]?.domain).toBeNull();
    t.watchers.stop();
  });

  it("puts no Block button on a sender that cannot be read, and gives the subject on its own line", async () => {
    const t = setup();
    await started(t);
    t.inbox.push(entry("a", "/O=EXCHANGELABS/CN=Y", "Sign in to Microsoft again"));
    await tick(2 * MINUTE);
    expect(t.shown).toEqual([]);
    expect(t.notices[0]?.body).toContain("no Block button");
    expect(t.notices[0]?.body).toContain("\nSubject of the mail: “Sign in to Microsoft again”");
    t.watchers.stop();
  });

  it("puts no Block button on a mail that claims to be from the person", async () => {
    const t = setup({ isOwn: (a) => a === "me@outlook.example" });
    await started(t);
    t.inbox.push(entry("a", "me@outlook.example"));
    await tick(2 * MINUTE);
    expect(t.shown).toEqual([]);
    expect(t.notices[0]?.body).toContain("your own address");
    t.watchers.stop();
  });

  it("stays silent about a sender on the Don't ask again list", async () => {
    const t = setup({ isQuiet: () => true });
    await started(t);
    t.inbox.push(entry("a", "spam@news.example.com"));
    await tick(2 * MINUTE);
    expect(t.shown).toEqual([]);
    expect(t.notices).toEqual([]);
    t.watchers.stop();
  });

  it("logs no address and no subject", async () => {
    const t = setup();
    await started(t);
    t.inbox.push(entry("a", "spam@news.example.com", "secret subject"));
    await tick(2 * MINUTE);
    t.watchers.stop();
    const text = JSON.stringify(t.logs);
    expect(text).not.toContain("spam@");
    expect(text).not.toContain("secret subject");
    expect(text).not.toContain("me@outlook");
    expect(text).toContain("outlook-announce");
  });

  it("keeps its place across a restart", async () => {
    const t = setup();
    await started(t);
    t.watchers.stop();
    const first = t.urls[0] ?? "";
    expect(first).toContain("changeType=created");
    const cursor = t.store.outlookCursors.get("ms-1.graph");
    expect(cursor?.link.startsWith(LINK)).toBe(true);
    t.watchers.start();
    await tick(0);
    await tick(0);
    expect(t.urls.at(-1)).toBe(cursor?.link);
    t.watchers.stop();
  });

  it("tells the person when Microsoft refuses the sign-in, once, with what to do", async () => {
    const t = setup();
    t.answers.push(new Response("{}", { status: 401 }));
    await started(t);
    expect(t.notices).toEqual([
      {
        title: "Senderban stopped watching",
        body: "me@outlook.example (Outlook): Microsoft refused the sign-in. Sign in again under Accounts in Senderban, then restart it.",
      },
    ]);
  });

  it("says when Outlook slows the polls down, once an hour", async () => {
    const t = setup();
    await started(t);
    t.answers.push(new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    await tick(2 * MINUTE);
    expect(t.notices.filter((n) => n.body.includes("Outlook's limit"))).toHaveLength(1);
    t.watchers.stop();
  });

  it("forgets the account: no watcher, no cursor", async () => {
    const t = setup();
    await started(t);
    t.watchers.forget("ms-1.graph");
    expect(t.watchers.size).toBe(0);
    expect(t.store.outlookCursors.get("ms-1.graph")).toBeUndefined();
    const calls = t.fetch.mock.calls.length;
    await tick(10 * MINUTE);
    expect(t.fetch.mock.calls.length).toBe(calls);
  });
});
