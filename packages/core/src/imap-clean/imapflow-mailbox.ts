import type { ImapFlow } from "imapflow";
import { z } from "zod";
import { AdapterError } from "../adapter.js";
import { UnreadableMailError } from "../watcher/watcher.js";
import {
  imapflowConnector,
  isOversized,
  isTemporaryCommandRefusal,
  reduceRows,
  type ImapConnection,
  type OpenHooks,
} from "../watcher/imapflow-session.js";
import type { MailboxSession } from "../watcher/watcher.js";
import { RETRO_MAX_UIDS } from "./adapter.js";
import { CLEAN_UIDS_PER_COMMAND, CleanUid, FolderPath } from "./session.js";
import type { CleanFolders, CleanLink, CleanMailbox, CleanRow } from "./session.js";

// Not exported from index.ts, like the session it extends: it pulls in a Node-only library.

/** A server's answer to a SEARCH is outside input: a list longer than the range asked for, or a stray number, is not used. */
const Uids = z.array(CleanUid).max(RETRO_MAX_UIDS);

function checkedUids(found: unknown): number[] {
  const parsed = Uids.safeParse(found);
  if (!parsed.success) throw new AdapterError("TRANSIENT", "server sent a bad search answer");
  return parsed.data;
}

/** `1,2,3` for the wire. Sorted and joined plainly: at most CLEAN_UIDS_PER_COMMAND numbers, each one validated. */
function uidSet(uids: readonly number[]): string {
  return [...uids].sort((a, b) => a - b).join(",");
}

function folderOf(rows: Awaited<ReturnType<ImapFlow["list"]>>, use: string): string | null {
  const row = rows.find((r) => r.specialUse === use && !r.flags.has("\\Noselect"));
  if (row === undefined) return null;
  const path = FolderPath.safeParse(row.path);
  // Never the Inbox itself, whatever a server calls it: a move there would find the same mail again.
  if (!path.success || path.data.toUpperCase() === "INBOX") return null;
  return path.data;
}

/** The cleaning commands over the watcher's own client. */
export function cleanMailboxOf(client: ImapFlow, hooks: OpenHooks): CleanMailbox {
  /** A failure with the connection still up is the server saying no: for now when it says so (RFC 5530), else for good. */
  const refused = (error: unknown, what: string): unknown => {
    if (!client.usable) return error;
    const code = isTemporaryCommandRefusal(error) ? "TRANSIENT" : "REJECTED";
    return new AdapterError(code, what, { cause: error });
  };
  return {
    canMove() {
      const mailbox = client.mailbox;
      if (mailbox === false || mailbox.readOnly === true) return false;
      const has = (name: string): boolean => client.capabilities.has(name);
      // MOVE, or COPY + UID EXPUNGE. Without UIDPLUS the library falls back to a plain EXPUNGE, which also deletes for good
      // anything else the person has marked \Deleted.
      return has("MOVE") || has("IMAP4rev2") || has("UIDPLUS");
    },
    topUid() {
      return client.mailbox === false ? 0 : Math.max(0, client.mailbox.uidNext - 1);
    },
    async uidsSince(range, since) {
      return checkedUids(await client.search({ uid: range, since }, { uid: true }));
    },
    async searchFrom(range, needles) {
      const query =
        needles.length === 1
          ? { uid: range, from: needles[0] }
          : { uid: range, or: needles.map((from) => ({ from })) };
      return checkedUids(await client.search(query, { uid: true }));
    },
    async readFrom(uids) {
      if (uids.length > CLEAN_UIDS_PER_COMMAND) throw new RangeError("too many messages at once");
      const rows: CleanRow[] = [];
      // A limit hit here is about old mail: it must not make the watcher skip new mail (see `OpenHooks`).
      hooks.reading.old = true;
      try {
        const stream = client.fetch(uidSet(uids), { uid: true, envelope: true }, { uid: true });
        for await (const row of reduceRows(stream)) {
          if (row !== null) rows.push({ uid: row.uid, from: row.from });
        }
      } catch (error) {
        if (isOversized(error)) throw new UnreadableMailError("a mail is too large to read");
        throw error;
      } finally {
        hooks.reading.old = false;
      }
      return rows;
    },
    async folders(): Promise<CleanFolders> {
      try {
        const rows = await client.list({ listOnly: true });
        return { junk: folderOf(rows, "\\Junk"), trash: folderOf(rows, "\\Trash") };
      } catch (error) {
        throw refused(error, "server refused to list its folders");
      }
    },
    async createFolder(path) {
      try {
        await client.mailboxCreate(path);
      } catch (error) {
        throw refused(error, "server refused to create the folder");
      }
    },
    async move(uids, folder) {
      if (uids.length > CLEAN_UIDS_PER_COMMAND) throw new RangeError("too many messages at once");
      // `undefined` too, whatever the type says: the library's answer when no mailbox is selected.
      const done: unknown = await client.messageMove(uidSet(uids), folder, { uid: true });
      if (done !== false && done !== undefined) return;
      if (!client.usable) throw new Error("connection lost during a move");
      throw new AdapterError("REJECTED", "server refused to move the mail");
    },
    destroy() {
      client.close();
    },
  };
}

/** A watcher connection that may write, attached to `link` while it lives. Create once per account, like `imapflowConnector`. */
export function cleanConnector(
  config: ImapConnection,
  link: CleanLink,
): (signal?: AbortSignal) => Promise<MailboxSession> {
  return imapflowConnector({ ...config, writable: true }, (client, hooks) => {
    const box = cleanMailboxOf(client, hooks);
    client.on("close", () => {
      link.detach(box);
    });
    link.attach(box);
  });
}
