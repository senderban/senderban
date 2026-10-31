import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlockEntry, Blocklist } from "../src/blocklist.js";
import { ImapCleanAdapter, initialCleanState } from "../src/imap-clean/adapter.js";
import type { CleanEvent } from "../src/imap-clean/adapter.js";
import { cleanConnector } from "../src/imap-clean/imapflow-mailbox.js";
import { CleanLink } from "../src/imap-clean/session.js";
import { AccountWatcher } from "../src/watcher/watcher.js";
import type { Cursor, IncomingMessage } from "../src/watcher/watcher.js";
import { startDovecot, type Dovecot } from "./dovecot.js";

let dovecot: Dovecot;

beforeAll(async () => {
  dovecot = await startDovecot();
});
afterAll(() => {
  dovecot.stop();
});

const entry = (n: number, match: BlockEntry["match"], value: string): BlockEntry => ({
  id: `0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9e${String(n).padStart(2, "0")}`,
  match,
  value,
  action: "junk",
  createdAt: "2026-10-31T00:00:00.000Z",
});

interface Rig {
  readonly user: string;
  readonly adapter: ImapCleanAdapter;
  readonly link: CleanLink;
  readonly announced: IncomingMessage[];
  readonly events: CleanEvent[];
  sync(list: Blocklist): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
}

/** A real watcher and adapter on one connection, as `main.ts` wires them. */
async function rig(name: string): Promise<Rig> {
  const user = `${name}@example.test`;
  const link = new CleanLink();
  const events: CleanEvent[] = [];
  const announced: IncomingMessage[] = [];
  const cursors = new Map<string, Cursor>();
  let state = initialCleanState();
  const adapter = new ImapCleanAdapter({
    accountId: user,
    link,
    initialState: state,
    updateState: (change) => {
      state = change(state);
    },
    onClean: (event) => events.push(event),
  });
  const watcher = new AccountWatcher({
    accountId: user,
    connect: cleanConnector(
      {
        host: dovecot.imap.host,
        port: dovecot.imap.port,
        secure: true,
        user,
        password: dovecot.password,
        tls: { ca: dovecot.imap.ca, servername: "localhost" },
      },
      link,
    ),
    cursors: {
      get: (id) => cursors.get(id),
      set: (id, cursor) => cursors.set(id, cursor),
    },
    screen: (fresh) => adapter.screen(fresh),
    onMessage: (_, message) => announced.push(message),
  });
  watcher.start();
  await waitFor(() => watcher.current === "watching", "watching");
  return {
    user,
    adapter,
    link,
    announced,
    events,
    async sync(list) {
      state = (await adapter.apply(await adapter.plan(list, state))).state;
    },
    stop: () => watcher.stop(),
    async start() {
      watcher.start();
      await waitFor(() => watcher.current === "watching", "watching again");
    },
  };
}

async function waitFor(ok: () => boolean, what: string, ms = 15_000): Promise<number> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Date.now() - started;
}

const mail = (from: string, subject = "hello") => ({ from, envelopeFrom: from, subject });

describe("imap-clean against Dovecot", () => {
  it("moves a blocked sender's new mail to Junk within 5 s and announces the rest", async () => {
    const box = await rig("arrival");
    try {
      await box.sync([entry(1, "exactAddress", "spam@blocked.example")]);
      // The connection has been quiet for a moment, as a real one is between mails.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const started = Date.now();
      await dovecot.deliver(box.user, mail("spam@blocked.example"));
      await waitFor(() => dovecot.count(box.user, "Junk") === 1, "the mail in Junk", 5_000);
      const ms = Date.now() - started;
      console.log(`measured: blocked mail in Junk after ${String(ms)} ms`);
      expect(ms).toBeLessThanOrEqual(5_000);
      expect(dovecot.count(box.user, "INBOX")).toBe(0);

      await dovecot.deliver(box.user, mail("friend@friend.example"));
      await waitFor(() => box.announced.length === 1, "the announcement");
      expect(box.announced[0]?.from).toBe("friend@friend.example");
      expect(dovecot.count(box.user, "INBOX")).toBe(1);
    } finally {
      await box.stop();
    }
  });

  it("clears past mail when a rule is added: address, domain, subdomain, never a look-alike", async () => {
    const box = await rig("retro");
    try {
      for (const from of [
        "one@old.example",
        "two@wide.example",
        "three@deep.wide.example",
        "keep@notwide.example",
        '"one@old.example" <keep@friend.example>',
      ]) {
        await dovecot.deliver(box.user, {
          ...mail(from),
          envelopeFrom: from.startsWith('"') ? "keep@friend.example" : from,
        });
      }
      await waitFor(() => box.announced.length === 5, "five announcements");

      await box.sync([
        entry(2, "exactAddress", "one@old.example"),
        entry(3, "subdomains", "wide.example"),
      ]);
      expect(dovecot.count(box.user, "Junk")).toBe(3);
      expect(dovecot.count(box.user, "INBOX")).toBe(2);
      const retro = box.events.find((e) => e.kind === "retro");
      console.log(`measured: retro of 2 entries over 5 mails ${String(retro?.ms)} ms`);
      expect(retro).toMatchObject({ moved: 3, failed: 0, left: 0 });
    } finally {
      await box.stop();
    }
  });

  it("carries an address with IMAP specials in it as one search value", async () => {
    const box = await rig("specials");
    try {
      const odd = "a%b*c{5}+d@odd.example";
      await dovecot.deliver(box.user, mail(odd));
      await waitFor(() => box.announced.length === 1, "the announcement");
      await box.sync([entry(4, "exactAddress", odd)]);
      expect(dovecot.count(box.user, "Junk")).toBe(1);
    } finally {
      await box.stop();
    }
  });

  it("gives up on a mail too large to read, without skipping new mail or looping", async () => {
    const box = await rig("oversized");
    try {
      const pad = "x".repeat(5 * 1024 * 1024);
      await dovecot.deliver(box.user, {
        ...mail(`"${pad}" <huge@big.example>`),
        envelopeFrom: "huge@big.example",
      });
      // The watcher steps over it the way it always did, and comes back.
      await waitFor(() => box.link.current === null, "the connection to end", 10_000);
      await waitFor(() => box.link.current !== null, "the next session", 30_000);

      await box.sync([entry(6, "exactAddress", "huge@big.example")]);
      const retro = box.events.find((e) => e.kind === "retro");
      expect(retro).toMatchObject({ failed: 1, left: 1 });
      await waitFor(() => box.link.current !== null, "the session after it", 30_000);
      expect(dovecot.count(box.user, "INBOX")).toBe(1);
    } finally {
      await box.stop();
    }
  });

  it("goes back to moving after the connection comes back", async () => {
    const box = await rig("offline");
    await box.sync([entry(5, "exactDomain", "gone.example")]);
    await box.stop();
    expect(box.link.current).toBeNull();
    await dovecot.deliver(box.user, mail("x@gone.example"));
    expect(dovecot.count(box.user, "INBOX")).toBe(1);
    const held = { applied: [entry(5, "exactDomain", "gone.example")], retro: [] };
    const state = { adapterId: "imap-clean", data: held };
    expect((await box.adapter.verify(state)).drifted).toBe(true);

    // The mail that came in meanwhile is past the cursor, so the next session finds it.
    await box.start();
    await waitFor(() => dovecot.count(box.user, "Junk") === 1, "the mail in Junk");
    expect(dovecot.count(box.user, "INBOX")).toBe(0);
    expect((await box.adapter.verify(state)).drifted).toBe(false);
    await box.stop();
  });
});
