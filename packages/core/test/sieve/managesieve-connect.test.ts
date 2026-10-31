import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterError } from "../../src/adapter.js";
import {
  connectManageSieve,
  NoStartTlsError,
  probeManageSieve,
} from "../../src/sieve/managesieve.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

/** A server that accepts and then says `greeting` at most; `closed` settles when the client's socket goes. */
async function listen(
  greeting = "",
  firstReply = "",
): Promise<{ port: number; closed: Promise<void> }> {
  let closedNow: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closedNow = resolve;
  });
  const server = createServer((socket: Socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.on("close", closedNow);
    if (greeting !== "") socket.write(greeting);
    if (firstReply !== "") {
      socket.once("data", () => {
        socket.write(firstReply);
      });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, closed };
}

describe("before TLS", () => {
  it("stops at what a greeting can be, and does not wait for the rest", async () => {
    const { port } = await listen(`"${"a".repeat(9_000)}`);
    await expect(
      probeManageSieve({ host: "127.0.0.1", port, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ message: expect.stringContaining("too large") as string });
  });
});

const options = (port: number, signal?: AbortSignal) => ({
  host: "127.0.0.1",
  port,
  username: "you@example.com",
  password: "not-a-real-password",
  ...(signal === undefined ? {} : { signal }),
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

describe("connectManageSieve", () => {
  it("closes the socket when the caller gives up on a silent server", async () => {
    const { port, closed } = await listen();
    const controller = new AbortController();
    const attempt = connectManageSieve(options(port, controller.signal));
    const failed = expect(attempt).rejects.toThrow();
    setTimeout(() => {
      controller.abort();
    }, 50);
    await closed;
    await failed;
  });

  it("answers at once when the caller gives up during the TLS handshake", async () => {
    const controller = new AbortController();
    const server = createServer((socket: Socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      socket.write('"STARTTLS"\r\nOK\r\n');
      socket.once("data", () => {
        socket.write("OK\r\n");
        // The client's next bytes are its TLS hello: only now is it inside the handshake, on a loaded machine too.
        socket.once("data", () => {
          controller.abort();
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await expect(connectManageSieve(options(port, controller.signal))).rejects.toThrow(
      "TLS handshake",
    );
  });

  it("does not open a connection for a signal that already fired", async () => {
    const { port } = await listen();
    const signal = AbortSignal.abort();
    await expect(connectManageSieve(options(port, signal))).rejects.toBe(signal.reason);
  });

  it("refuses a server without STARTTLS before any credential is sent", async () => {
    const { port } = await listen('"IMPLEMENTATION" "fake"\r\nOK\r\n');
    const refused = connectManageSieve(options(port));
    await expect(refused).rejects.toBeInstanceOf(NoStartTlsError);
    // Only a greeting says so, which anyone on the path can write: it must not stop the lane.
    await expect(refused).rejects.toMatchObject({ code: "TRANSIENT" });
  });
});

describe("a refusal before TLS", () => {
  const phish = "Your mailbox is locked, go to evil.example";

  it("keeps the unauthenticated greeting's words out of the error", async () => {
    const { port } = await listen(`NO "${phish}"\r\n`);
    const error: unknown = await connectManageSieve(options(port)).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("evil.example");
    expect((error as AdapterError).code).toBe("TRANSIENT");
  });

  it.each(['NO (QUOTA) "x"', 'NO "Your password expired"'])(
    "does not let %s stop the lane",
    async (reply) => {
      const { port } = await listen(`${reply}\r\n`);
      await expect(connectManageSieve(options(port))).rejects.toMatchObject({ code: "TRANSIENT" });
    },
  );

  it("keeps the unauthenticated STARTTLS reply's words out of the error", async () => {
    const { port } = await listen('"STARTTLS"\r\nOK\r\n', `NO "${phish}"\r\n`);
    const error: unknown = await connectManageSieve(options(port)).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("evil.example");
  });
});

describe("bytes behind the STARTTLS reply", () => {
  it("are never taken for an answer: the client goes on to TLS, and no password leaves in clear", async () => {
    const received: Buffer[] = [];
    const forged = 'OK\r\n"SASL" "PLAIN"\r\n"SIEVE" "fileinto mailbox envelope"\r\nOK\r\n';
    const server = createServer((socket: Socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      socket.write('"STARTTLS"\r\nOK\r\n');
      socket.once("data", () => {
        socket.write(forged);
        socket.on("data", (chunk: Buffer) => {
          received.push(chunk);
          socket.destroy();
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await expect(connectManageSieve(options(port))).rejects.toThrow(/TLS|closed/u);
    const sent = Buffer.concat(received);
    // 0x16 is a TLS handshake record: the next thing on the wire was the client's hello.
    expect(sent[0]).toBe(0x16);
    expect(sent.toString("latin1")).not.toContain("AUTHENTICATE");
  });
});

describe("probeManageSieve", () => {
  it("refuses a server without STARTTLS, having sent nothing", async () => {
    let received = 0;
    const server = createServer((socket: Socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      socket.write('"IMPLEMENTATION" "fake"\r\nOK\r\n');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await expect(probeManageSieve({ host: "127.0.0.1", port })).rejects.toBeInstanceOf(
      NoStartTlsError,
    );
    expect(received).toBe(0);
  });

  it("fails on something that is not ManageSieve instead of hanging", async () => {
    const { port } = await listen("220 mail.example.com ESMTP\r\n");
    await expect(
      probeManageSieve({ host: "127.0.0.1", port, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("closes the socket when the caller gives up", async () => {
    const { port, closed } = await listen();
    const controller = new AbortController();
    const failed = expect(
      probeManageSieve({ host: "127.0.0.1", port, signal: controller.signal }),
    ).rejects.toThrow();
    setTimeout(() => {
      controller.abort();
    }, 50);
    await closed;
    await failed;
  });

  it("refuses a port out of range before connecting", async () => {
    await expect(probeManageSieve({ host: "127.0.0.1", port: 70_000 })).rejects.toMatchObject({
      code: "REJECTED",
    });
  });
});
