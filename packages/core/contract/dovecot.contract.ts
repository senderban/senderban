import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterError, type OpaqueState } from "../src/adapter.js";
import type { BlockEntry, Blocklist } from "../src/blocklist.js";
import { SieveAdapter, initialSieveState } from "../src/sieve/adapter.js";
import type { SpamRule } from "../src/spam-filter.js";
import { hasInclude } from "../src/sieve/rules.js";
import { startDovecot, type Dovecot } from "./dovecot.js";

let dovecot: Dovecot;

beforeAll(async () => {
  dovecot = await startDovecot();
});
afterAll(() => {
  dovecot.stop();
});

const entry = (n: number, match: BlockEntry["match"], value: string): BlockEntry => ({
  id: `0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9d${String(n).padStart(2, "0")}`,
  match,
  value,
  action: "junk",
  createdAt: "2026-10-24T12:00:00.000Z",
});

const adapterFor = (user: string): SieveAdapter =>
  new SieveAdapter({ accountId: user, connect: () => dovecot.connect(user) });

async function sync(adapter: SieveAdapter, list: Blocklist, state: OpaqueState) {
  return (await adapter.apply(await adapter.plan(list, state))).state;
}

const mail = (from: string, envelopeFrom = from, subject = "hello") => ({
  from,
  envelopeFrom,
  subject,
});

describe("the spam rule on a real Sieve server", () => {
  const score = (...values: string[]) => values.map((value) => `X-Spam-Score: ${value}`);
  const scored = (subject: string, headers: string[]) => ({
    from: "bulk@example.org",
    envelopeFrom: "bulk@example.org",
    subject,
    headers,
  });

  it.each<[string, string[], "INBOX" | "Junk"]>([
    ["under the limit", score("4.9 (++++)"), "INBOX"],
    ["at the limit", score("5.0 (+++++)"), "Junk"],
    ["over the limit", score("9.1 (+++++++++)"), "Junk"],
    ["two digits", score("12.3 (++++++++++++)"), "Junk"],
    ["negative, as most clean mail is", score("-1.2 (-)"), "INBOX"],
    ["no score", [], "INBOX"],
    ["a word", score("high"), "INBOX"],
    ["a sender's own -1 beside a high score", score("-1.0", "9.1 (+++++++++)"), "Junk"],
    ["a sender's own -1 beside a low score", score("-1.2", "0.0"), "INBOX"],
    ["a blacklisted sender", score("100.0 (+)"), "Junk"],
    ["a decimal that looks like a hundred", score("1.6 (+)"), "INBOX"],
    ["a sender's own 99 beside a low score", score("99", "1.0 (+)"), "Junk"],
  ])("%s lands in the right place", async (name, headers, folder) => {
    const user = `spam-${name.replace(/[^a-z0-9]/gu, "")}@example.test`;
    const rule: SpamRule = { limit: 5, action: "junk" };
    const adapter = new SieveAdapter({
      accountId: user,
      connect: () => dovecot.connect(user),
      spamRule: () => rule,
    });
    await sync(adapter, [], initialSieveState());

    await dovecot.deliver(user, scored(name, headers));

    expect(dovecot.count(user, folder)).toBe(1);
  });

  it.each<[5 | 10 | 15, string, "INBOX" | "Junk"]>([
    [10, "5.0 (+)", "INBOX"],
    [10, "9.9 (+)", "INBOX"],
    [10, "10.0 (+)", "Junk"],
    [10, "23", "Junk"],
    [15, "9.0 (+)", "INBOX"],
    [15, "10.5 (+)", "INBOX"],
    [15, "14.9 (+)", "INBOX"],
    [15, "15.0 (+)", "Junk"],
    [15, "100.0 (+)", "Junk"],
    [15, "1.5 (+)", "INBOX"],
  ])("with limit %i, a score of %s lands in the right place", async (limit, value, folder) => {
    const user = `spam-${String(limit)}-${value.replace(/[^0-9]/gu, "")}@example.test`;
    const adapter = new SieveAdapter({
      accountId: user,
      connect: () => dovecot.connect(user),
      spamRule: () => ({ limit, action: "junk" }),
    });
    await sync(adapter, [], initialSieveState());

    await dovecot.deliver(user, scored(value, score(value)));

    expect(dovecot.count(user, folder)).toBe(1);
  });

  it("takes the rule out again with an empty list", async () => {
    const user = "spam-off@example.test";
    let rule: SpamRule | null = { limit: 5, action: "trash" };
    const adapter = new SieveAdapter({
      accountId: user,
      connect: () => dovecot.connect(user),
      spamRule: () => rule,
    });
    const state = await sync(adapter, [], initialSieveState());
    await dovecot.deliver(user, scored("on", score("9.1 (+)")));
    expect(dovecot.count(user, "Trash")).toBe(1);

    rule = null;
    await sync(adapter, [], state);
    await dovecot.deliver(user, scored("off", score("9.1 (+)")));
    expect(dovecot.count(user, "Trash")).toBe(1);
    expect(dovecot.count(user, "INBOX")).toBe(1);
  });
});

describe("ManageSieve client against Dovecot", () => {
  it("negotiates STARTTLS + PLAIN and reports the extensions our rules need", async () => {
    const session = await dovecot.connect("session@example.test");
    try {
      for (const ext of ["fileinto", "mailbox", "envelope", "include"]) {
        expect(session.extensions().has(ext), ext).toBe(true);
      }
      expect(await session.listScripts()).toEqual([]);
      expect(await session.getScript("missing")).toBeNull();
      expect(await session.haveSpace("x", 100)).toBe(true);
      await expect(session.putScript("bad", "this is not sieve;")).rejects.toMatchObject({
        code: "REJECTED",
      });

      // replace-by-name, CRLF on the wire, round trip
      await session.putScript("one", 'require "fileinto";\nkeep;\n');
      await session.putScript("one", "keep;\n");
      expect((await session.getScript("one"))?.replace(/\r\n/g, "\n")).toBe("keep;\n");
      await session.setActive("one");
      expect(await session.listScripts()).toEqual([{ name: "one", active: true }]);
    } finally {
      await session.close();
    }
  });

  it("maps a wrong password to AUTH_REQUIRED", async () => {
    const error = await dovecot.connect("session@example.test", "wrong").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("AUTH_REQUIRED");
  });
});

describe("SieveAdapter against Dovecot, mailbox without scripts", () => {
  const user = "clean@example.test";

  it("blocks by From header, by forged-From envelope sender, domain and subdomains; updates in place", async () => {
    const adapter = adapterFor(user);
    let state = await sync(
      adapter,
      [
        entry(1, "exactAddress", "spam@bad.example"),
        entry(2, "exactDomain", "exact.example"),
        entry(3, "subdomains", "tree.example"),
      ],
      initialSieveState(),
    );

    const session = await dovecot.connect(user);
    expect(await session.listScripts()).toEqual([
      { name: "senderban-main", active: true },
      { name: "senderban-rules", active: false },
    ]);
    await session.close();

    const inJunk = () => dovecot.count(user, "Junk");
    const inInbox = () => dovecot.count(user, "INBOX");

    await dovecot.deliver(user, mail("Spammer <spam@bad.example>", "bounce@relay.example"));
    expect([inJunk(), inInbox()]).toEqual([1, 0]);

    // header looks innocent, the server that sent it claimed the blocked envelope sender
    await dovecot.deliver(user, mail("friend@good.example", "SPAM@bad.example"));
    expect([inJunk(), inInbox()]).toEqual([2, 0]);

    // header forged to the blocked address, envelope honest
    await dovecot.deliver(user, mail("spam@bad.example", "bounce@relay.example"));
    expect([inJunk(), inInbox()]).toEqual([3, 0]);

    await dovecot.deliver(user, mail("x@exact.example"));
    await dovecot.deliver(user, mail("x@deep.tree.example"));
    await dovecot.deliver(user, mail("x@tree.example"));
    expect([inJunk(), inInbox()]).toEqual([6, 0]);

    // exactDomain must not reach subdomains; unrelated senders stay in the inbox
    await dovecot.deliver(user, mail("x@sub.exact.example"));
    await dovecot.deliver(user, mail("friend@good.example"));
    expect([inJunk(), inInbox()]).toEqual([6, 2]);

    // second apply replaces the rules script under the same name
    state = await sync(
      adapter,
      [entry(1, "exactAddress", "spam@bad.example"), entry(4, "exactAddress", "new@bad.example")],
      state,
    );
    await dovecot.deliver(user, mail("new@bad.example"));
    await dovecot.deliver(user, mail("x@exact.example"));
    expect([inJunk(), inInbox()]).toEqual([7, 3]);
    expect(await adapter.verify(state)).toMatchObject({ drifted: false });
  });
});

describe("SieveAdapter against Dovecot, user already has an active script", () => {
  const user = "existing@example.test";
  const userScript =
    'require ["fileinto", "mailbox"];\n# user rule\nif header :contains "subject" "invoice" {\n  fileinto :create "Bills";\n}\n';

  it("adds one include line, keeps the user's script active and working", async () => {
    const setup = await dovecot.connect(user);
    await setup.putScript("roundcube", userScript);
    await setup.setActive("roundcube");
    await setup.close();

    const adapter = adapterFor(user);
    const first = await sync(
      adapter,
      [entry(1, "exactAddress", "spam@bad.example")],
      initialSieveState(),
    );

    const session = await dovecot.connect(user);
    const scripts = await session.listScripts();
    expect(scripts.filter((s) => s.active).map((s) => s.name)).toEqual(["roundcube"]);
    const edited = (await session.getScript("roundcube")) ?? "";
    expect(hasInclude(edited, "senderban-rules")).toBe(true);
    expect(edited).toContain("# user rule");
    await session.close();

    await dovecot.deliver(user, mail("spam@bad.example", "spam@bad.example", "invoice"));
    expect([dovecot.count(user, "Junk"), dovecot.count(user, "Bills")]).toEqual([1, 0]);
    await dovecot.deliver(user, mail("shop@good.example", "shop@good.example", "your invoice"));
    expect([dovecot.count(user, "Junk"), dovecot.count(user, "Bills")]).toEqual([1, 1]);

    expect(await adapter.verify(first)).toMatchObject({ drifted: false });
    expect(first.data).toMatchObject({ includeBackup: { scriptName: "roundcube" } });

    // a later apply does not rewrite the user's script
    const before = edited;
    await sync(adapter, [], first);
    const again = await dovecot.connect(user);
    expect(await again.getScript("roundcube")).toBe(before);
    await again.close();
  });

  it("detects a removed include as drift", async () => {
    const drifter = "drift@example.test";
    const adapter = adapterFor(drifter);
    const state = await sync(adapter, [], initialSieveState());
    const session = await dovecot.connect(drifter);
    await session.putScript("senderban-main", "keep;\n");
    await session.close();
    expect(await adapter.verify(state)).toMatchObject({ drifted: true });
  });
});

describe("SieveAdapter.uninstall against Dovecot", () => {
  it("leaves the user's script as it was and stops blocking", async () => {
    const user = "uninstall@example.test";
    const original = 'require ["fileinto"];\n# user rule\nkeep;\n';
    const setup = await dovecot.connect(user);
    await setup.putScript("roundcube", original);
    await setup.setActive("roundcube");
    await setup.close();

    const adapter = adapterFor(user);
    const installed = await sync(
      adapter,
      [entry(1, "exactAddress", "spam@bad.example")],
      initialSieveState(),
    );
    await dovecot.deliver(user, mail("spam@bad.example"));
    expect(dovecot.count(user, "Junk")).toBe(1);

    await adapter.uninstall(installed);

    const session = await dovecot.connect(user);
    expect(await session.listScripts()).toEqual([{ name: "roundcube", active: true }]);
    expect((await session.getScript("roundcube"))?.replace(/\r\n/g, "\n")).toBe(original);
    await session.close();

    await dovecot.deliver(user, mail("spam@bad.example"));
    expect([dovecot.count(user, "Junk"), dovecot.count(user, "INBOX")]).toEqual([1, 1]);
  });

  it("removes our own main script when the user had none", async () => {
    const user = "uninstall-clean@example.test";
    const adapter = adapterFor(user);
    const installed = await sync(
      adapter,
      [entry(1, "exactDomain", "x.example")],
      initialSieveState(),
    );
    await adapter.uninstall(installed);
    const session = await dovecot.connect(user);
    expect(await session.listScripts()).toEqual([]);
    await session.close();
  });
});
