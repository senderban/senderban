/**
 * In-memory stand-in for `users.settings.filters`, with the answers measured live (2026-10-26, ADR 0009 "Measured live"):
 * create 200 with the filter, delete 204, `SPAM` in `addLabelIds` 400, a query of 28,003 characters 500, a list with no
 * filters has no `filter` key. Counts the quota units Google charges (list 1, create 5, delete 5) per call.
 */
export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | null | undefined;
  readonly redirect: string | undefined;
}

export interface FakeFilter {
  id: string;
  criteria: Record<string, unknown>;
  action: Record<string, unknown>;
}

export const UNITS = { list: 1, create: 5, delete: 5 } as const;
/** Quota units Google charges for reading mail (read 2026-10-26, not measured): `getProfile` 1, `history.list` 2, `messages.get` 20. */
export const MAIL_UNITS = { profile: 1, history: 2, message: 20 } as const;

export interface FakeMessage {
  readonly id: string;
  labelIds: string[];
  headers: { name: string; value: string }[];
}
/** The measured wall: accepted at 14,003 characters, a 500 at 28,003; the fake puts its limit between. */
const QUERY_WALL = 20_000;

export class FakeGmail {
  readonly filters = new Map<string, FakeFilter>();
  readonly calls: RecordedCall[] = [];
  /** Quota units charged so far. */
  units = 0;
  /** Forced answers for the next requests, consumed one per request: a status, or a status with a JSON body. */
  readonly forced: (number | { status: number; body: unknown })[] = [];
  /** Forced answers for the next requests of one method only (`POST`, `DELETE`, `GET`), consumed one per request; `"pass"` lets that one request through. */
  readonly forcedFor = new Map<string, (number | "pass" | { status: number; body: unknown })[]>();
  /** The next POSTs create the filter and then answer this status: an answer that was lost on its way back. */
  createThenFail: number[] = [];
  /** Makes the next requests throw like a network failure. */
  failNetwork = 0;
  /** Resolves before the answer is built, so a test can hold a request open. */
  hold: Promise<void> | null = null;
  /** Holds every request after this many calls have been made (a round whose later calls hang). */
  holdFromCall: number | null = null;
  /** Replaces the body of the next list answer. */
  listBody: string | null = null;
  /** Headers of the next list answer (for example a `content-length` the body does not match). */
  listHeaders: Record<string, string> = {};
  /** Runs inside the next POST before it is checked: another actor (the person, another device) writing at that moment. */
  beforeCreate: (() => void) | null = null;
  /** Mail (read side): messages by id, the history of INBOX additions, and the mailbox's current historyId. Shapes read from the docs, not yet seen live (G6). */
  readonly mail = new Map<string, FakeMessage>();
  /** `inbox`: whether the message was in the INBOX when it arrived (what the history records; a label changed later is not in it). */
  readonly history: { readonly id: number; readonly added: string[]; readonly inbox?: boolean }[] =
    [];
  historyId = 1000;
  /** A `startHistoryId` below this is too old: 404, as Google answers for history it no longer holds. */
  oldestHistoryId = 0;
  /** Quota units charged for mail reads so far. */
  mailUnits = 0;
  /** The access token the fake accepts. */
  token = "ya29.fake-access-token";
  #next = 1;

  /** A message arrives in the INBOX (or the given labels): one history record, the id returned. */
  deliver(input: {
    from: string | string[];
    subject?: string;
    labels?: string[];
    extraHeaders?: { name: string; value: string }[];
  }): string {
    const id = `m${String(this.#next).padStart(15, "0")}`;
    this.#next += 1;
    const froms = Array.isArray(input.from) ? input.from : [input.from];
    const headers = [
      ...froms.map((value) => ({ name: "From", value })),
      { name: "Subject", value: input.subject ?? "hello" },
      ...(input.extraHeaders ?? []),
    ];
    const labelIds = input.labels ?? ["INBOX", "UNREAD"];
    this.mail.set(id, { id, labelIds, headers });
    this.historyId += 1;
    this.history.push({ id: this.historyId, added: [id], inbox: labelIds.includes("INBOX") });
    return id;
  }

  /** A filter the person made in Gmail, not by this lane. */
  addForeign(criteria: Record<string, unknown>, action: Record<string, unknown>): string {
    const id = `foreign-${String(this.#next)}`;
    this.#next += 1;
    this.filters.set(id, { id, criteria, action });
    return id;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    const body = typeof init?.body === "string" ? init.body : undefined;
    const method = init?.method ?? "GET";
    this.calls.push({
      method,
      url,
      headers,
      body,
      signal: init?.signal,
      redirect: init?.redirect,
    });
    const hold =
      this.hold ??
      (this.holdFromCall !== null && this.calls.length > this.holdFromCall
        ? new Promise<void>(() => undefined)
        : null);
    if (hold !== null) {
      // Like a real fetch, a held request ends when its signal aborts.
      const signal = init?.signal;
      const aborted = new Promise<never>((_, reject) => {
        if (signal === undefined || signal === null) return;
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
      await Promise.race([hold, aborted]);
    }
    init?.signal?.throwIfAborted();
    if (this.failNetwork > 0) {
      this.failNetwork -= 1;
      throw new TypeError("fetch failed");
    }
    const forcedHere = this.forcedFor.get(method)?.shift();
    const forced = forcedHere === "pass" ? undefined : (forcedHere ?? this.forced.shift());
    if (forced !== undefined) {
      return typeof forced === "number"
        ? new Response(null, { status: forced })
        : new Response(JSON.stringify(forced.body), { status: forced.status });
    }
    if (headers["Authorization"] !== `Bearer ${this.token}`) {
      return error(401, "unauthenticated", "Invalid Credentials");
    }

    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    const userBase = "/gmail/v1/users/me";
    if (method === "GET" && path === `${userBase}/profile`) {
      this.mailUnits += MAIL_UNITS.profile;
      return new Response(
        JSON.stringify({ emailAddress: "me@gmail.com", historyId: String(this.historyId) }),
        { status: 200 },
      );
    }
    if (method === "GET" && path === `${userBase}/history`) {
      this.mailUnits += MAIL_UNITS.history;
      const start = Number(parsedUrl.searchParams.get("startHistoryId") ?? "");
      if (!Number.isFinite(start) || start < this.oldestHistoryId) {
        return error(404, "notFound", "Requested entity was not found.");
      }
      const size = Number(parsedUrl.searchParams.get("maxResults") ?? "100");
      const offset = Number(parsedUrl.searchParams.get("pageToken") ?? "0");
      const inbox = this.history.filter((h) => h.id > start && (h.inbox ?? true));
      const page = inbox.slice(offset, offset + size);
      const next = offset + size < inbox.length ? String(offset + size) : undefined;
      const body = {
        ...(page.length === 0
          ? {}
          : {
              history: page.map((h) => ({
                id: String(h.id),
                messagesAdded: h.added.map((id) => ({
                  message: { id, threadId: id, labelIds: this.mail.get(id)?.labelIds ?? [] },
                })),
              })),
            }),
        ...(next === undefined ? {} : { nextPageToken: next }),
        historyId: String(this.historyId),
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (method === "GET" && path.startsWith(`${userBase}/messages/`)) {
      this.mailUnits += MAIL_UNITS.message;
      const id = decodeURIComponent(path.slice(`${userBase}/messages/`.length));
      const message = this.mail.get(id);
      if (message === undefined) return error(404, "notFound", "Requested entity was not found.");
      const wanted = new Set(
        parsedUrl.searchParams.getAll("metadataHeaders").map((n) => n.toLowerCase()),
      );
      const full = {
        id,
        threadId: id,
        labelIds: message.labelIds,
        historyId: String(this.historyId),
        // What Google adds when the answer is not cut with `fields` (read from the docs, not yet seen live): a body fragment.
        snippet: "SECRET BODY FRAGMENT",
        sizeEstimate: 1234,
        payload: { headers: message.headers.filter((h) => wanted.has(h.name.toLowerCase())) },
      };
      const fields = parsedUrl.searchParams.get("fields");
      if (fields === null) return new Response(JSON.stringify(full), { status: 200 });
      // `fields=a,b,c/d`: keep only the top-level names listed (and, for `payload/headers`, the headers).
      const keep = new Set(fields.split(",").map((f) => f.split("/")[0]));
      return new Response(
        JSON.stringify(Object.fromEntries(Object.entries(full).filter(([k]) => keep.has(k)))),
        { status: 200 },
      );
    }
    const base = "/gmail/v1/users/me/settings/filters";
    if (!path.startsWith(base)) return new Response(null, { status: 404 });
    const rest = path.slice(base.length);

    if (method === "GET" && rest === "") {
      this.units += UNITS.list;
      const all = [...this.filters.values()];
      const text = this.listBody ?? JSON.stringify(all.length === 0 ? {} : { filter: all });
      return new Response(text, { status: 200, headers: this.listHeaders });
    }
    if (method === "POST" && rest === "") {
      this.units += UNITS.create;
      const parsed = JSON.parse(body ?? "{}") as {
        criteria?: Record<string, unknown>;
        action?: { addLabelIds?: string[] };
      };
      if (parsed.action?.addLabelIds?.includes("SPAM") === true) {
        return error(400, "invalidArgument", "Invalid label SPAM in AddLabelIds");
      }
      const query = parsed.criteria?.["query"];
      if (typeof query === "string" && query.length > QUERY_WALL) {
        return error(500, "backendError", "Backend Error");
      }
      this.beforeCreate?.();
      // Measured live 2026-10-27: Gmail holds no two identical filters.
      const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
      for (const f of this.filters.values()) {
        if (same(f.criteria, parsed.criteria ?? {}) && same(f.action, parsed.action ?? {})) {
          return error(400, "failedPrecondition", "Filter already exists");
        }
      }
      const id = `filter-${String(this.#next)}`;
      this.#next += 1;
      const filter: FakeFilter = {
        id,
        criteria: parsed.criteria ?? {},
        action: parsed.action ?? {},
      };
      this.filters.set(id, filter);
      const lost = this.createThenFail.shift();
      if (lost !== undefined) return new Response(null, { status: lost });
      return new Response(JSON.stringify(filter), { status: 200 });
    }
    if (method === "DELETE" && rest.startsWith("/")) {
      this.units += UNITS.delete;
      const id = decodeURIComponent(rest.slice(1));
      return id !== "" && this.filters.delete(id)
        ? new Response(null, { status: 204 })
        : error(404, "notFound", "Requested entity was not found.");
    }
    return new Response(null, { status: 405 });
  };
}

/** Google's error body: carries an address and a token-shaped string on purpose, so a test can prove neither is repeated. */
function error(status: number, reason: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message: `${message} (spammer@evil.example, ya29.leaky-token-value)`,
        errors: [{ reason, message }],
        status: reason.toUpperCase(),
      },
    }),
    { status },
  );
}
