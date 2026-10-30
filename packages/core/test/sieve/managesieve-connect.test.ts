import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectManageSieve } from "../../src/sieve/managesieve.js";

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
    await expect(connectManageSieve(options(port))).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
  });
});
