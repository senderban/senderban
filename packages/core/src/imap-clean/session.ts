import { z } from "zod";

/** Unit: UIDs in one UID MOVE or UID FETCH. 200 UIDs of 10 digits stay under the 8,000 octets RFC 7162 §4 tells clients to keep a command to. */
export const CLEAN_UIDS_PER_COMMAND = 200;
/** Unit: mail folder path characters. No limit is standardised; Dovecot refuses a name past 255 per level, so 16 levels of that stand here. */
export const FOLDER_PATH = { min: 1, max: 4096 } as const;
/** RFC 3501 §2.3.1.1: a UID is an unsigned 32-bit number. */
export const UID_MAX = 4_294_967_295;

/** A UID as a server reports it. The server is outside the boundary, so a stray number is refused, not used. */
export const CleanUid = z.number().int().min(1).max(UID_MAX);
/** A folder path as a server reports it: bounded, and no control character can reach a command. */
export const FolderPath = z
  .string()
  .min(FOLDER_PATH.min)
  .max(FOLDER_PATH.max)
  .regex(/^[^\p{Cc}]+$/u);

export interface CleanFolders {
  /** Null when the server has no such folder yet: the adapter creates it when it first needs it. */
  readonly junk: string | null;
  readonly trash: string | null;
}

/** One message's sender, as `toIncoming` validates it. A message with no usable From has no row. */
export interface CleanRow {
  readonly uid: number;
  readonly from: string;
}

/**
 * The commands the cleaning needs on the connection the watcher already holds (architecture: no second IMAP connection per
 * account). Every UID goes in and out as a number, and every address as a search value the library quotes.
 */
export interface CleanMailbox {
  /** The session may write, and the server can take mail out by UID: MOVE (RFC 6851) or UID EXPUNGE (RFC 4315). */
  canMove(): boolean;
  /** Highest UID that existed when the mailbox was last told about; 0 for an empty one. */
  topUid(): number;
  /** What the UIDs of this session mean (RFC 9051 §2.3.1.1): a position saved under another value says nothing here. */
  uidValidity(): string;
  /** UIDs of `range` that arrived on or after `since`, by the server's arrival date (SINCE). */
  uidsSince(range: string, since: Date): Promise<number[]>;
  /** UIDs of `range` whose From header contains one of `needles`. A substring match: rows must be checked with `readFrom`. */
  searchFrom(range: string, needles: readonly string[]): Promise<number[]>;
  /** The senders of these messages, at most CLEAN_UIDS_PER_COMMAND. */
  readFrom(uids: readonly number[]): Promise<CleanRow[]>;
  folders(): Promise<CleanFolders>;
  createFolder(path: string): Promise<void>;
  /**
   * Moves these UIDs out of the Inbox, at most CLEAN_UIDS_PER_COMMAND. Throws `AdapterError` when the server refused, and a plain
   * error when the connection went.
   */
  move(uids: readonly number[], folder: string): Promise<void>;
  /** Drops the connection now: a round the engine gave up on must not write after a newer one. */
  destroy(): void;
}

/**
 * Where the adapter finds the watcher's connection. The connector attaches a mailbox when a session opens and detaches it when
 * that session closes; `null` means nothing can be moved right now (paused, offline, wrong password).
 */
export class CleanLink {
  /** Open sessions, newest last. Two at most for a moment: a login that finishes after its replacement is closed at once. */
  readonly #boxes: CleanMailbox[] = [];
  #onOpen: (() => void) | null = null;

  get current(): CleanMailbox | null {
    return this.#boxes.at(-1) ?? null;
  }

  /** Called on every new session: a round that found the mailbox away has work to catch up on. */
  onOpen(listener: () => void): void {
    this.#onOpen = listener;
  }

  attach(box: CleanMailbox): void {
    this.#boxes.push(box);
    this.#onOpen?.();
  }

  /** Takes this session away, whichever it is: an old one that closes late leaves the newer one in place. */
  detach(box: CleanMailbox): void {
    const at = this.#boxes.indexOf(box);
    if (at >= 0) this.#boxes.splice(at, 1);
  }
}
