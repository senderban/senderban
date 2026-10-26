import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startLoopback } from "../../src/google/loopback.js";
import type { Loopback } from "../../src/google/loopback.js";
import { newState } from "../../src/google/oauth.js";

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** A raw request, so a test can lie about the method, the path and the Host header like another program would. */
function hit(
  loopback: Loopback,
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: loopback.port,
        path,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? `127.0.0.1:${String(loopback.port)}`,
          Connection: "close",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const refused = (loopback: Loopback): Promise<boolean> =>
  hit(loopback, "/").then(
    () => false,
    () => true,
  );

/** The result, or "waiting" when nothing settled within a moment: proves the listener did not end. */
const settledWithin = (loopback: Loopback, ms = 60): Promise<unknown> =>
  Promise.race([
    loopback.result,
    new Promise((resolve) =>
      setTimeout(() => {
        resolve("waiting");
      }, ms),
    ),
  ]);

async function setup(
  options: { timeoutMs?: number; maxRequests?: number; signal?: AbortSignal } = {},
) {
  const state = newState();
  const loopback = await startLoopback({ state, ...options });
  return { state, loopback };
}

describe("startLoopback", () => {
  it("listens on the loopback address only, on a random port, and says where in Google's form", async () => {
    const { loopback } = await setup();
    try {
      expect(loopback.host).toBe("127.0.0.1");
      expect(loopback.port).toBeGreaterThan(0);
      expect(loopback.redirectUri).toBe(`http://127.0.0.1:${String(loopback.port)}`);
    } finally {
      loopback.close();
    }
  });

  it("takes the code of a request that carries the state, answers a static page, then closes the port", async () => {
    const { state, loopback } = await setup();
    const answer = await hit(loopback, `/?code=4%2F0AX-code_1&state=${state}&scope=ignored`);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("close this tab");
    expect(answer.body).not.toContain("4/0AX");
    expect(answer.body).not.toContain(state);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(answer.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(await loopback.result).toEqual({ kind: "code", code: "4/0AX-code_1" });
    expect(await refused(loopback)).toBe(true);
  });

  it("keeps waiting after a request with the wrong Host (a rebound name), and still takes the real one", async () => {
    const { state, loopback } = await setup();
    const rebound = await hit(loopback, `/?code=evil&state=${state}`, { host: "evil.example" });
    expect(rebound.status).toBe(400);
    expect(rebound.body).toBe("Bad request");
    expect(await settledWithin(loopback)).toBe("waiting");
    await hit(loopback, `/?code=real&state=${state}`);
    expect(await loopback.result).toEqual({ kind: "code", code: "real" });
  });

  it("refuses a request with the wrong, missing or lengthened state without ending", async () => {
    const { state, loopback } = await setup();
    for (const path of [
      "/?code=x&state=wrong",
      "/?code=x",
      `/?code=x&state=${state}x`,
      `/?code=x&state=${state.slice(0, -1)}`,
      "/?code=x&state=",
    ]) {
      const answer = await hit(loopback, path);
      expect(answer.status).toBe(400);
      expect(answer.body).toBe("Bad request");
    }
    expect(await settledWithin(loopback)).toBe("waiting");
    loopback.close();
  });

  it("refuses another path, another method, and a believed state without a code or an error", async () => {
    const { state, loopback } = await setup();
    expect((await hit(loopback, `/favicon.ico?state=${state}`)).status).toBe(400);
    expect((await hit(loopback, `/callback?code=x&state=${state}`)).status).toBe(400);
    expect((await hit(loopback, `/?code=x&state=${state}`, { method: "POST" })).status).toBe(400);
    expect((await hit(loopback, `/?state=${state}`)).status).toBe(400);
    expect(await settledWithin(loopback)).toBe("waiting");
    loopback.close();
  });

  it.each([
    ["empty", ""],
    ["a space", "a%20b"],
    ["a control character", "a%00b"],
    ["past 256 characters (Google's largest code)", "a".repeat(257)],
  ])("refuses a code that is %s", async (_name, code) => {
    const { state, loopback } = await setup();
    expect((await hit(loopback, `/?code=${code}&state=${state}`)).status).toBe(400);
    expect(await settledWithin(loopback)).toBe("waiting");
    loopback.close();
  });

  it("reads error=access_denied as the person saying no, and shows nothing of the error text", async () => {
    const { state, loopback } = await setup();
    const answer = await hit(
      loopback,
      `/?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E&state=${state}`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).not.toContain("script");
    expect(answer.body).not.toContain("access_denied");
    expect(await loopback.result).toEqual({ kind: "denied" });
  });

  it("reads any other error from Google as a failure, never as a code", async () => {
    const { state, loopback } = await setup();
    await hit(loopback, `/?error=server_error&state=${state}&code=x`);
    expect(await loopback.result).toEqual({ kind: "failed", reason: "google-error" });
  });

  it("refuses an error that does not carry the state, so a stranger cannot cancel the sign-in", async () => {
    const { loopback } = await setup();
    expect((await hit(loopback, "/?error=access_denied&state=guess")).status).toBe(400);
    expect(await settledWithin(loopback)).toBe("waiting");
    loopback.close();
  });

  it("lets two believed requests at once produce exactly one answer (not a deterministic proof of the guard)", async () => {
    const { state, loopback } = await setup();
    const [first, second] = await Promise.all([
      hit(loopback, `/?code=first&state=${state}`),
      hit(loopback, `/?code=second&state=${state}`).catch(() => ({ status: 0 })),
    ]);
    expect([first.status, second.status].filter((s) => s === 200)).toHaveLength(1);
    expect(await loopback.result).toMatchObject({ kind: "code" });
  });

  it("refuses an absolute-form or protocol-relative request target", async () => {
    const { state, loopback } = await setup();
    for (const target of [
      `//127.0.0.1/?code=x&state=${state}`,
      `//evil.example/?code=x&state=${state}`,
    ]) {
      expect((await hit(loopback, target)).status).toBe(400);
    }
    expect(await settledWithin(loopback)).toBe("waiting");
    loopback.close();
  });

  it.each([
    ["a time limit of 0", { timeoutMs: 0 }],
    ["a time limit past an hour", { timeoutMs: 3_600_001 }],
    ["a time limit that overflows a timer", { timeoutMs: 2 ** 31 }],
    ["a fractional time limit", { timeoutMs: 1.5 }],
    ["a time limit that is NaN", { timeoutMs: Number.NaN }],
    ["no requests allowed", { maxRequests: 0 }],
    ["more than 1000 requests", { maxRequests: 1001 }],
    ["a fractional request cap", { maxRequests: 2.5 }],
  ])("refuses %s before it opens a port", async (_name, bad) => {
    await expect(startLoopback({ state: newState(), ...bad })).rejects.toThrow(RangeError);
  });

  it("gives up after the request cap of requests that carry the state, and closes", async () => {
    const { state, loopback } = await setup({ maxRequests: 3 });
    for (let i = 0; i < 4; i += 1) await hit(loopback, `/?state=${state}`);
    expect(await loopback.result).toEqual({ kind: "failed", reason: "too-many-requests" });
    expect(await refused(loopback)).toBe(true);
  });

  it("does not count requests that lack the state, so a stranger cannot spend the cap (FLAG-4)", async () => {
    const { state, loopback } = await setup({ maxRequests: 3 });
    for (let i = 0; i < 10; i += 1) await hit(loopback, "/?state=x");
    await hit(loopback, `/?state=${state}`, { host: "evil.example" });
    await hit(loopback, `/?state=${state}`, { method: "POST" });
    await hit(loopback, `/favicon.ico?state=${state}`);
    expect(await settledWithin(loopback)).toBe("waiting");
    expect((await hit(loopback, `/?code=real&state=${state}`)).status).toBe(200);
    expect(await loopback.result).toEqual({ kind: "code", code: "real" });
  });

  it("gives up at its time limit and closes", async () => {
    const { loopback } = await setup({ timeoutMs: 40 });
    expect(await loopback.result).toEqual({ kind: "failed", reason: "timeout" });
    expect(await refused(loopback)).toBe(true);
  });

  it("stops when the caller aborts, also when it was aborted before it started", async () => {
    const controller = new AbortController();
    const { loopback } = await setup({ signal: controller.signal });
    controller.abort();
    expect(await loopback.result).toEqual({ kind: "failed", reason: "aborted" });
    expect(await refused(loopback)).toBe(true);

    const already = new AbortController();
    already.abort();
    const second = await setup({ signal: already.signal });
    expect(await second.loopback.result).toEqual({ kind: "failed", reason: "aborted" });
  });

  it("closes on close(), and close() twice does nothing", async () => {
    const { loopback } = await setup();
    loopback.close();
    loopback.close();
    expect(await loopback.result).toEqual({ kind: "failed", reason: "aborted" });
    expect(await refused(loopback)).toBe(true);
  });

  it("two sign-ins use two ports and do not hear each other", async () => {
    const a = await setup();
    const b = await setup();
    try {
      expect(a.loopback.port).not.toBe(b.loopback.port);
      expect((await hit(b.loopback, `/?code=x&state=${a.state}`)).status).toBe(400);
    } finally {
      a.loopback.close();
      b.loopback.close();
    }
  });
});
