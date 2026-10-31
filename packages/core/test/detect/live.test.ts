import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isPublicAddress, publicAddressLookup } from "../../src/detect/live.js";
import { probeManageSieve } from "../../src/sieve/managesieve.js";

describe("isPublicAddress", () => {
  it.each([
    ["10.1.2.3", 4],
    ["127.0.0.1", 4],
    ["169.254.169.254", 4],
    ["172.16.0.1", 4],
    ["172.31.255.255", 4],
    ["192.168.1.1", 4],
    ["100.64.0.1", 4],
    ["0.0.0.0", 4],
    ["224.0.0.1", 4],
    ["255.255.255.255", 4],
    ["::1", 6],
    ["::", 6],
    ["fe80::1", 6],
    ["fd00::1", 6],
    ["ff02::1", 6],
    ["::ffff:10.0.0.1", 6],
    ["::ffff:127.0.0.1", 6],
  ])("refuses %s", (address, family) => {
    expect(isPublicAddress(address, family)).toBe(false);
  });

  it.each([
    ["192.0.2.1", 4],
    ["198.51.100.1", 4],
    ["2001:db8::1", 6],
  ])("lets %s through", (address, family) => {
    expect(isPublicAddress(address, family)).toBe(true);
  });
});

describe("a probe at a name that resolves to the person's own machine", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  it("never opens the socket", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await expect(
      probeManageSieve({ host: "localhost", port, lookup: publicAddressLookup }),
    ).rejects.toThrow();
    expect(connections).toBe(0);
  });
});
