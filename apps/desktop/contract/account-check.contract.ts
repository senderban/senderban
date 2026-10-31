import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { accountFromForm, type NewAccount } from "@senderban/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDovecot, type Dovecot } from "../../../packages/core/contract/dovecot.js";
import { checkAccount } from "../src/account-check.js";

// The form's real check, with its live probes, against Dovecot: the only part replaced is the certificate store, because the
// container's certificate is made here. The same store is what refuses a server's certificate in the product.
const ADDRESS = "someone@example.com";

let server: Dovecot;
let formerCa: string[];

beforeAll(async () => {
  server = await startDovecot();
  formerCa = getCACertificates("default");
  setDefaultCACertificates([...formerCa, server.ca.toString("utf8")]);
});
afterAll(() => {
  setDefaultCACertificates(formerCa);
  server.stop();
});

function account(password: string, sievePort: number, imapPort = server.imapPort): NewAccount {
  const made = accountFromForm({
    provider: "other",
    address: ADDRESS,
    host: "localhost",
    port: sievePort,
    password,
  });
  return { ...made, imap: { ...made.imap, port: imapPort } };
}

describe("the add form's check against Dovecot", () => {
  it("passes a working server", async () => {
    const stages: string[] = [];
    const reply = await checkAccount(account(server.password, server.port), undefined, {
      onStage: (stage) => {
        stages.push(`${stage.stage}=${String(stage.ms)}ms`);
      },
    });
    console.log(`check ${stages.join(" ")}`);
    expect(reply).toBe("ok");
    expect(stages.map((stage) => stage.split("=")[0])).toEqual(["reach", "imap", "sieve"]);
  });

  it("says the password was refused", async () => {
    expect(await checkAccount(account("wrong-password", server.port))).toBe("login-refused");
  });

  it("finds no ManageSieve on a port that is not ManageSieve, before any login", async () => {
    expect(await checkAccount(account("wrong-password", server.imapPort))).toBe("sieve-missing");
  });

  it("says when a port is closed", async () => {
    expect(await checkAccount(account(server.password, 1))).toBe("sieve-missing");
  });
});
