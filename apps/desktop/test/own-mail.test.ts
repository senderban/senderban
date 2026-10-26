import { describe, expect, it, vi } from "vitest";

// own-mail.ts reaches Electron only through the accounts file helpers; a stand-in is enough.
vi.mock("electron", () => ({ safeStorage: {} }));

const { collectOwnMail, createOwnMail, refreshOwnOnChange } = await import("../src/own-mail.js");
const { canRejectSender } = await import("@senderban/core");

const imap = (id: string, user: string, sieveUser = user) => ({
  id,
  imap: { host: "mail.example.com", port: 993, secure: true, user },
  sieve: { host: "mail.example.com", port: 4190, user: sieveUser },
  passwordCipher: "AAECAw==",
});
const gmail = (id: string, email: string) => ({
  id,
  gmail: { email, refreshCipher: "AAECAw==" },
});

describe("collectOwnMail", () => {
  it("takes both logins of an IMAP account and its mail domain, lower-cased", () => {
    const own = collectOwnMail([imap("a", "Me@Example.com", "sieve@example.com")]);
    expect([...own.addresses].sort()).toEqual(["me@example.com", "sieve@example.com"]);
    expect([...own.domains]).toEqual(["example.com"]);
  });

  it("skips a login that is not an address", () => {
    const own = collectOwnMail([imap("a", "plainuser")]);
    expect(own.addresses.size).toBe(0);
    expect(own.domains.size).toBe(0);
  });

  it("counts a Gmail account that the app does not run yet: its address is the person's own", () => {
    const own = collectOwnMail([gmail("g", "me@gmail.com")]);
    expect([...own.addresses]).toEqual(["me@gmail.com"]);
    // gmail.com is a freemail domain: only the full address is owned, never the whole domain.
    expect(own.domains.size).toBe(0);
    expect(canRejectSender("me@gmail.com", own)).toBe(false);
    expect(canRejectSender("someone-else@gmail.com", own)).toBe(true);
  });

  it("does not offer 'Block at server' for a look-alike spelling of the person's own Gmail inbox", () => {
    const own = collectOwnMail([gmail("g", "me@gmail.com"), imap("a", "you@googlemail.com")]);
    for (const forged of [
      "m.e@gmail.com",
      "me+x@gmail.com",
      "me@googlemail.com",
      "y.ou@gmail.com",
      "you@gmail.com",
    ]) {
      expect(canRejectSender(forged, own)).toBe(false);
    }
    expect(canRejectSender("m.e2@gmail.com", own)).toBe(true);
  });

  it("owns the whole domain of a Gmail account on a custom domain", () => {
    const own = collectOwnMail([gmail("g", "me@mycompany.example")]);
    expect([...own.domains]).toEqual(["mycompany.example"]);
    expect(canRejectSender("boss@mycompany.example", own)).toBe(false);
    expect(canRejectSender("boss@mail.mycompany.example", own)).toBe(false);
    expect(canRejectSender("boss@other.example", own)).toBe(true);
  });

  it("merges both kinds", () => {
    const own = collectOwnMail([imap("a", "me@example.com"), gmail("g", "me@gmail.com")]);
    expect([...own.addresses].sort()).toEqual(["me@example.com", "me@gmail.com"]);
    expect([...own.domains]).toEqual(["example.com"]);
  });
});

describe("createOwnMail and refreshOwnOnChange", () => {
  it("re-reads the accounts when told, and keeps the old set when the read fails", async () => {
    let accounts: ReturnType<typeof gmail>[] = [];
    let failing = false;
    const own = createOwnMail(collectOwnMail([]), () =>
      failing ? Promise.reject(new Error("locked")) : Promise.resolve(accounts),
    );
    expect(canRejectSender("me@gmail.com", own.get())).toBe(true);

    accounts = [gmail("g", "me@gmail.com")];
    const errors: unknown[] = [];
    const onChange = refreshOwnOnChange(
      () => Promise.resolve(own),
      (error) => errors.push(error),
    );
    await onChange();
    expect(canRejectSender("me@gmail.com", own.get())).toBe(false);

    failing = true;
    await expect(onChange()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(canRejectSender("me@gmail.com", own.get())).toBe(false);
  });

  it("reports a set that is not ready yet instead of throwing", async () => {
    const errors: unknown[] = [];
    const onChange = refreshOwnOnChange(
      () => Promise.reject(new Error("not started")),
      (error) => errors.push(error),
    );
    await expect(onChange()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
