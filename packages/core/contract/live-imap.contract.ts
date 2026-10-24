import { describe, expect, it } from "vitest";
import { imapflowConnector } from "../src/watcher/imapflow-session.js";
import { AccountWatcher } from "../src/watcher/watcher.js";
import type { Cursor, IncomingMessage } from "../src/watcher/watcher.js";

// Read-only against a REAL mailbox: connects, EXAMINEs INBOX, reads envelopes. Never writes, never
// flags, never deletes. Skipped unless the environment names a host; credentials never go in the repo.
//   SENDERBAN_LIVE_IMAP_HOST, SENDERBAN_LIVE_IMAP_USER, SENDERBAN_LIVE_IMAP_PASSWORD
// Optional second test (waits for a mail YOU send to the account):
//   SENDERBAN_LIVE_IMAP_WAIT_S=120, SENDERBAN_LIVE_IMAP_EXPECT_FROM=<sender address>
const host = process.env["SENDERBAN_LIVE_IMAP_HOST"];
const user = process.env["SENDERBAN_LIVE_IMAP_USER"] ?? "";
const password = process.env["SENDERBAN_LIVE_IMAP_PASSWORD"] ?? "";
const waitSeconds = Number(process.env["SENDERBAN_LIVE_IMAP_WAIT_S"] ?? "0");
const expectFrom = process.env["SENDERBAN_LIVE_IMAP_EXPECT_FROM"] ?? "";

const connect = () =>
  imapflowConnector({ host: host ?? "", port: 993, secure: true, user, password })();

describe.skipIf(host === undefined)("live IMAP account (read-only)", () => {
  it("opens INBOX and returns validated envelopes", async () => {
    const started = Date.now();
    const session = await connect();
    const connectMs = Date.now() - started;
    try {
      expect(session.uidValidity).toMatch(/^\d+$/);
      expect(session.uidNext).toBeGreaterThan(0);

      const fetchStarted = Date.now();
      const all = await session.fetchSince(0);
      const fetchMs = Date.now() - fetchStarted;
      for (const m of all) {
        expect(m.uid).toBeGreaterThan(0);
        expect(m.from).toMatch(/^[^@\s]+@[^@\s]+$/);
        expect(m.subject.length).toBeLessThanOrEqual(200);
      }
      // Numbers only: no sender, no subject from the real mailbox is printed.
      console.log(
        `live-imap: connect+EXAMINE ${String(connectMs)} ms, fetch ${String(all.length)} envelopes ${String(fetchMs)} ms, uidNext ${String(session.uidNext)}`,
      );

      // A range past the end must still not announce anything (the n:* quirk).
      const none = await session.fetchSince(session.uidNext);
      expect(none.filter((m) => m.uid >= session.uidNext)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it.skipIf(waitSeconds <= 0)(
    "announces a mail delivered while the watcher is idling",
    async () => {
      let cursor: Cursor | undefined;
      const seen: IncomingMessage[] = [];
      const states: string[] = [];
      const watcher = new AccountWatcher({
        accountId: user,
        connect,
        cursors: {
          get: () => cursor,
          set: (_id, c) => {
            cursor = c;
          },
        },
        onMessage: (_id, m) => seen.push(m),
        onState: (_id, s) => states.push(s),
      });
      watcher.start();
      const ready = Date.now();
      while (watcher.current !== "watching" && Date.now() - ready < 30_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(watcher.current).toBe("watching");
      console.log(`live-imap: WATCHING since ${new Date().toISOString()}, send a mail now`);

      const deadline = Date.now() + waitSeconds * 1000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const latencyNote = seen.length > 0 ? `${String(Date.now() - ready)} ms after ready` : "none";
      await watcher.stop();
      console.log(
        `live-imap: announced ${String(seen.length)} (${latencyNote}); states ${states.join(">")}`,
      );
      expect(seen.length).toBeGreaterThan(0);
      if (expectFrom !== "") expect(seen[0]?.from).toBe(expectFrom.toLowerCase());
    },
    (waitSeconds + 60) * 1000,
  );
});
