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
/** The measured wall: accepted at 14,003 characters, a 500 at 28,003; the fake puts its limit between. */
const QUERY_WALL = 20_000;

export class FakeGmail {
  readonly filters = new Map<string, FakeFilter>();
  readonly calls: RecordedCall[] = [];
  /** Quota units charged so far. */
  units = 0;
  /** Forced answers for the next requests, consumed one per request: a status, or a status with a JSON body. */
  readonly forced: (number | { status: number; body: unknown })[] = [];
  /** Makes the next requests throw like a network failure. */
  failNetwork = 0;
  /** Resolves before the answer is built, so a test can hold a request open. */
  hold: Promise<void> | null = null;
  /** Replaces the body of the next list answer. */
  listBody: string | null = null;
  /** Headers of the next list answer (for example a `content-length` the body does not match). */
  listHeaders: Record<string, string> = {};
  /** The access token the fake accepts. */
  token = "ya29.fake-access-token";
  #next = 1;

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
    if (this.hold !== null) {
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
      await Promise.race([this.hold, aborted]);
    }
    init?.signal?.throwIfAborted();
    if (this.failNetwork > 0) {
      this.failNetwork -= 1;
      throw new TypeError("fetch failed");
    }
    const forced = this.forced.shift();
    if (forced !== undefined) {
      return typeof forced === "number"
        ? new Response(null, { status: forced })
        : new Response(JSON.stringify(forced.body), { status: forced.status });
    }
    if (headers["Authorization"] !== `Bearer ${this.token}`) {
      return error(401, "unauthenticated", "Invalid Credentials");
    }

    const path = new URL(url).pathname;
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
      const id = `filter-${String(this.#next)}`;
      this.#next += 1;
      const filter: FakeFilter = {
        id,
        criteria: parsed.criteria ?? {},
        action: parsed.action ?? {},
      };
      this.filters.set(id, filter);
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
