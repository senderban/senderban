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

/**
 * Rows read per UID asked for, at most. 5x, as `FETCH_SCAN_MAX` leaves the watcher: a server may add unasked FETCH rows for flag
 * changes, and one that streams without end is cut off here.
 */
const READ_SCAN_FACTOR = 5;

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
  /** A function, so the compiler does not assume the flag is still false after an await. */
  const limitHit = (): boolean => hooks.reading.oversized;
  return {
    canMove() {
      const mailbox = client.mailbox;
      if (mailbox === false || mailbox.readOnly === true) return false;
      const has = (name: string): boolean => client.capabilities.has(name);
      // MOVE, or COPY + UID EXPUNGE. Without UIDPLUS the library falls back to a plain EXPUNGE, which also deletes for good
      // anything else the person has marked \Deleted. RFC 9051 folds both into IMAP4rev2, but only a session that runs it has
      // them, and the library decides the same way (`isRev2Active`): a server may list rev2 beside rev1 and stay in rev1.
      const rev2 = client.enabled.has("IMAP4REV2") || (has("IMAP4rev2") && !has("IMAP4rev1"));
      return has("MOVE") || has("UIDPLUS") || rev2;
    },
    topUid() {
      return client.mailbox === false ? 0 : Math.max(0, client.mailbox.uidNext - 1);
    },
    uidValidity() {
      return client.mailbox === false ? "" : client.mailbox.uidValidity.toString();
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
      const asked = new Set(uids);
      const rows: CleanRow[] = [];
      let scanned = 0;
      // A limit hit here is about old mail: it must not make the watcher skip new mail (see `OpenHooks`).
      hooks.reading.old = true;
      hooks.reading.oversized = false;
      try {
        const stream = client.fetch(uidSet(uids), { uid: true, envelope: true }, { uid: true });
        for await (const row of reduceRows(stream)) {
          scanned += 1;
          // Only what was asked for: a server decides what it sends, not what is moved.
          if (row !== null && asked.has(row.uid)) rows.push({ uid: row.uid, from: row.from });
          if (scanned >= uids.length * READ_SCAN_FACTOR) break;
        }
      } catch (error) {
        // The stream only sees the connection close; what closed it arrives as an event on the same turn or the next.
        await new Promise((resolve) => setImmediate(resolve));
        if (isOversized(error) || limitHit()) {
          throw new UnreadableMailError("a mail is too large to read");
        }
        throw refused(error, "server refused to read the messages");
      } finally {
        hooks.reading.old = false;
      }
      // UIDs the search just found. An empty answer is a refusal the library does not raise, or mail gone meanwhile: either way, not "no match".
      if (scanned === 0)
        throw new AdapterError("TRANSIENT", "server returned none of the messages");
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
