import { describe, expect, it } from "vitest";
import {
  ACTIVATION_ARGUMENTS_MAX,
  BUTTON_LABELS,
  BUTTON_LABEL_MAX,
  DOMAIN_CHOICE_MAX,
  DOMAIN_LINE_MAX,
  LOCAL_PART_MAX,
  REOPEN_CHOICE,
  TOAST_TEXT_MAX,
  SPAM_HIGH,
  SPAM_MEDIUM,
  buildMailToastXml,
  createActivationSigner,
  escapeXml,
  parseActivation,
  spamLevel,
} from "../../src/notify/toast.js";
import type { MailToast } from "../../src/notify/toast.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const signer = createActivationSigner(Buffer.alloc(32, 7));
/** The person turned on "Block at server when the mailbox can" on the Settings page. */
const ON = { preferServerBlock: true } as const;
const toast = (over: Partial<MailToast> = {}): MailToast => ({
  id: ID,
  sender: "news@example.com",
  subject: "Hello",
  account: "info@example.com",
  spamScore: 1.6,
  domain: "example.com",
  rejectsAtServer: false,
  ...over,
});

describe("escapeXml", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;",
    );
  });

  it("replaces characters that make an XML 1.0 document invalid", () => {
    expect(escapeXml("a\u0000b\u0008c￾d")).toBe("a�b�c�d");
    expect(escapeXml("lone \uD800 surrogate")).toBe("lone � surrogate");
  });

  it("keeps ordinary text, tabs, newlines and astral characters", () => {
    expect(escapeXml("bücher\t😀\n")).toBe("bücher\t😀\n");
  });

  it("is bounded", () => {
    expect(escapeXml("x".repeat(10_000))).toHaveLength(TOAST_TEXT_MAX);
  });
});

describe("buildMailToastXml", () => {
  const note = (text: string): string =>
    `<group><subgroup><text hint-style="captionSubtle" hint-wrap="true">${text}</text></subgroup></group>`;
  /** The buttons of a toast as [label, act], in the order they are drawn. */
  const buttons = (xml: string): string[][] =>
    [...xml.matchAll(/<action content="([^"]*)" arguments="act=([a-z]+);/gu)].map((m) => [
      m[1] ?? "",
      m[2] ?? "",
    ]);

  it("says the sender's domain first, outside the group, then the address, the subject, the mailbox and the spam score", () => {
    const xml = buildMailToastXml(toast());
    const lines = [
      '<text hint-maxLines="2">🚫 example.com</text><group>',
      '<text hint-style="captionSubtle" hint-wrap="true" hint-maxLines="2">news@example.com</text>',
      '<text hint-style="body" hint-wrap="true" hint-maxLines="2">Hello</text>',
      '<text hint-style="captionSubtle" hint-maxLines="1">To: info@example.com</text>',
      '<text hint-style="captionSubtle" hint-align="right">Spam 1.6</text>',
      '<text hint-style="base" hint-align="right">🟢 low</text>',
    ];
    const at = lines.map((line) => xml.indexOf(line));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    // The two columns and the note.
    expect(xml.match(/<subgroup/gu)).toHaveLength(3);
    expect(xml).toContain(`launch="act=open;id=${ID}"`);
  });

  it("makes the whole address the first line on a free-mail domain, where the domain says nothing of the sender", () => {
    const xml = buildMailToastXml(toast({ sender: "someone@gmail.com", domain: null }));
    expect(xml).toContain('<text hint-maxLines="2">🚫 someone@gmail.com</text><group>');
    expect(xml.match(/someone@gmail\.com/gu)).toHaveLength(1);
  });

  it("shows the domain of the sender first even where the whole domain is not offered", () => {
    const xml = buildMailToastXml(toast({ trashOnly: true, domain: null }));
    expect(xml).toContain(">🚫 example.com</text>");
    expect(xml).toContain(">news@example.com</text>");
  });

  it("keeps the end of a long domain on the first line, which Windows would cut", () => {
    const fits = "paypal.com.attacker.test";
    expect(fits).toHaveLength(DOMAIN_LINE_MAX);
    expect(buildMailToastXml(toast({ sender: `x@${fits}` }))).toContain(`>🚫 ${fits}</text>`);
    const xml = buildMailToastXml(toast({ sender: "x@bank.example.attacker.test" }));
    expect(xml).toContain(">🚫 …example.attacker.test</text>");
    // The address under it is whole.
    expect(xml).toContain(">x@bank.example.attacker.test</text>");
  });

  it("puts the sender line before any other text", () => {
    const xml = buildMailToastXml(toast());
    expect(xml.match(/<text[^>]*>[^<]*<\/text>/u)?.[0]).toBe(
      '<text hint-maxLines="2">🚫 example.com</text>',
    );
  });

  it("makes the address the first line on any provider domain, not only the free-mail seeds", () => {
    const xml = buildMailToastXml(toast({ sender: "someone@yahoo.fr", domain: null }));
    expect(xml).toContain('<text hint-maxLines="2">🚫 someone@yahoo.fr</text><group>');
  });

  it("cuts a long local part on a provider domain so the domain stays in view, and gives the whole address under it", () => {
    const local = "paypal.security.team.notice.center";
    const xml = buildMailToastXml(toast({ sender: `${local}@gmail.com`, domain: null }));
    expect(xml).toContain(`>🚫 ${local.slice(0, LOCAL_PART_MAX - 1)}…@gmail.com</text>`);
    expect(xml).toContain(`>${local}@gmail.com</text>`);
  });

  it("escapes a hostile sender on the first line", () => {
    const xml = buildMailToastXml(toast({ sender: "a&b'c@gmail.com", domain: null }));
    expect(xml).toContain(">🚫 a&amp;b&apos;c@gmail.com</text>");
    expect(xml).not.toContain("a&b'c");
  });

  it("takes our marks out of the subject, so it cannot pass for the sender line", () => {
    const xml = buildMailToastXml(toast({ subject: "🚫 bank.example 🔴 high" }));
    expect(xml).toContain(
      '<text hint-style="body" hint-wrap="true" hint-maxLines="2">bank.example  high</text>',
    );
    expect(buildMailToastXml(toast({ subject: "🚫" }))).toContain(">(no subject)</text>");
  });

  it("has one button per effect, each a fixed word that fits a row of four", () => {
    for (const label of Object.values(BUTTON_LABELS)) {
      expect(label.length).toBeLessThanOrEqual(BUTTON_LABEL_MAX);
    }
    expect(buttons(buildMailToastXml(toast({ rejectsAtServer: true }), ON))).toEqual([
      ["Junk", "junk"],
      ["Trash", "trash"],
      ["Block", "reject"],
      ["Mute", "quiet"],
    ]);
  });

  it("keeps Block off the toast until the person turned it on in Settings, even where the server can refuse the sender", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: true }));
    expect(buttons(xml).map(([label]) => label)).toEqual(["Junk", "Trash", "Mute"]);
    expect(xml).not.toContain("act=reject");
    // Nothing is missing from the mailbox, so there is no note: only the two columns.
    expect(xml.match(/<subgroup/gu)).toHaveLength(2);
  });

  it("has no Block button when nothing can refuse the mail at the server, whatever Settings say", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: false }), ON);
    expect(buttons(xml)).toEqual([
      ["Junk", "junk"],
      ["Trash", "trash"],
      ["Mute", "quiet"],
    ]);
    expect(xml).not.toContain("act=reject");
    expect(xml).not.toContain('content="Block"');
  });

  it("builds the same buttons whatever the person's default action is", () => {
    for (const defaultAction of ["junk", "trash"] as const) {
      const xml = buildMailToastXml(toast({ rejectsAtServer: true }), { ...ON, defaultAction });
      expect(buttons(xml).map(([label]) => label)).toEqual(["Junk", "Trash", "Block", "Mute"]);
    }
  });

  it("offers who the buttons apply to as a choice above them, starting on the sender", () => {
    const xml = buildMailToastXml(toast());
    expect(xml).toContain(
      '<actions><input id="scope" type="selection" defaultInput="sender">' +
        '<selection id="sender" content="Only this sender"/>' +
        '<selection id="domain" content="Whole domain example.com"/></input><action ',
    );
    expect(xml.match(/<input /gu)).toHaveLength(1);
    expect(xml).not.toContain('defaultInput="domain"');
  });

  it("leaves the choice out when the domain must not be blocked", () => {
    const xml = buildMailToastXml(toast({ domain: null, rejectsAtServer: true }), ON);
    expect(xml).not.toContain("<input");
    expect(xml).not.toContain("<selection");
    expect(buttons(xml)).toHaveLength(4);
  });

  it("names a short domain in full in the choice", () => {
    const fits = `${"a".repeat(DOMAIN_CHOICE_MAX - 8)}.example`;
    expect(fits).toHaveLength(DOMAIN_CHOICE_MAX);
    expect(buildMailToastXml(toast({ domain: fits }))).toContain(`content="Whole domain ${fits}"`);
  });

  it.each([
    ["bank.example.attacker.test", "…attacker.test"],
    ["paypal.com.attacker.test", "…com.attacker.test"],
    [`${"a".repeat(30)}.test`, `…${"a".repeat(15)}.test`],
    [`mail.${"b".repeat(30)}`, `…${"b".repeat(20)}`],
    [`${"b".repeat(20)}.github.io`, `…${"b".repeat(10)}.github.io`],
  ])(
    "keeps the end of the long domain %s in the choice, which Windows would cut",
    (domain, shown) => {
      const xml = buildMailToastXml(toast({ domain }));
      expect(xml).toContain(`content="Whole domain ${shown}"`);
      expect(shown.length).toBeLessThanOrEqual(DOMAIN_CHOICE_MAX + 1);
    },
  );

  it("cannot be broken out of by a domain in the choice", () => {
    const xml = buildMailToastXml(toast({ domain: 'a"/><x' }));
    expect(xml).toContain('content="Whole domain a&quot;/&gt;&lt;x"');
    expect(xml).not.toContain("<x");
  });

  it("never puts text from a mail on a button", () => {
    const hostile = `Block" arguments="act=reject;id=${ID}`;
    const xml = buildMailToastXml(
      toast({
        sender: `${hostile}@example.com`,
        subject: hostile,
        account: hostile,
        domain: hostile,
      }),
    );
    expect(buttons(xml)).toEqual([
      ["Junk", "junk"],
      ["Trash", "trash"],
      ["Mute", "quiet"],
    ]);
    expect(xml.match(/<action /gu)).toHaveLength(3);
  });

  it("shows a Gmail message with Trash and Mute only, and no choice (a Gmail filter has no other action)", () => {
    const xml = buildMailToastXml(
      toast({ trashOnly: true, domain: null, rejectsAtServer: false }),
      { buttonStyle: true },
    );
    expect(buttons(xml)).toEqual([
      ["Trash", "trash"],
      ["Mute", "quiet"],
    ]);
    expect(xml).toContain(note("Gmail has no whole-domain or block-at-server option"));
    expect(xml).not.toContain("<input");
    expect(xml).not.toContain("<selection");
    // Red is for the one button that keeps no copy: a Gmail toast has none.
    expect(xml).not.toContain("hint-buttonStyle");
    // Even if a caller asks for the server or the domain, a trash-only toast does not show them.
    const asked = buildMailToastXml(
      toast({ trashOnly: true, rejectsAtServer: true, domain: "example.com" }),
      ON,
    );
    expect(asked).not.toContain("act=reject");
    expect(asked).not.toContain("act=junk");
    expect(asked).not.toContain("<input");
  });

  it("reads a click on the Gmail Trash button as this sender (blockPending holds it to Trash)", () => {
    expect(parseActivation({ arguments: `act=trash;id=${ID}` })).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "trash" },
    });
  });

  it("omits the score when the server sent none", () => {
    const xml = buildMailToastXml(toast({ spamScore: null }));
    expect(xml).toContain(
      '<text hint-style="captionSubtle" hint-maxLines="1">To: info@example.com</text>',
    );
    expect(xml).not.toContain("Spam");
    // One column and the note.
    expect(xml.match(/<subgroup/gu)).toHaveLength(2);
  });

  it.each([
    [1.6, "low"],
    [SPAM_MEDIUM, "medium"],
    [SPAM_HIGH, "high"],
  ] as const)("draws the strip of the level of score %s", (spamScore, level) => {
    const spamStrips = {
      low: "file:///a/low.png",
      medium: "file:///a/medium.png",
      high: "file:///a/high.png",
    };
    const xml = buildMailToastXml(toast({ spamScore }), { spamStrips });
    expect(xml).toContain(`<image src="file:///a/${level}.png" alt="Spam score: ${level}"/>`);
    expect(xml.match(/<image /gu)).toHaveLength(1);
  });

  it("draws no strip without a score or without strips", () => {
    const spamStrips = {
      low: "file:///a/s.png",
      medium: "file:///a/s.png",
      high: "file:///a/s.png",
    };
    expect(buildMailToastXml(toast({ spamScore: null }), { spamStrips })).not.toContain("<image");
    expect(buildMailToastXml(toast())).not.toContain("<image");
  });

  it("keeps a long strip path whole, and cannot be broken out of by it", () => {
    const long = `file:///${"a".repeat(TOAST_TEXT_MAX)}.png`;
    const spamStrips = { low: long, medium: long, high: `${long}"/><x` };
    expect(buildMailToastXml(toast(), { spamStrips })).toContain(`<image src="${long}"`);
    const xml = buildMailToastXml(toast({ spamScore: SPAM_HIGH }), { spamStrips });
    expect(xml).toContain(`${long}&quot;/&gt;&lt;x`);
    expect(xml).not.toContain("<x");
  });

  it("cannot be broken out of by a hostile subject or account label", () => {
    const hostile = `</text></binding></visual><actions><action content="Block" arguments="act=reject;id=${ID}"/>`;
    const xml = buildMailToastXml(toast({ subject: hostile, account: hostile }));
    // Exactly the three buttons we wrote: the hostile text added no element.
    expect(xml.match(/<action /gu)).toHaveLength(3);
    // The mailbox, the two lines of the sender, the subject, the two of the score and the fixed note.
    expect(xml.match(/<text /gu)).toHaveLength(7);
    expect(xml).not.toContain(hostile);
  });

  it("refuses an id that is not a notification id", () => {
    expect(() => buildMailToastXml(toast({ id: `${ID}" x="` }))).toThrow();
  });

  it("makes Block the one red button, only when the caller says Windows can draw it", () => {
    const blockable = toast({ rejectsAtServer: true });
    expect(buildMailToastXml(blockable, ON)).not.toContain("useButtonStyle");
    expect(buildMailToastXml(blockable, ON)).not.toContain("hint-buttonStyle");
    const xml = buildMailToastXml(blockable, { ...ON, buttonStyle: true });
    expect(xml).toContain('useButtonStyle="true"');
    expect(xml.match(/hint-buttonStyle/gu)).toHaveLength(1);
    expect(xml).toMatch(/content="Block"[^>]*hint-buttonStyle="Critical"/u);
    expect(xml).not.toContain('activationType="system"');
    // Nothing to refuse the mail with: no red button.
    expect(buildMailToastXml(toast(), { buttonStyle: true })).not.toContain("hint-buttonStyle");
  });

  it.each([
    [
      { domain: "example.com", rejectsAtServer: false },
      "This mailbox has no block-at-server option",
    ],
    [
      { domain: null, rejectsAtServer: false },
      "No whole-domain or block-at-server option for this sender",
    ],
    [{ domain: null, rejectsAtServer: true }, "No whole-domain option for this sender"],
    [
      { domain: "example.com", rejectsAtServer: true },
      "Block is for one sender. A domain moves to Junk",
    ],
  ])(
    "says what is missing from %j under the subject, not between the mailbox and the sender",
    (over, text) => {
      const xml = buildMailToastXml(toast(over), ON);
      expect(xml).toContain(`</group>${note(text)}</binding>`);
      expect(xml).not.toContain("attribution");
    },
  );

  it("says where a whole domain goes with Block, in the person's default folder", () => {
    expect(
      buildMailToastXml(toast({ rejectsAtServer: true }), { ...ON, defaultAction: "trash" }),
    ).toContain(note("Block is for one sender. A domain moves to Trash"));
  });

  it("says a mail is over the person's limit, first", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: true, overSpamLimit: true }), ON);
    expect(xml).toContain(
      note("Over your spam limit. Block is for one sender. A domain moves to Junk"),
    );
    expect(buttons(xml)).toHaveLength(4);
  });

  it("adds what the mailbox cannot offer to the same line", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: false, overSpamLimit: true }), {
      defaultAction: "trash",
    });
    expect(xml).toContain("Over your spam limit. This mailbox has no block-at-server option");
  });

  it("says nothing of a limit for other mail", () => {
    expect(buildMailToastXml(toast({ rejectsAtServer: true }))).not.toContain("spam limit");
  });

  it("leaves the Gmail toast as it is whatever the settings say", () => {
    const xml = buildMailToastXml(toast({ trashOnly: true, domain: null }), {
      ...ON,
      defaultAction: "junk",
    });
    expect(buttons(xml).map(([label]) => label)).toEqual(["Trash", "Mute"]);
    expect(xml).not.toContain("defaultInput");
  });

  it.each(["short", "long"] as const)("keeps a toast on screen for %s", (toastDuration) => {
    for (const shape of [toast(), toast({ trashOnly: true, domain: null })]) {
      expect(buildMailToastXml(shape, { toastDuration })).toContain(
        `<toast duration="${toastDuration}"`,
      );
    }
  });

  it("keeps a toast until it is closed with the reminder scenario, the ordinary sound and no system button", () => {
    const plain = buildMailToastXml(toast(), { toastDuration: "until-closed", buttonStyle: true });
    expect(plain).toContain('<toast scenario="reminder" useButtonStyle="true"');
    expect(plain).not.toContain("duration=");
    expect(plain).toContain(
      '</visual><audio src="ms-winsoundevent:Notification.Default"/><actions>',
    );
    expect(plain.match(/<action /gu)).toHaveLength(3);
    expect(plain).not.toContain('activationType="system"');
    const gmail = buildMailToastXml(toast({ trashOnly: true, domain: null }), {
      toastDuration: "until-closed",
    });
    expect(gmail).toContain('<toast scenario="reminder" launch=');
    expect(gmail).toContain("<audio ");
  });

  it("gives a timed toast no sound of its own", () => {
    expect(buildMailToastXml(toast())).not.toContain("<audio");
  });

  it("ignores a click on the system Dismiss, the toast body or the close button (nothing to do)", () => {
    for (const args of ["dismiss", "", "snooze"]) {
      expect(parseActivation({ arguments: args })).toEqual({ ok: false, reason: "not-a-button" });
    }
  });

  it("shows an empty subject as a placeholder", () => {
    expect(buildMailToastXml(toast({ subject: "" }))).toContain(
      '<text hint-style="body" hint-wrap="true" hint-maxLines="2">(no subject)</text>',
    );
  });
});

describe("the size of a toast", () => {
  it("stays well under what Windows refuses, with hostile text and a long path", () => {
    const hostile = "'".repeat(1_000);
    const long = `file:///${"é".repeat(200)}.png`;
    const xml = buildMailToastXml(
      toast({
        sender: hostile,
        subject: hostile,
        account: hostile,
        domain: hostile,
        rejectsAtServer: true,
      }),
      {
        toastDuration: "until-closed",
        ...ON,
        buttonStyle: true,
        spamStrips: { low: long, medium: long, high: long },
      },
    );
    // Measured on Windows 11 (2026-10-31): 10,991 characters showed, 39,991 were refused.
    expect(xml.length).toBeLessThan(6_000);
  });

  it("stays under what Windows was seen to show when every click also carries the longest sender", () => {
    const sender = `${"'".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(60)}.example`;
    const hostile = "'".repeat(1_000);
    const xml = buildMailToastXml(
      toast({
        accountId: "a".repeat(64),
        issuedAt: 9_999_999_999,
        sender,
        subject: hostile,
        account: hostile,
        domain: hostile,
        rejectsAtServer: true,
      }),
      {
        toastDuration: "until-closed",
        ...ON,
        buttonStyle: true,
        signer,
        spamStrips: {
          low: `file:///${"é".repeat(200)}.png`,
          medium: `file:///${"é".repeat(200)}.png`,
          high: `file:///${"é".repeat(200)}.png`,
        },
      },
    );
    expect(xml).toContain(`;from=${"&apos;".repeat(64)}@`);
    expect(xml.length).toBeLessThan(10_991);
  });
});

describe("spamLevel", () => {
  it("draws the lines at SPAM_MEDIUM and SPAM_HIGH", () => {
    expect(spamLevel(-3)).toBe("low");
    expect(spamLevel(SPAM_MEDIUM - 0.1)).toBe("low");
    expect(spamLevel(SPAM_MEDIUM)).toBe("medium");
    expect(spamLevel(SPAM_HIGH - 0.1)).toBe("medium");
    expect(spamLevel(SPAM_HIGH)).toBe("high");
  });

  it("says the level with a dot and the word, so colour is never the only cue", () => {
    expect(buildMailToastXml(toast({ spamScore: SPAM_MEDIUM }))).toContain(">🟡 medium<");
    expect(buildMailToastXml(toast({ spamScore: SPAM_HIGH }))).toContain(">🔴 high<");
  });
});

describe("parseActivation, a toast of an earlier version", () => {
  const click = (args: string, userInputs?: Record<string, string>) => ({
    type: "click",
    arguments: args,
    ...(userInputs === undefined ? {} : { userInputs }),
  });

  it("reads the sender button, Junk when no choice came back", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "junk" },
    });
  });

  it("reads the domain button with the Trash choice", () => {
    expect(parseActivation(click(`act=open;id=${ID}`, { target: "trash" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: REOPEN_CHOICE },
    });
    expect(buildMailToastXml(toast())).toContain(`launch="act=open;id=${ID}"`);
    expect(parseActivation(click(`act=domain;id=${ID}`, { target: "trash" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "domain", action: "trash" },
    });
  });

  it("reads Block at server on the sender button", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`, { target: "reject" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "reject" },
    });
  });

  it("turns Block at server into Junk on the domain button: a whole domain is never refused at the server", () => {
    expect(parseActivation(click(`act=domain;id=${ID}`, { target: "reject" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "domain", action: "junk" },
    });
  });

  it.each([
    ["an empty click (toast body or Windows' own button)", click("")],
    ["an unknown act", click(`act=discard;id=${ID}`)],
    ["a non-uuid id", click("act=sender;id=../../x")],
    ["an uppercase id", click(`act=sender;id=${ID.toUpperCase()}`)],
    ["extra fields in the arguments", click(`act=sender;id=${ID};x=1`)],
    ["an oversize argument", click(`act=sender;id=${ID}${"a".repeat(ACTIVATION_ARGUMENTS_MAX)}`)],
    ["no arguments key", { type: "click" }],
    ["a string instead of an object", "act=sender"],
    ["null", null],
  ])("ignores %s", (_name, details) => {
    expect(parseActivation(details).ok).toBe(false);
  });

  it("falls back to the person's default action when no choice came back", () => {
    expect(parseActivation({ arguments: `act=sender;id=${ID}` }, "trash")).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "trash" },
    });
  });

  it("turns Block at server into the default action on the domain button", () => {
    expect(
      parseActivation(
        { arguments: `act=domain;id=${ID}`, userInputs: { target: "reject" } },
        "trash",
      ),
    ).toEqual({ ok: true, activation: { id: ID, scope: "domain", action: "trash" } });
  });

  it("reads Don't ask again on either button, and it never turns into a block", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`, { target: "quiet" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "quiet" },
    });
    expect(parseActivation(click(`act=domain;id=${ID}`, { target: "quiet" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "domain", action: "quiet" },
    });
  });

  it("reads Gmail's own Don't ask again button, whatever a choice says", () => {
    expect(parseActivation(click(`act=quiet;id=${ID}`, { target: "reject" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "quiet" },
    });
  });

  it("refuses a choice that is not Junk or Trash instead of guessing", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`, { target: "discard" }))).toEqual({
      ok: false,
      reason: "unknown-choice",
    });
  });

  describe("a button that says what, with the choice of who above it", () => {
    it.each(["junk", "trash", "reject"] as const)(
      "reads %s as this sender when no choice came back",
      (action) => {
        expect(parseActivation(click(`act=${action};id=${ID}`), "trash")).toEqual({
          ok: true,
          activation: { id: ID, scope: "address", action },
        });
      },
    );

    it("reads who from the choice", () => {
      expect(parseActivation(click(`act=trash;id=${ID}`, { scope: "sender" }))).toEqual({
        ok: true,
        activation: { id: ID, scope: "address", action: "trash" },
      });
      expect(parseActivation(click(`act=trash;id=${ID}`, { scope: "domain" }))).toEqual({
        ok: true,
        activation: { id: ID, scope: "domain", action: "trash" },
      });
    });

    it("turns Block into the default action with the whole domain chosen: a whole domain is never refused at the server", () => {
      expect(parseActivation(click(`act=reject;id=${ID}`, { scope: "domain" }))).toEqual({
        ok: true,
        activation: { id: ID, scope: "domain", action: "junk" },
      });
      expect(parseActivation(click(`act=reject;id=${ID}`, { scope: "domain" }), "trash")).toEqual({
        ok: true,
        activation: { id: ID, scope: "domain", action: "trash" },
      });
    });

    it("reads Mute for the sender or the whole domain, and it never turns into a block", () => {
      expect(parseActivation(click(`act=quiet;id=${ID}`))).toEqual({
        ok: true,
        activation: { id: ID, scope: "address", action: "quiet" },
      });
      expect(parseActivation(click(`act=quiet;id=${ID}`, { scope: "domain" }))).toEqual({
        ok: true,
        activation: { id: ID, scope: "domain", action: "quiet" },
      });
    });

    it("takes what happens from the button alone, whatever an input of an earlier version says", () => {
      expect(parseActivation(click(`act=junk;id=${ID}`, { target: "reject" }))).toEqual({
        ok: true,
        activation: { id: ID, scope: "address", action: "junk" },
      });
    });

    it("refuses a choice of who that is not the sender or the domain instead of guessing", () => {
      for (const scope of ["everyone", "", "Domain"]) {
        expect(parseActivation(click(`act=junk;id=${ID}`, { scope }))).toEqual({
          ok: false,
          reason: "unknown-scope",
        });
      }
    });
  });

  it("never puts the input into the reason", () => {
    const result = parseActivation(click("act=sender;id=SECRET-subject-text"));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("a click that outlives the app", () => {
  const click = (args: string, userInputs?: Record<string, string>) => ({
    type: "click",
    arguments: args,
    ...(userInputs === undefined ? {} : { userInputs }),
  });
  const ACCOUNT = "gmail-bd3565c8.gmail";
  const FROM = "news@example.com";
  const SECONDS = 1_793_631_000;
  const mac = (act: string, id = ID, acct = ACCOUNT, from = FROM, t = SECONDS) =>
    signer.sign(act, id, acct, from, t);
  const tail = (act = "sender") =>
    `;acct=${ACCOUNT};from=${FROM};t=${String(SECONDS)};mac=${mac(act)}`;
  /** Signs a hand-written click the way a toast would, so a refusal is about the part under test and not the missing tag. */
  const signed = (args: string): string => {
    const m = /^act=(\w+);id=([^;]+);acct=([^;]*);from=(.*);t=([^;]*)$/u.exec(args);
    if (m === null) return `${args};mac=${mac("sender")}`;
    const [, act = "", id = "", acct = "", from = "", t = ""] = m;
    return `${args};mac=${mac(act, id, acct, from, Number(t))}`;
  };
  const parse = (args: string) => parseActivation(click(args), undefined, signer);

  it("puts the account, the sender and the time on every button when the caller gave them", () => {
    const xml = buildMailToastXml(
      toast({ accountId: ACCOUNT, issuedAt: SECONDS, rejectsAtServer: true }),
      { ...ON, signer },
    );
    for (const act of ["junk", "trash", "reject", "quiet"]) {
      expect(xml).toContain(`arguments="act=${act};id=${ID}${tail(act)}"`);
    }
    expect(xml).toContain(`launch="act=open;id=${ID}${tail("open")}"`);
  });

  it("writes no tail when the caller has no signer, so no toast carries a sender it cannot vouch for", () => {
    const xml = buildMailToastXml(toast({ accountId: ACCOUNT, issuedAt: SECONDS }));
    expect(xml).toContain(`arguments="act=junk;id=${ID}"`);
    expect(xml).not.toContain("from=");
    expect(xml).not.toContain("mac=");
  });

  it("escapes a sender that holds & or ' in the attribute, and parses it back", () => {
    const sender = "o'neil&co@example.com";
    const xml = buildMailToastXml(toast({ sender, accountId: ACCOUNT, issuedAt: 1 }), { signer });
    expect(xml).toContain(`from=o&apos;neil&amp;co@example.com;t=1;mac=`);
    expect(parse(signed(`act=sender;id=${ID};acct=${ACCOUNT};from=${sender};t=1`))).toMatchObject({
      ok: true,
      activation: { restore: { sender, issuedAt: 1 } },
    });
  });

  it("leaves the tail off when an account id would make a click the parser refuses", () => {
    const xml = buildMailToastXml(toast({ accountId: "x".repeat(65), issuedAt: 1 }), { signer });
    expect(xml).toContain(`arguments="act=junk;id=${ID}"`);
    expect(xml).not.toContain("acct=");
  });

  it("fits the longest address and account id inside ACTIVATION_ARGUMENTS_MAX", () => {
    const sender = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(63)}.com`;
    expect(sender).toHaveLength(254);
    const args = signed(`act=domain;id=${ID};acct=${"a".repeat(64)};from=${sender};t=9999999999`);
    expect(args).toHaveLength(420);
    expect(args.length).toBeLessThanOrEqual(ACTIVATION_ARGUMENTS_MAX);
    expect(parse(args).ok).toBe(true);
  });

  it("reads the tail as the restore of the click", () => {
    expect(parse(`act=sender;id=${ID}${tail()}`)).toEqual({
      ok: true,
      activation: {
        id: ID,
        scope: "address",
        action: "junk",
        restore: { accountId: ACCOUNT, sender: FROM, issuedAt: SECONDS },
      },
    });
    expect(parse(`act=reject;id=${ID}${tail("reject")}`)).toMatchObject({
      ok: true,
      activation: { action: "reject", scope: "address", restore: { sender: "news@example.com" } },
    });
    expect(parse(`act=quiet;id=${ID}${tail("quiet")}`)).toMatchObject({
      ok: true,
      activation: { action: "quiet", restore: { sender: "news@example.com" } },
    });
  });

  it.each([
    [
      "a sender that is not canonical",
      `act=sender;id=${ID};acct=${ACCOUNT};from=News@Example.com;t=1`,
    ],
    ["a sender with no @", `act=sender;id=${ID};acct=${ACCOUNT};from=nobody;t=1`],
    ["a look-alike domain", `act=sender;id=${ID};acct=${ACCOUNT};from=a@bаnk.com;t=1`],
    ["a part of the tail missing", `act=sender;id=${ID};acct=${ACCOUNT};t=1`],
    [
      "an account id over 64 characters",
      `act=sender;id=${ID};acct=${"a".repeat(65)};from=a@example.com;t=1`,
    ],
    ["an account id with a separator", `act=sender;id=${ID};acct=a;b;from=a@example.com;t=1`],
    ["a time that is not digits", `act=sender;id=${ID};acct=${ACCOUNT};from=a@example.com;t=-1`],
    [
      "a time over 10 digits",
      `act=sender;id=${ID};acct=${ACCOUNT};from=a@example.com;t=12345678901`,
    ],
    ["a second tail", `act=sender;id=${ID}${tail()}${tail()}`],
  ])("refuses %s", (_name, args) => {
    expect(parse(signed(args)).ok).toBe(false);
  });

  describe("the signature", () => {
    const other = createActivationSigner(Buffer.alloc(32, 9));
    const forged = (over: Partial<Record<"act" | "id" | "acct" | "from" | "t", string>> = {}) => {
      const f = { act: "sender", id: ID, acct: ACCOUNT, from: FROM, t: String(SECONDS), ...over };
      // Signed for the original fields, the sent ones changed after: what someone who cannot sign would have to do.
      return `act=${f.act};id=${f.id};acct=${f.acct};from=${f.from};t=${f.t};mac=${mac("sender")}`;
    };

    it("takes a tail only when its tag was made with this key", () => {
      expect(parse(`act=sender;id=${ID}${tail()}`).ok).toBe(true);
      expect(parseActivation(click(`act=sender;id=${ID}${tail()}`), undefined, other)).toEqual({
        ok: false,
        reason: "tail-refused",
      });
    });

    it.each([
      ["a sender changed after signing", { from: "boss@example.com" }],
      ["an account changed after signing", { acct: "other-lane" }],
      ["a time changed after signing", { t: "1793631001" }],
      ["an id changed after signing", { id: "1f8fad5b-d9cb-469f-a165-70867728950e" }],
      ["an action changed after signing", { act: "domain" }],
    ])("refuses %s", (_name, over) => {
      expect(parse(forged(over))).toEqual({ ok: false, reason: "tail-refused" });
    });

    it.each([
      ["a tail with no tag", `act=sender;id=${ID};acct=${ACCOUNT};from=${FROM};t=1`],
      ["a tag that is too short", `act=sender;id=${ID}${tail()}`.slice(0, -2)],
      ["a tag that is not base64url", `act=sender;id=${ID}${tail()}`.slice(0, -1) + "="],
    ])("refuses %s", (_name, args) => {
      expect(parse(args).ok).toBe(false);
    });

    it("hands over no sender when there is no key to check the tail with", () => {
      expect(parseActivation(click(`act=sender;id=${ID}${tail()}`))).toEqual({
        ok: true,
        activation: { id: ID, scope: "address", action: "junk" },
      });
    });

    it("refuses a key that is not 32 bytes", () => {
      expect(() => createActivationSigner(Buffer.alloc(16))).toThrow();
    });
  });
});
