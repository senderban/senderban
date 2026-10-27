import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailBudgets, PendingBlocks, createGate } from "@senderban/core";
import type { AccountConfig, MailToast, OAuthClient } from "@senderban/core";
import { Store, openDatabase } from "@senderban/core/store";
import { FakeGmail } from "../../../packages/core/test/gmail/fake-gmail.js";
import { buildGmailLanes } from "../src/gmail-lanes.js";
import {
  GMAIL_HEARTBEAT_MS,
  GMAIL_NOTICE_EVERY_MS,
  NOTICE_SUBJECT_MAX,
  createGmailWatchers,
  subjectLine,
} from "../src/gmail-watchers.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 27, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const account = (id: string, email: string) =>
  ({ id, gmail: { email, refreshCipher: "Y2lwaGVy" } }) as unknown as AccountConfig;

/** The real lane builder and watcher glue over a fake Gmail and an in-memory store; only the OS (toasts) is faked. */
function setup(
  ids: readonly string[] = ["g1"],
  random = () => 0,
  isHeld?: (laneId: string) => boolean,
  isOwn?: (address: string) => boolean,
) {
  const fake = new FakeGmail();
  const refresh = vi.fn(() =>
    Promise.resolve({ accessToken: fake.token, expiresInSeconds: 3_599 }),
  );
  const store = new Store(openDatabase(":memory:"));
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    logs.push({ event, fields });
  };
  const built = buildGmailLanes({
    accounts: ids.map((id) => account(id, `${id}@gmail.com`)),
    oauth: { refresh } as unknown as OAuthClient,
    budgets: new GmailBudgets(),
    saveState: () => undefined,
    decrypt: () => Promise.resolve("1//the-refresh-token"),
    log,
    fetch: fake.fetch,
  });
  const pending = new PendingBlocks();
  const shown: MailToast[] = [];
  const notices: { title: string; body: string }[] = [];
  const trayStates: [string, string][] = [];
  const watchers = createGmailWatchers({
    lanes: built.lanes,
    cursors: store.gmailCursors,
    gate: createGate(5),
    pending,
    showMail: (toast) => void shown.push(toast),
    notice: (title, body) => void notices.push({ title, body }),
    ...(isHeld === undefined ? {} : { isHeld }),
    ...(isOwn === undefined ? {} : { isOwn }),
    labelOf: (laneId) => `${laneId} (Gmail)`,
    onState: (laneId, state) => void trayStates.push([laneId, state]),
    log,
    random,
  });
  return { fake, refresh, store, logs, built, pending, shown, notices, trayStates, watchers };
}

async function started(t: ReturnType<typeof setup>) {
  t.watchers.start();
  await tick(0);
  await tick(0);
}

describe("createGmailWatchers: new mail", () => {
  it("announces a new message with only Move to Trash, no domain button, and a pending block on the Gmail lane", async () => {
    const t = setup();
    await started(t); // first poll: the cursor is taken from the mailbox
    t.fake.deliver({ from: "Spam Co <spam@news.example.com>", subject: "WIN NOW" });
    await tick(2 * MINUTE);

    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]).toMatchObject({
      sender: "spam@news.example.com",
      subject: "WIN NOW",
      account: "g1.gmail (Gmail)",
      spamScore: null,
      domain: null,
      rejectsAtServer: false,
      trashOnly: true,
    });
    // The click comes back to the lane that the engine knows, not to the bare account id.
    const lane = t.built.lanes[0];
    expect(lane).toBeDefined();
    const claimed = t.pending.consume(t.shown[0]?.id ?? "");
    expect(claimed).toEqual({
      status: "ok",
      block: { accountId: lane?.laneId, sender: "spam@news.example.com" },
    });
  });

  it("keeps the cursor in the store and does not announce the same mail again after a restart", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    await tick(2 * MINUTE);
    expect(t.shown).toHaveLength(1);
    const laneId = t.built.lanes[0]?.laneId ?? "";
    expect(t.store.gmailCursors.get(laneId)).toBe(String(t.fake.historyId));

    t.watchers.stop();
    t.watchers.start();
    await tick(2 * MINUTE);
    expect(t.shown).toHaveLength(1);
  });

  it("announces a message whose sender cannot be read safely without a Block button", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: ["a@x.example", "b@y.example"], subject: "two senders" });
    await tick(2 * MINUTE);
    expect(t.shown).toHaveLength(0);
    expect(t.pending.size).toBe(0);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]?.body).toContain("no Block button");
  });

  it("puts the mail's subject on a line of its own, labelled and quoted, so it cannot pass as a sentence of Senderban's", async () => {
    const t = setup();
    await started(t);
    const hostile = "Senderban: your Google sign-in expired, sign in again at http://evil.example";
    t.fake.deliver({ from: ["a@x.example", "b@y.example"], subject: hostile });
    await tick(2 * MINUTE);
    const body = t.notices[0]?.body ?? "";
    const lines = body.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("no Block button");
    expect(lines[0]).not.toContain("evil.example");
    expect(lines[1]).toBe(`Subject of the mail: “${hostile}”`);
  });

  it("cuts a long subject in the notice", () => {
    expect(subjectLine("")).toBe("");
    const line = subjectLine("x".repeat(500));
    expect(line).toBe(`\nSubject of the mail: “${"x".repeat(NOTICE_SUBJECT_MAX)}…”`);
  });

  it("announces a message that claims to come from the person's own address without a Block button", async () => {
    const t = setup(
      ["g1"],
      () => 0,
      undefined,
      (a) => a === "me@gmail.com",
    );
    await started(t);
    t.fake.deliver({ from: "me@gmail.com", subject: "forged?" });
    await tick(2 * MINUTE);
    expect(t.shown).toHaveLength(0);
    expect(t.pending.size).toBe(0);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]?.body).toContain("your own address");
    expect(JSON.stringify(t.logs)).not.toContain("me@gmail.com");
  });

  it("logs the domain and fixed words, never the address or the subject", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "secret.person@news.example.com", subject: "TOP SECRET SUBJECT" });
    await tick(2 * MINUTE);
    const text = JSON.stringify(t.logs);
    expect(text).not.toContain("secret.person");
    expect(text).not.toContain("TOP SECRET");
    expect(t.logs.find((l) => l.event === "gmail-announce")?.fields).toMatchObject({
      domain: "news.example.com",
    });
    expect(t.logs.some((l) => l.event === "gmail-poll")).toBe(true);
  });

  it("renews the access token once for the filter client and the mail client together", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    await tick(2 * MINUTE);
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("createGmailWatchers: what the person is told", () => {
  it("says it once an hour when Gmail forgot the cursor, and again after the hour", async () => {
    const t = setup();
    await started(t);
    // Gmail forgets everything up to now just before one poll (70 s: one poll at 50 s), then remembers again.
    const forgetOnce = async (): Promise<void> => {
      t.fake.deliver({ from: "a@x.example" });
      t.fake.oldestHistoryId = t.fake.historyId + 1;
      await tick(70 * SECOND);
      t.fake.oldestHistoryId = 0;
    };
    await forgetOnce();
    await forgetOnce();
    const gapNotices = () => t.notices.filter((n) => n.body.includes("lost track"));
    expect(gapNotices()).toHaveLength(1);
    expect(t.logs.filter((l) => l.event === "gmail-gap")).toHaveLength(2);

    await tick(GMAIL_NOTICE_EVERY_MS);
    await forgetOnce();
    expect(gapNotices()).toHaveLength(2);
  });

  it("stops and says so when Google refuses the sign-in", async () => {
    const t = setup();
    await started(t);
    t.fake.forcedFor.set("GET", [{ status: 401, body: { error: { status: "UNAUTHENTICATED" } } }]);
    await tick(2 * MINUTE);
    expect(t.trayStates.at(-1)).toEqual([t.built.lanes[0]?.laneId, "halted-auth"]);
    expect(t.notices.filter((n) => n.title === "Senderban stopped watching")).toHaveLength(1);
    expect(t.notices.at(-1)?.body).toContain("Sign in again");
  });

  it("says Gmail's limit was reached when it answers 429, once", async () => {
    const t = setup();
    await started(t);
    t.fake.forcedFor.set("GET", [
      { status: 429, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
    ]);
    await tick(2 * MINUTE);
    expect(t.notices.filter((n) => n.body.includes("limit"))).toHaveLength(1);
  });
});

describe("createGmailWatchers: lifecycle", () => {
  it("stopOne and startOne hold and free one account, the others keep polling", async () => {
    const t = setup(["g1", "g2"]);
    await started(t);
    const [one, two] = t.built.lanes.map((l) => l.laneId);
    t.watchers.stopOne(one ?? "");
    const before = t.fake.calls.length;
    await tick(5 * MINUTE);
    const polled = t.fake.calls.length - before;
    // Only g2 asks (about once a minute): five or six history calls, none from g1.
    expect(polled).toBeGreaterThanOrEqual(4);
    expect(polled).toBeLessThanOrEqual(7);
    t.watchers.startOne(one ?? "");
    expect(t.trayStates.filter(([id]) => id === two).at(-1)?.[1]).toBe("watching");
  });

  it("forget stops the watcher, drops it and deletes the cursor", async () => {
    const t = setup();
    await started(t);
    const laneId = t.built.lanes[0]?.laneId ?? "";
    expect(t.store.gmailCursors.get(laneId)).toBeDefined();
    t.watchers.forget(laneId);
    expect(t.store.gmailCursors.get(laneId)).toBeUndefined();
    expect(t.watchers.size).toBe(0);
    const before = t.fake.calls.length;
    await tick(10 * MINUTE);
    expect(t.fake.calls.length).toBe(before);
  });

  it("stop ends every poll and resumeNow after a stop does nothing", async () => {
    const t = setup(["g1", "g2"]);
    await started(t);
    t.watchers.stop();
    const before = t.fake.calls.length;
    t.watchers.resumeNow();
    await tick(10 * MINUTE);
    expect(t.fake.calls.length).toBe(before);
  });

  it("start leaves a lane that is held for a removal alone (an un-pause must not wake it)", async () => {
    const held = new Set<string>();
    const t = setup(
      ["g1", "g2"],
      () => 0,
      (id) => held.has(id),
    );
    const [one] = t.built.lanes.map((l) => l.laneId);
    held.add(one ?? "");
    t.watchers.start();
    await tick(0);
    await tick(0);
    expect(t.trayStates.filter(([id]) => id === one).map(([, s]) => s)).toEqual(["stopped"]);
    const callsBefore = t.fake.calls.length;
    await tick(5 * MINUTE);
    // Only g2 polled: g1 never made a request.
    expect(t.fake.calls.length).toBeGreaterThan(callsBefore);
    held.delete(one ?? "");
    t.watchers.start();
    await tick(0);
    expect(t.trayStates.filter(([id]) => id === one).at(-1)?.[1]).not.toBe("stopped");
  });

  it("writes a poll line only when something happened, not for a quiet minute", async () => {
    const t = setup();
    await started(t);
    await tick(5 * MINUTE);
    expect(t.logs.filter((l) => l.event === "gmail-poll")).toHaveLength(1); // the first run, which set the cursor
    t.fake.deliver({ from: "a@x.example" });
    await tick(2 * MINUTE);
    expect(t.logs.filter((l) => l.event === "gmail-poll")).toHaveLength(2);
  });

  it("writes no line for a quiet poll but one heartbeat an hour with the counts and how long ago the last good poll was", async () => {
    const t = setup();
    await started(t);
    await tick(GMAIL_HEARTBEAT_MS + 2 * MINUTE);
    const quietLines = t.logs.filter(
      (l) => l.event === "gmail-http" && l.fields["op"] === "history-list",
    );
    expect(quietLines).toHaveLength(0);
    const beats = t.logs.filter((l) => l.event === "gmail-heartbeat");
    expect(beats).toHaveLength(1);
    const fields = beats[0]?.fields ?? {};
    expect(fields["polls"]).toBeGreaterThan(55);
    expect(fields["polls"]).toBeLessThan(75);
    expect(fields["failed"]).toBe(0);
    expect(fields["found"]).toBe(0);
    expect(fields["state"]).toBe("watching");
    expect(fields["lastOkAgoS"]).toBeLessThan(90);
    expect(typeof fields["maxMs"]).toBe("number");
    expect(JSON.stringify(beats)).not.toContain("@");
  });

  it("counts the failed polls and the mails found in the hour's heartbeat", async () => {
    const t = setup();
    await started(t);
    t.fake.forcedFor.set("GET", [503]);
    await tick(3 * MINUTE);
    t.fake.deliver({ from: "a@x.example" });
    await tick(GMAIL_HEARTBEAT_MS);
    const beat = t.logs.find((l) => l.event === "gmail-heartbeat")?.fields ?? {};
    expect(beat["failed"]).toBe(1);
    expect(beat["found"]).toBe(1);
  });

  it("a failed poll keeps its line, and a stopped watcher writes no heartbeat (the silence is the signal)", async () => {
    const t = setup();
    await started(t);
    t.fake.forcedFor.set("GET", [503]);
    await tick(2 * MINUTE);
    const failed = t.logs.filter(
      (l) => l.event === "gmail-http" && l.fields["op"] === "history-list",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields["status"]).toBe(503);
    t.watchers.stop();
    await tick(GMAIL_HEARTBEAT_MS + 2 * MINUTE);
    expect(t.logs.filter((l) => l.event === "gmail-heartbeat")).toHaveLength(0);
  });

  it("a new mail for an account that was forgotten is never announced", async () => {
    const t = setup();
    await started(t);
    const laneId = t.built.lanes[0]?.laneId ?? "";
    t.watchers.forget(laneId);
    t.fake.deliver({ from: "a@x.example" });
    await tick(5 * MINUTE);
    expect(t.shown).toHaveLength(0);
  });
});
