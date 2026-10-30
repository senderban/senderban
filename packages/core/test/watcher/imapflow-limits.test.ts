import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_IMAP_LINE_BYTES,
  MAX_IMAP_LITERAL_BYTES,
  MAX_IMAP_RESPONSE_BYTES,
  MAX_IMAP_RESPONSE_TOKENS,
  imapflowConnector,
} from "../../src/watcher/imapflow-session.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

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

/** A server that says `first` and then keeps sending `chunk` until the client hangs up or `total` bytes went out. */
async function hostile(first: string, chunk: Buffer, total: number): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    let sent = 0;
    const push = (): void => {
      while (!socket.destroyed && sent < total) {
        sent += chunk.length;
        if (!socket.write(chunk)) {
          socket.once("drain", push);
          return;
        }
      }
    };
    socket.write(first);
    push();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const connect = (port: number) =>
  imapflowConnector({
    host: "127.0.0.1",
    port,
    secure: false,
    user: "you@example.com",
    password: "not-a-real-password",
  })();

const CHUNK = Buffer.alloc(64 * 1024, 0x61);

describe("imapflowConnector limits", () => {
  it("cuts off a server that never ends a line, at the cap and not at imapflow's 1 GiB", async () => {
    const port = await hostile("* ", CHUNK, MAX_IMAP_LINE_BYTES * 2);
    await expect(connect(port)).rejects.toMatchObject({ code: "LineTooLarge" });
  });

  it("refuses a literal past the cap from its announced size, before reading it", async () => {
    const big = String(MAX_IMAP_LITERAL_BYTES + 1);
    const port = await hostile(`* OK {${big}}\r\n`, Buffer.alloc(0), 0);
    await expect(connect(port)).rejects.toMatchObject({ code: "LiteralTooLarge" });
  });

  it("stops parsing one response of many small tokens", async () => {
    const line = `* 1 FETCH (${"1 ".repeat(MAX_IMAP_RESPONSE_TOKENS + 10)})\r\n`;
    const port = await hostile("* OK ready\r\n", Buffer.from(line), line.length);
    await expect(connect(port)).rejects.toThrow();
  });

  it("cuts off one response that spreads over many literals", async () => {
    const part = 1024 * 1024;
    const piece = Buffer.concat([Buffer.alloc(part, 0x61), Buffer.from(` {${String(part)}}\r\n`)]);
    const port = await hostile(`* OK {${String(part)}}\r\n`, piece, MAX_IMAP_RESPONSE_BYTES * 2);
    await expect(connect(port)).rejects.toMatchObject({ code: "ResponseTooLarge" });
  });
});
