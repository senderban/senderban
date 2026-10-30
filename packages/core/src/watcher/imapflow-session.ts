import { ImapFlow } from "imapflow";
import type { IncomingMessage, MailboxSession } from "./watcher.js";
import { FatalWatchError, toIncoming } from "./watcher.js";

// Not exported from index.ts, like the store: it pulls in a Node-only library.

/** RFC 2177: a server may drop an IDLE after 30 minutes, so restart well before. */
export const IDLE_RESTART_MS = 25 * 60_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const GREETING_TIMEOUT_MS = 15_000;
/** Past this the socket is closed without waiting for LOGOUT: imapflow's own inactivity timer would take 5 minutes. */
export const LOGOUT_TIMEOUT_MS = 5_000;
/** Messages fetched per `exists`. More than this in one gap means a burst; the watcher announces few anyway. */
export const FETCH_LIMIT = 200;
/**
 * Envelopes read from the server per fetch, at most. A server that streams without end (hostile or
 * broken) is cut off here instead of growing the main process; 5x the keep-limit leaves room for UID gaps.
 */
export const FETCH_SCAN_MAX = 1_000;

/**
 * First UID worth asking for: after `lastUid`, and no further back than the newest FETCH_LIMIT slots
 * below `uidNext`. Mail older than that would be dropped by the keep-limit anyway; asking for it only
 * costs a long envelope list after weeks offline. A stale `uidNext` is lower than the real one, so the
 * range only gets wider, never misses new mail.
 */
export function fetchStartUid(lastUid: number, uidNext: number): number {
  return Math.max(lastUid + 1, uidNext - FETCH_LIMIT);
}

/** Streams `rows`, keeps the newest `keep`, and stops reading after `scanMax` rows. Memory is O(keep). */
export async function keepNewest<T>(
  rows: AsyncIterable<T>,
  keep: number,
  scanMax: number,
): Promise<T[]> {
  const kept: T[] = [];
  let scanned = 0;
  for await (const row of rows) {
    kept.push(row);
    if (kept.length > keep) kept.shift();
    scanned += 1;
    if (scanned >= scanMax) break;
  }
  return kept;
}

export interface ImapConnection {
  readonly host: string;
  readonly port: number;
  /** true = implicit TLS (993). false = STARTTLS, which is required, never optional. */
  readonly secure: boolean;
  readonly user: string;
  /**
   * Decrypted by the caller just before connecting; never stored or logged here. A function is called for
   * every attempt, so one connector (and its refusal counter) can live as long as the account.
   */
  readonly password: string | (() => Promise<string>);
}

/** RFC 5530 s3: temporary refusals; AUTHENTICATIONFAILED (and no code) stay permanent. */
const TEMPORARY_REFUSAL_CODES: ReadonlySet<string> = new Set(["UNAVAILABLE", "INUSE"]);
/**
 * A server may answer a wrong password with a "temporary" code, so these retries are bounded: with
 * the watcher backoff (1 s base, 5 min cap) ten attempts last about 10 minutes, then the watcher halts
 * and the person is told, instead of logging in 12-24 times an hour for good.
 */
export const MAX_TEMPORARY_REFUSALS = 10;

function isCredentialRefusal(error: unknown): error is { serverResponseCode?: unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    "authenticationFailed" in error &&
    error.authenticationFailed === true
  );
}

function isTemporaryRefusal(error: unknown): boolean {
  if (!isCredentialRefusal(error)) return false;
  const code =
    typeof error.serverResponseCode === "string" ? error.serverResponseCode.toUpperCase() : "";
  return TEMPORARY_REFUSAL_CODES.has(code);
}

/** True only for a refusal of the credentials; a throttled or unavailable server is retried, not halted. */
export function isAuthFailure(error: unknown): boolean {
  return isCredentialRefusal(error) && !isTemporaryRefusal(error);
}

/**
 * Connects, opens INBOX read-only (EXAMINE: no flag side effects) and adapts ImapFlow to `MailboxSession`.
 * Create it once per account: it counts consecutive temporary refusals across attempts. When `signal`
 * aborts (the watcher gave up on the login) the socket is closed at once instead of living out imapflow's
 * own timeouts while its login slot is already reused.
 */
export function imapflowConnector(
  config: ImapConnection,
): (signal?: AbortSignal) => Promise<MailboxSession> {
  let temporaryRefusals = 0;
  return async (signal) => {
    signal?.throwIfAborted();
    const pass = typeof config.password === "function" ? await config.password() : config.password;
    signal?.throwIfAborted();
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      doSTARTTLS: config.secure ? undefined : true,
      auth: { user: config.user, pass },
      logger: false,
      maxIdleTime: IDLE_RESTART_MS,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
    });

    let existsListener: (() => void) | null = null;
    let closeListener: ((cause: Error | null) => void) | null = null;
    let lastError: Error | null = null;
    // Without an 'error' listener EventEmitter throws and takes the app down.
    client.on("error", (error: unknown) => {
      lastError = error instanceof Error ? error : new Error("imap error");
    });
    client.on("exists", () => existsListener?.());
    client.on("close", () => closeListener?.(lastError));

    const onAbort = (): void => {
      client.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await client.connect();
      signal?.throwIfAborted();
      const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
      signal?.throwIfAborted();
      // Without UIDNEXT the cursor would be NaN and every reconnect would fail the same way.
      if (!Number.isSafeInteger(mailbox.uidNext) || mailbox.uidNext < 1) {
        throw new FatalWatchError("server did not report UIDNEXT");
      }
      const openUidNext = mailbox.uidNext;
      temporaryRefusals = 0;

      return {
        uidValidity: mailbox.uidValidity.toString(),
        uidNext: openUidNext,
        async fetchSince(uid: number): Promise<IncomingMessage[]> {
          const out: IncomingMessage[] = [];
          const rows = await keepNewest(
            client.fetch(
              `${String(fetchStartUid(uid, openUidNext))}:*`,
              { uid: true, envelope: true, headers: ["x-spam-score"] },
              { uid: true },
            ),
            FETCH_LIMIT,
            FETCH_SCAN_MAX,
          );
          for (const row of rows) {
            const incoming = toIncoming(
              row.uid,
              row.envelope?.from?.[0]?.address,
              row.envelope?.subject,
              row.headers,
            );
            if (incoming !== null) out.push(incoming);
          }
          return out;
        },
        onExists(listener) {
          existsListener = listener;
        },
        onClose(listener) {
          closeListener = listener;
        },
        async close() {
          existsListener = null;
          closeListener = null;
          if (!client.usable) {
            client.close();
            return;
          }
          const timer = setTimeout(() => {
            client.close();
          }, LOGOUT_TIMEOUT_MS);
          try {
            await client.logout();
          } finally {
            clearTimeout(timer);
          }
        },
      };
    } catch (error) {
      client.close();
      // The watcher gave up on this login: its own deadline is the failure, not what the dying socket said.
      if (signal?.aborted === true) throw signal.reason;
      if (isAuthFailure(error)) {
        throw new FatalWatchError("authentication failed", { cause: error });
      }
      if (isTemporaryRefusal(error)) {
        temporaryRefusals += 1;
        if (temporaryRefusals >= MAX_TEMPORARY_REFUSALS) {
          throw new FatalWatchError("server keeps refusing the login as temporarily unavailable", {
            cause: error,
          });
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
