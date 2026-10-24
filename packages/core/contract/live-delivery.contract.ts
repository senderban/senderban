import { writeFileSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import type { BlockEntry } from "../src/blocklist.js";
import { SieveAdapter, initialSieveState } from "../src/sieve/adapter.js";
import { connectManageSieve } from "../src/sieve/managesieve.js";

// Installs the generated rules on a REAL mailbox, waits for YOU to send one mail from the blocked
// address, reports where it landed, then uninstalls. Skipped unless the environment names a host.
//   SENDERBAN_LIVE_SIEVE_HOST, _USER, _PASSWORD, _SENDER (as in live-sieve.contract.ts)
const host = process.env["SENDERBAN_LIVE_SIEVE_HOST"];
const user = process.env["SENDERBAN_LIVE_SIEVE_USER"] ?? "";
const password = process.env["SENDERBAN_LIVE_SIEVE_PASSWORD"] ?? "";
const sender = process.env["SENDERBAN_LIVE_SIEVE_SENDER"] ?? "";

// PROVISIONAL bounds: how long to wait for the mail and how often to look.
const WAIT_MS = 300_000;
const POLL_MS = 10_000;

const entry: BlockEntry = {
  id: "0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9d01",
  match: "exactAddress",
  value: sender,
  action: "junk",
  createdAt: "2026-10-24T12:00:00.000Z",
};

const imapQuote = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Message counts of INBOX and Junk over IMAP (993, implicit TLS). One login per call. */
function imapCounts(imapHost: string): Promise<{ inbox: number; junk: number }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: imapHost, port: 993, servername: imapHost });
    const commands = [
      `a1 LOGIN ${imapQuote(user)} ${imapQuote(password)}`,
      'a2 STATUS "INBOX" (MESSAGES)',
      'a3 STATUS "Junk" (MESSAGES)',
      "a4 LOGOUT",
    ];
    const counts: number[] = [];
    let buffered = "";
    let next = 0; // index of the next command to send
    socket.setTimeout(15_000, () => {
      socket.destroy(new Error("IMAP timed out"));
    });
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (;;) {
        const end = buffered.indexOf("\r\n");
        if (end === -1) return;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const messages = /\(MESSAGES (\d+)\)/.exec(line);
        if (messages?.[1] !== undefined) counts.push(Number(messages[1]));
        if (line.startsWith("* OK") && next === 0) {
          socket.write(`${commands[next++] ?? ""}\r\n`);
        } else if (/^a\d (OK|NO|BAD)/.test(line)) {
          if (!/^a\d OK/.test(line)) {
            socket.destroy();
            reject(new Error(`IMAP command failed: ${line.slice(0, 40)}`));
            return;
          }
          const command = commands[next++];
          if (command !== undefined) socket.write(`${command}\r\n`);
          else {
            socket.end();
            resolve({ inbox: counts[0] ?? -1, junk: counts[1] ?? -1 });
            return;
          }
        }
      }
    });
  });
}

describe.skipIf(host === undefined)("live delivery with the generated rules", () => {
  const adapter = new SieveAdapter({
    accountId: user,
    connect: () => connectManageSieve({ host: host ?? "", username: user, password }),
  });
  let state = initialSieveState();

  afterAll(async () => {
    await adapter.uninstall(state).catch(() => undefined);
  });

  it("files a mail from the blocked sender into Junk", { timeout: WAIT_MS + 120_000 }, async () => {
    const before = await imapCounts(host ?? "");
    state = (await adapter.apply(await adapter.plan([entry], state))).state;
    expect(await adapter.verify(state)).toMatchObject({ drifted: false });
    // vitest buffers console output until the test ends, so the "send now" signal goes to a file
    const ready = process.env["SENDERBAN_LIVE_READY_FILE"];
    if (ready !== undefined) writeFileSync(ready, "READY");

    const deadline = Date.now() + WAIT_MS;
    let after = before;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      after = await imapCounts(host ?? "");
      if (after.inbox !== before.inbox || after.junk !== before.junk) break;
    }
    console.log(
      `RESULT: INBOX ${String(before.inbox)} -> ${String(after.inbox)}, Junk ${String(before.junk)} -> ${String(after.junk)}`,
    );
    expect(after.inbox).toBe(before.inbox);
    expect(after.junk).toBe(before.junk + 1);
  });
});
