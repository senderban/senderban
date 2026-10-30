import { describe, expect, it } from "vitest";
import { MAX_ENTRIES, BlocklistSchema, checkEntry } from "../src/blocklist.js";
import { isFreemail, isNotOffered, isPublicSuffix } from "../src/freemail.js";

const base = {
  id: "0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9d11",
  action: "junk",
  createdAt: "2026-10-24T12:00:00.000Z",
};

describe("checkEntry", () => {
  it("normalises an address entry", () => {
    const r = checkEntry({ ...base, match: "exactAddress", value: "Spam@Example.com" });
    expect(r.ok && r.entry.value).toBe("spam@example.com");
  });

  it("accepts a non-freemail domain", () => {
    const r = checkEntry({ ...base, match: "exactDomain", value: "Spam.Example.com" });
    expect(r.ok && r.entry.value).toBe("spam.example.com");
  });

  it("refuses domain blocks on freemail, including subdomains", () => {
    for (const value of ["gmail.com", "mail.gmail.com", "outlook.com"]) {
      expect(checkEntry({ ...base, match: "subdomains", value }).ok).toBe(false);
    }
  });

  it("refuses domain blocks on a country public suffix, not on a name under it", () => {
    for (const value of ["co.uk", "com.tr", "ac.jp"]) {
      expect(checkEntry({ ...base, match: "subdomains", value }).ok).toBe(false);
    }
    expect(checkEntry({ ...base, match: "subdomains", value: "shop.co.uk" }).ok).toBe(true);
  });

  it("still allows blocking one address at a freemail provider", () => {
    expect(checkEntry({ ...base, match: "exactAddress", value: "spammer@gmail.com" }).ok).toBe(
      true,
    );
  });

  it("rejects permanent actions and unknown fields", () => {
    expect(
      checkEntry({ ...base, action: "discard", match: "exactAddress", value: "a@example.com" }).ok,
    ).toBe(false);
    expect(
      checkEntry({ ...base, match: "exactAddress", value: "a@example.com", extra: 1 }).ok,
    ).toBe(false);
  });
});

describe("freemail guard", () => {
  it("does not flag lookalike domains", () => {
    expect(isFreemail("gmail.com.evil.test")).toBe(false);
    expect(isFreemail("notgmail.com")).toBe(false);
  });
});

describe("domains that are not offered", () => {
  it.each(["yahoo.fr", "qq.com", "gmail.com", "mail.gmail.com", "co.uk", "sch.ng", "github.io"])(
    "%s is shared: never offered",
    (domain) => {
      expect(isNotOffered(domain)).toBe(true);
    },
  );

  it.each(["example.com", "news.example.com", "shop.co.uk", "gmail.com.evil.test"])(
    "%s is one owner's",
    (domain) => {
      expect(isNotOffered(domain)).toBe(false);
    },
  );

  it("covers the subdomains of a mail provider found after 0.1.3", () => {
    const provider = "yahoo.fr";
    expect(isNotOffered(`mail.${provider}`)).toBe(true);
  });

  it("takes a wildcard rule and its exception from the list", () => {
    expect(isPublicSuffix("foo.ck")).toBe(true);
    expect(isPublicSuffix("www.ck")).toBe(false);
  });

  it("keeps an entry stored by 0.1.3: a refused entry would stop its whole lane", () => {
    for (const value of ["yahoo.fr", "sch.ng", "github.io"]) {
      expect(checkEntry({ ...base, match: "subdomains", value }).ok).toBe(true);
    }
  });
});

describe("BlocklistSchema", () => {
  it("caps the list length", () => {
    const entry = { ...base, match: "exactAddress", value: "a@example.com" };
    expect(
      BlocklistSchema.safeParse(Array.from({ length: MAX_ENTRIES }, () => entry)).success,
    ).toBe(true);
    expect(
      BlocklistSchema.safeParse(Array.from({ length: MAX_ENTRIES + 1 }, () => entry)).success,
    ).toBe(false);
  });
});
