import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loopbackRedirectUri, stateMatches } from "./pkce.js";
import type { LoopbackHostName } from "./pkce.js";

/**
 * How long the sign-in waits for the person to finish in the browser. Unit: milliseconds. PROVISIONAL (5 min):
 * long enough to read the provider's consent page and pick an account, short enough that a forgotten tab does not keep
 * a port open for the rest of the session.
 */
export const LOOPBACK_TIMEOUT_MS = 300_000;
/**
 * Requests that carry this sign-in's `state` the listener answers before it gives up. Unit: requests. A real
 * sign-in is one; 20 leaves room for a browser's retries. Requests without the state do not count (they cannot
 * end the sign-in), so a local process that hammers the port is bounded by the time limit instead.
 */
export const LOOPBACK_MAX_REQUESTS = 20;
/** What a caller may ask for. Unit: milliseconds and requests. Outside it is a bug, not a setting: a `setTimeout` past 2^31-1 ms fires at once. */
export const LOOPBACK_LIMITS = {
  timeoutMs: { min: 1, max: 3_600_000 },
  maxRequests: { min: 1, max: 1000 },
} as const;
/** One request must arrive within this. Unit: milliseconds. A local process holding a socket open cannot stall the sign-in. */
const REQUEST_TIMEOUT_MS = 10_000;
/** A real redirect is one short GET line and a few headers. Unit: bytes. */
const MAX_HEADER_BYTES = 8192;
/**
 * The same for `localhost`, where the code is long and a browser adds every cookie of that name (cookies are not port-scoped, so a developer's machine
 * may hold several KiB). Unit: bytes. It must hold MAX_CODE_BYTES and those.
 */
const LOCALHOST_HEADER_BYTES = 16_384;
/** Idle keep-alive sockets close at once: the listener answers one request per connection. Unit: milliseconds. */
const KEEP_ALIVE_TIMEOUT_MS = 1;
/** Google's authorization codes are at most 256 bytes (oauth2 page, "Token size", read 2026-10-26); printable ASCII. A provider with longer ones says so. */
const DEFAULT_CODE_BYTES = 256;
/** The longest code any provider may ask for: it must fit the request line under MAX_HEADER_BYTES. */
const MAX_CODE_BYTES = 6144;

export type LoopbackResult =
  | { readonly kind: "code"; readonly code: string }
  /** The person pressed "Cancel" or "Deny" on the provider's page (`error=access_denied`). */
  | { readonly kind: "denied" }
  /** The provider says someone else must approve this app first (`error=consent_required`). */
  | { readonly kind: "needs-approval" }
  | {
      readonly kind: "failed";
      /** Fixed words: nothing from the request is carried here. */
      readonly reason:
        "timeout" | "aborted" | "too-many-requests" | "provider-error" | "listener-error";
    };

export interface LoopbackOptions {
  /** The `state` this sign-in sent; only a request that carries it is believed. */
  readonly state: string;
  /** The name the provider redirects to; the listener binds 127.0.0.1 either way. */
  readonly hostName?: LoopbackHostName;
  /** The longest code this provider sends. Unit: bytes. */
  readonly maxCodeBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRequests?: number;
  readonly signal?: AbortSignal;
}

export interface Loopback {
  /** Where the provider sends the browser: `http://<hostName>:<port>`. */
  readonly redirectUri: string;
  readonly host: string;
  readonly port: number;
  /** Settles once: with the code, a denial, or a failure. The port is closed by then. */
  readonly result: Promise<LoopbackResult>;
  /** Closes the port now (a quit); the result becomes `aborted` if it had not settled. Safe to call again. */
  close(): void;
}

/** Microsoft can say "someone must approve" under `access_denied` too: its code is the one thing read from the description, and it goes no further (the same codes as graph/oauth.ts). */
const APPROVAL_CODE = /\bAADSTS(?:65001|90008|90094)\b/u;

// The answer page is static and loads nothing, so the code in this URL cannot leak through a Referer or a request.
const PAGE =
  "<!doctype html><html lang=en><meta charset=utf-8><title>Senderban</title>" +
  '<body style="font:16px system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem">' +
  "<h1>Senderban</h1><p>You can close this tab and go back to Senderban.</p></body></html>";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  Connection: "close",
} as const;

function reply(
  res: ServerResponse,
  status: number,
  body: string,
  type: string,
  written?: () => void,
): void {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
  if (written === undefined) {
    res.end(body);
    return;
  }
  // `end`'s callback does not fire when the browser drops the connection before the page is out; `close` does. Either
  // one releases the sign-in, so an approved code is not lost to a dropped socket.
  let called = false;
  const once = (): void => {
    if (called) return;
    called = true;
    written();
  };
  res.once("close", once);
  res.end(body, once);
}

/**
 * The one-shot listener for the provider's redirect (RFC 8252 §7.3 and §8.3: loopback, port open only for the request,
 * closed once the answer is in). It believes only a `GET /` with `Host` exactly `<hostName>:<port>` (a rebound DNS
 * name or a second origin cannot use it) and the `state` of this sign-in, compared in constant time. Anything else
 * gets a bare 400 that echoes nothing and the listener keeps waiting: a stray request from another program must not
 * end the sign-in, and cannot finish it. It stops on the first believed answer, at the time limit, after
 * `maxRequests` requests that carry the state, on abort and on `close()`.
 */
export async function startLoopback(options: LoopbackOptions): Promise<Loopback> {
  const maxRequests = options.maxRequests ?? LOOPBACK_MAX_REQUESTS;
  const timeoutMs = options.timeoutMs ?? LOOPBACK_TIMEOUT_MS;
  const hostName = options.hostName ?? "127.0.0.1";
  const maxCodeBytes = options.maxCodeBytes ?? DEFAULT_CODE_BYTES;
  if (!Number.isInteger(maxCodeBytes) || maxCodeBytes < 1 || maxCodeBytes > MAX_CODE_BYTES) {
    throw new RangeError("maxCodeBytes is out of range");
  }
  const codePattern = new RegExp(`^[\\x21-\\x7e]{1,${String(maxCodeBytes)}}$`, "u");
  const inRange = (value: number, range: { readonly min: number; readonly max: number }): boolean =>
    Number.isInteger(value) && value >= range.min && value <= range.max;
  if (!inRange(timeoutMs, LOOPBACK_LIMITS.timeoutMs)) {
    throw new RangeError("timeoutMs is out of range");
  }
  if (!inRange(maxRequests, LOOPBACK_LIMITS.maxRequests)) {
    throw new RangeError("maxRequests is out of range");
  }
  let settle: (result: LoopbackResult) => void = () => undefined;
  const result = new Promise<LoopbackResult>((resolve) => {
    settle = resolve;
  });
  let done = false;
  // The first believed answer is the only one: a second one arriving while the page is being written is refused.
  let answered = false;
  let requests = 0;
  let expectedHost = "";
  const maxHeaderSize = hostName === "localhost" ? LOCALHOST_HEADER_BYTES : MAX_HEADER_BYTES;
  const server: Server = createServer({ maxHeaderSize }, (req, res) => {
    handle(req, res);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  const finish = (outcome: LoopbackResult): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    server.close();
    // Idle keep-alive sockets would hold the port; the answer has already been written by now.
    server.closeIdleConnections();
    setImmediate(() => {
      server.closeAllConnections();
    });
    settle(outcome);
  };
  const onAbort = (): void => {
    finish({ kind: "failed", reason: "aborted" });
  };
  // Started with the server, cleared by `finish` (also when the port cannot be bound, below).
  const timer: NodeJS.Timeout = setTimeout(() => {
    finish({ kind: "failed", reason: "timeout" });
  }, timeoutMs);

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (done || answered) {
      reply(res, 400, "Bad request", "text/plain; charset=utf-8");
      return;
    }
    const bad = (): void => {
      reply(res, 400, "Bad request", "text/plain; charset=utf-8");
    };
    // `//host/path` is a valid request target for a proxy; here it is only ever a mistake or a probe.
    if (
      req.method !== "GET" ||
      req.headers.host !== expectedHost ||
      req.url === undefined ||
      !req.url.startsWith("/") ||
      req.url.startsWith("//")
    ) {
      bad();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      bad();
      return;
    }
    const received = url.searchParams.get("state");
    if (url.pathname !== "/" || received === null || !stateMatches(options.state, received)) {
      bad();
      return;
    }
    // Counted only here: a request that does not know the state is not the sign-in, so a local process hammering the
    // port cannot spend the cap and end the sign-in (it can still only be answered 400, within the time limit).
    requests += 1;
    if (requests > maxRequests) {
      reply(res, 400, "Bad request", "text/plain; charset=utf-8", () => {
        finish({ kind: "failed", reason: "too-many-requests" });
      });
      return;
    }
    const error = url.searchParams.get("error");
    if (error !== null) {
      answered = true;
      // The words are never shown: only whether the person said no, whether someone else must approve, or something else.
      reply(res, 200, PAGE, "text/html; charset=utf-8", () => {
        finish(
          error === "consent_required" ||
            APPROVAL_CODE.test(url.searchParams.get("error_description") ?? "")
            ? { kind: "needs-approval" }
            : error === "access_denied"
              ? { kind: "denied" }
              : { kind: "failed", reason: "provider-error" },
        );
      });
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null || !codePattern.test(code)) {
      bad();
      return;
    }
    answered = true;
    reply(res, 200, PAGE, "text/html; charset=utf-8", () => {
      finish({ kind: "code", code });
    });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    clearTimeout(timer);
    server.close();
    throw new Error("the listener has no TCP address");
  }
  const { port } = address satisfies AddressInfo;
  expectedHost = `${hostName}:${String(port)}`;
  // A listener that fails after it started has nobody to tell: it ends the sign-in instead of hanging.
  server.on("error", () => {
    finish({ kind: "failed", reason: "listener-error" });
  });
  if (options.signal?.aborted === true) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    redirectUri: loopbackRedirectUri(port, hostName),
    host: "127.0.0.1",
    port,
    result,
    close: onAbort,
  };
}
