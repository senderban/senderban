import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpaqueState } from "../src/adapter.js";
import type { BlockEntry } from "../src/blocklist.js";
import { SieveAdapter, initialSieveState, sieveStateForReinstall } from "../src/sieve/adapter.js";
import { normalizeNewlines } from "../src/sieve/rules.js";
import { imapflowConnector } from "../src/watcher/imapflow-session.js";
import { startDovecot, type Dovecot } from "./dovecot.js";

// What the app sees of a mail against what the server's Sieve sees of it, on the same server (2026-11-22).

let dovecot: Dovecot;

beforeAll(async () => {
  dovecot = await startDovecot();
});
afterAll(() => {
  dovecot.stop();
});

const blocked: BlockEntry = {
  id: "0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9f01",
  match: "subdomains",
  value: "spam.example",
  action: "trash",
  createdAt: "2026-01-05T10:00:00.000Z",
};

async function write(adapter: SieveAdapter, state: OpaqueState): Promise<OpaqueState> {
  const result = await adapter.apply(await adapter.plan([blocked], state));
  expect(result.failed).toEqual([]);
  return result.state;
}

const open = (user: string) =>
  imapflowConnector({
    host: dovecot.imap.host,
    port: dovecot.imap.port,
    secure: true,
    user,
    password: dovecot.password,
    tls: { ca: dovecot.imap.ca, servername: "localhost" },
  })();

describe("a From the app can read is a From the rule catches", () => {
  it.each([
    "Gabriella <g@spam.example>",
    "g@spam.example",
    "J. Right Co. <g@spam.example>",
    "Gabriéllá Ş <g@spam.example>",
    "=?UTF-8?Q?Gabri=C3=A9lla?= <g@spam.example>",
    "g@spam.example <g@spam.example>",
    "G <G@Spam.Example>",
    "G < g@spam.example >",
    "Gabriella @ Right <g@spam.example>",
    "[Right] Gabriella <g@spam.example>",
    "Gabriella (Right <g@spam.example>",
    '"Gabriella <g@spam.example>',
    "Gabriella, Right <g@spam.example>",
    "Right: Gabriella <g@spam.example>",
    "Gabriella <g@spam.example",
    "G <g@spam.example.>",
  ])("%s", async (from) => {
    const name = createHash("sha256").update(from).digest("hex").slice(0, 16);
    const user = `from-${name}@example.test`;
    const adapter = new SieveAdapter({ accountId: user, connect: () => dovecot.connect(user) });
    // Read first, with no rule in the way; then the same mail again with the rule written.
    await dovecot.deliver(user, { from, envelopeFrom: "bounce@esp.example", subject: "one" });
    const session = await open(user);
    const rows = await session.fetchSince(0);
    await session.close();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Never lost: it is announced with its sender, or announced with nothing to click.
    expect(row?.subject).toBe("one");
    if (row?.from !== null) {
      expect(row?.from).toBe("g@spam.example");
      expect(Math.abs(Date.now() - (row?.deliveredAt ?? 0))).toBeLessThan(120_000);
    }
    await write(adapter, initialSieveState());
    await dovecot.deliver(user, { from, envelopeFrom: "bounce@esp.example", subject: "two" });
    if (row?.from !== null) expect(dovecot.count(user, "Trash")).toBe(1);
  });
});

describe("rules another program switched off", () => {
  it("are seen by a read-back as exactly that, and come back with one round", async () => {
    const user = "switched-off@example.test";
    const adapter = new SieveAdapter({ accountId: user, connect: () => dovecot.connect(user) });
    const state = await write(adapter, initialSieveState());
    expect((await adapter.verify(state)).drifted).toBe(false);

    const other = await dovecot.connect(user);
    await other.putScript("webmail", "# made by webmail\nkeep;\n");
    await other.setActive("webmail");
    await other.close();
    await dovecot.deliver(user, {
      from: "g@spam.example",
      envelopeFrom: "g@spam.example",
      subject: "leak",
    });
    expect(dovecot.count(user, "INBOX")).toBe(1);

    const drift = await adapter.verify(state);
    expect(drift.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["include-active"]);
    // With nothing to change there is no round, so nothing would ever notice: the reason for the repair.
    expect((await adapter.plan([blocked], state)).changes).toEqual([]);

    const repaired = await write(adapter, sieveStateForReinstall(state));
    expect((await adapter.verify(repaired)).drifted).toBe(false);
    await dovecot.deliver(user, {
      from: "g@spam.example",
      envelopeFrom: "g@spam.example",
      subject: "caught",
    });
    expect(dovecot.count(user, "INBOX")).toBe(1);
    expect(dovecot.count(user, "Trash")).toBe(1);
    // The other program's own script is still the active one, with its own lines.
    const session = await dovecot.connect(user);
    expect((await session.listScripts()).find((s) => s.active)?.name).toBe("webmail");
    expect(await session.getScript("webmail")).toContain("# made by webmail");
    await session.close();
  });
});

describe("a main script the person edited", () => {
  // Their own rule beside our marker, our include switched off: what a person does by hand in a webmail's script editor.
  const edited =
    'require ["include", "fileinto", "mailbox"];\n# senderban-managed\n# include :personal "senderban-rules";\nif header :contains "subject" "invoice" {\n  fileinto :create "Bills";\n}\n';

  it("is told apart, keeps every line through a block, and comes back whole on removal", async () => {
    const user = "edited-main@example.test";
    const adapter = new SieveAdapter({ accountId: user, connect: () => dovecot.connect(user) });
    const state = await write(adapter, initialSieveState());
    const session = await dovecot.connect(user);
    await session.putScript("senderban-main", edited);
    const drift = await adapter.verify(state);
    expect(drift.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["main-edited"]);

    const next = await write(adapter, sieveStateForReinstall(state));
    expect((await adapter.verify(next)).drifted).toBe(false);
    await dovecot.deliver(user, {
      from: "g@spam.example",
      envelopeFrom: "g@spam.example",
      subject: "caught",
    });
    await dovecot.deliver(user, {
      from: "shop@ok.example",
      envelopeFrom: "shop@ok.example",
      subject: "invoice 1",
    });
    expect(dovecot.count(user, "Trash")).toBe(1);
    expect(dovecot.count(user, "Bills")).toBe(1);
    expect(dovecot.count(user, "INBOX")).toBe(0);

    await adapter.uninstall(next);
    // The server stores CRLF.
    expect(normalizeNewlines((await session.getScript("senderban-main")) ?? "")).toBe(edited);
    const left = await session.listScripts();
    expect(left.find((s) => s.active)?.name).toBe("senderban-main");
    expect(left.some((s) => s.name === "senderban-rules")).toBe(false);
    await session.close();
  });

  it("with no script active a read-back says so, and only reads", async () => {
    const user = "none-active@example.test";
    const adapter = new SieveAdapter({ accountId: user, connect: () => dovecot.connect(user) });
    const state = await write(adapter, initialSieveState());
    const session = await dovecot.connect(user);
    await session.setActive("");
    const drift = await adapter.verify(state);
    expect(drift.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["none-active"]);
    expect((await session.listScripts()).some((s) => s.active)).toBe(false);
    await session.close();
  });
});
