import { ImapFlow } from "imapflow";
import type { IncomingMessage, MailboxSession } from "./watcher.js";
import { FatalWatchError, toIncoming } from "./watcher.js";

// Not exported from index.ts, like the store: it pulls in a Node-only library.

/** RFC 2177: a server may drop an IDLE after 30 minutes, so restart well before. */
export const IDLE_RESTART_MS = 25 * 60_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const GREETING_TIMEOUT_MS = 15_000;
/** Messages fetched per `exists`. More than this in one gap means a burst; the watcher announces few anyway. */
export const FETCH_LIMIT = 200;

export interface ImapConnection {
  readonly host: string;
  readonly port: number;
  /** true = implicit TLS (993). false = STARTTLS, which is required, never optional. */
  readonly secure: boolean;
  readonly user: string;
  /** Decrypted by the caller just before connecting; never stored or logged here. */
  readonly password: string;
}

function isAuthFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "authenticationFailed" in error &&
    error.authenticationFailed === true
  );
}

/** Connects, opens INBOX read-only (EXAMINE: no flag side effects) and adapts ImapFlow to `MailboxSession`. */
export function imapflowConnector(config: ImapConnection): () => Promise<MailboxSession> {
  return async () => {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      doSTARTTLS: config.secure ? undefined : true,
      auth: { user: config.user, pass: config.password },
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

    try {
      await client.connect();
      const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });

      return {
        uidValidity: mailbox.uidValidity.toString(),
        uidNext: mailbox.uidNext,
        async fetchSince(uid: number): Promise<IncomingMessage[]> {
          const out: IncomingMessage[] = [];
          const rows = await client.fetchAll(
            `${String(uid + 1)}:*`,
            { uid: true, envelope: true },
            { uid: true },
          );
          for (const row of rows.slice(-FETCH_LIMIT)) {
            const incoming = toIncoming(
              row.uid,
              row.envelope?.from?.[0]?.address,
              row.envelope?.subject,
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
          if (client.usable) await client.logout();
          else client.close();
        },
      };
    } catch (error) {
      client.close();
      if (isAuthFailure(error)) {
        throw new FatalWatchError("authentication failed", { cause: error });
      }
      throw error;
    }
  };
}
