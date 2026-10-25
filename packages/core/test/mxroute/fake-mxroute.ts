/** In-memory stand-in for the MXroute blacklist API: same status codes as measured live (007 S5). */
export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | null | undefined;
  readonly redirect: string | undefined;
}

export class FakeMxroute {
  readonly entries = new Set<string>();
  readonly calls: RecordedCall[] = [];
  /** Forced answer for the next requests (status), consumed one per request. */
  readonly forced: number[] = [];
  /** Makes the next request throw like a network failure. */
  failNetwork = 0;
  /** Resolves before the answer is built, so a test can hold a request open. */
  hold: Promise<void> | null = null;
  listHeaders: Record<string, string> = {};
  listBody: string | null = null;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.calls.push({
      method: init?.method ?? "GET",
      url,
      headers,
      body,
      signal: init?.signal,
      redirect: init?.redirect,
    });
    if (this.hold !== null) await this.hold;
    init?.signal?.throwIfAborted();
    if (this.failNetwork > 0) {
      this.failNetwork -= 1;
      throw new TypeError("fetch failed");
    }
    const forced = this.forced.shift();
    if (forced !== undefined) return new Response(null, { status: forced });

    const path = new URL(url).pathname;
    const base = /^\/domains\/[^/]+\/spam\/blacklist/.exec(path);
    if (base === null) return new Response(null, { status: 404 });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const text = this.listBody ?? JSON.stringify({ success: true, data: [...this.entries] });
      return new Response(text, { status: 200, headers: this.listHeaders });
    }
    if (method === "POST") {
      const entry = (JSON.parse(body ?? "{}") as { entry: string }).entry;
      if (this.entries.has(entry)) return new Response(null, { status: 409 });
      this.entries.add(entry);
      return new Response(JSON.stringify({ success: true, data: { entry } }), { status: 201 });
    }
    if (method === "DELETE") {
      const entry = decodeURIComponent(path.slice(base[0].length + 1));
      return new Response(null, { status: this.entries.delete(entry) ? 204 : 404 });
    }
    return new Response(null, { status: 405 });
  };
}
