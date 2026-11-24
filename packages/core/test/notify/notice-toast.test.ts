import { describe, expect, it } from "vitest";
import {
  NOTICE_TEXT_MAX,
  RECENT_LAUNCH,
  buildNoticeToastXml,
  isRecentLaunch,
  parseActivation,
} from "../../src/notify/toast.js";

describe("a notice that opens Recent mail", () => {
  it("carries the fixed launch string and no buttons", () => {
    const xml = buildNoticeToastXml("Senderban", "3 more new messages were not announced.");
    expect(xml).toBe(
      `<toast launch="act=recent"><visual><binding template="ToastGeneric">` +
        `<text>Senderban</text><text>3 more new messages were not announced.</text>` +
        `</binding></visual></toast>`,
    );
    expect(xml).not.toMatch(/<actions>/u);
  });

  it("escapes mail text so it cannot add markup, and bounds it", () => {
    const xml = buildNoticeToastXml("Senderban", `"x" <action/> & ${"y".repeat(NOTICE_TEXT_MAX)}`);
    expect(xml).not.toMatch(/<action\//u);
    expect(xml).toContain("&quot;x&quot; &lt;action/&gt; &amp;");
    expect(xml.length).toBeLessThan(NOTICE_TEXT_MAX + 200);
  });

  it("is told apart from every other click, by exact match only", () => {
    expect(isRecentLaunch({ arguments: RECENT_LAUNCH })).toBe(true);
    for (const odd of [
      { arguments: `${RECENT_LAUNCH};id=x` },
      { arguments: "act=open" },
      { arguments: "" },
      { arguments: 1 },
      {},
      null,
      "act=recent",
    ]) {
      expect(isRecentLaunch(odd)).toBe(false);
    }
  });

  it("is not a button: parseActivation blocks nothing for it", () => {
    expect(parseActivation({ arguments: RECENT_LAUNCH })).toEqual({
      ok: false,
      reason: "not-a-button",
    });
  });
});
