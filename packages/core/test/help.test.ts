import { describe, expect, it } from "vitest";
import { HELP_LINKS, HELP_TARGETS, HelpTargetSchema } from "../src/help.js";

describe("Help links", () => {
  it("are https addresses on the project's own hosts, with no credentials or port", () => {
    for (const link of Object.values(HELP_LINKS)) {
      const url = new URL(link);
      expect(url.protocol).toBe("https:");
      expect(["github.com", "senderban.com"]).toContain(url.hostname);
      expect(url.username + url.password + url.port + url.search + url.hash).toBe("");
      if (url.hostname === "github.com")
        expect(url.pathname.startsWith("/senderban/senderban/")).toBe(true);
    }
  });

  it("cover every target but the log folder", () => {
    expect(Object.keys(HELP_LINKS).sort()).toEqual(HELP_TARGETS.filter((t) => t !== "logs").sort());
  });

  it("accept only the listed words", () => {
    for (const target of HELP_TARGETS)
      expect(HelpTargetSchema.safeParse(target).success).toBe(true);
    for (const value of ["", "sponsor", "LOGS", "https://senderban.com/", 1, null]) {
      expect(HelpTargetSchema.safeParse(value).success).toBe(false);
    }
  });
});
