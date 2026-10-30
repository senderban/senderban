import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import type { Blocklist } from "../../src/blocklist.js";
import {
  DEFAULT_RENDER_OPTIONS,
  hasInclude,
  includeState,
  insertInclude,
  removeInclude,
  renderMain,
  renderRules,
  scriptSha256,
} from "../../src/sieve/rules.js";
import { parseRequireBlock, quote, stripComments } from "../../src/sieve/syntax.js";

const entry = (n: number, match: string, value: string, action = "junk") => ({
  id: `0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9d${String(n).padStart(2, "0")}`,
  match,
  value,
  action,
  createdAt: "2026-10-24T12:00:00.000Z",
});

const list = (...entries: ReturnType<typeof entry>[]) => entries as Blocklist;

describe("renderRules", () => {
  it("groups by match kind, sorts, and is deterministic", () => {
    const a = list(
      entry(1, "exactAddress", "B@Example.com"),
      entry(2, "exactAddress", "a@example.com"),
      entry(3, "exactDomain", "spam.example"),
      entry(4, "subdomains", "bulk.example"),
    );
    const text = renderRules(a, DEFAULT_RENDER_OPTIONS);
    expect(text).toContain('address :is "from" [\n    "a@example.com",\n    "b@example.com"\n  ]');
    expect(text).toContain(
      'address :domain :is "from" [\n    "bulk.example",\n    "spam.example"\n  ]',
    );
    expect(text).toContain('address :domain :matches "from" [\n    "*.bulk.example"\n  ]');
    expect(text).toContain('fileinto :create "Junk";\n  stop;');
    expect(renderRules([...a].reverse(), DEFAULT_RENDER_OPTIONS)).toBe(text);
  });

  it("files trash entries separately and skips empty groups", () => {
    const text = renderRules(list(entry(1, "exactAddress", "x@example.com", "trash")), {
      junkFolder: "Junk",
      trashFolder: "Deleted Items",
    });
    expect(text).toContain('fileinto :create "Deleted Items";');
    expect(text).not.toContain('"Junk"');
  });

  it("files a reject entry like Junk: the server refusal is another lane, this rule is the backup", () => {
    const text = renderRules(
      list(
        entry(1, "exactAddress", "refused@example.com", "reject"),
        entry(2, "exactAddress", "junked@example.com", "junk"),
      ),
      DEFAULT_RENDER_OPTIONS,
    );
    expect(text).toContain('"junked@example.com"');
    expect(text).toContain('"refused@example.com"');
    expect(text.match(/fileinto :create/gu)).toHaveLength(1);
    expect(text).toContain('fileinto :create "Junk";');
    expect(text).not.toContain("Trash");
  });

  it("renders an empty list as a valid no-op script", () => {
    expect(renderRules([], DEFAULT_RENDER_OPTIONS)).toBe(
      'require ["fileinto", "mailbox", "envelope"];\n# senderban-managed v1\n',
    );
  });

  it("refuses entries the core would refuse, including freemail domains", () => {
    expect(() =>
      renderRules(list(entry(1, "exactDomain", "gmail.com")), DEFAULT_RENDER_OPTIONS),
    ).toThrow(AdapterError);
    expect(() =>
      renderRules(list(entry(1, "exactAddress", 'a"b@example.com')), DEFAULT_RENDER_OPTIONS),
    ).toThrow(AdapterError);
  });

  it("refuses folder names that could break out of the string", () => {
    expect(() =>
      renderRules([], { junkFolder: 'Junk"; discard; "', trashFolder: "Trash" }),
    ).toThrow(AdapterError);
  });

  it("hashes ignoring CRLF", () => {
    expect(scriptSha256("a\r\nb\r\n")).toBe(scriptSha256("a\nb\n"));
  });
});

describe("quote", () => {
  it("escapes quote and backslash and rejects control characters", () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => quote("a\nb")).toThrow(RangeError);
  });
});

describe("parseRequireBlock", () => {
  it("handles no require, string, list, comments and several commands", () => {
    expect(parseRequireBlock("if true { keep; }")).toEqual({ end: 0, extensions: new Set() });
    expect(parseRequireBlock('require "fileinto";\nkeep;')).toEqual({
      end: 19,
      extensions: new Set(["fileinto"]),
    });
    const multi = '# top\nrequire ["fileinto", /* c */ "Variables"];\nREQUIRE "include";\nkeep;';
    const r = parseRequireBlock(multi);
    expect(r?.extensions).toEqual(new Set(["fileinto", "variables", "include"]));
    expect(multi.slice(r?.end)).toBe("\nkeep;");
  });

  it("returns null for anything it cannot read", () => {
    expect(parseRequireBlock('require "fileinto"')).toBeNull();
    expect(parseRequireBlock("require text:\nfileinto\n.\n;")).toBeNull();
    expect(parseRequireBlock('require ["a" "b"];')).toBeNull();
    expect(parseRequireBlock("/* never closed")).toBeNull();
  });
});

describe("multi-line strings", () => {
  const vacation = (body: string) =>
    `require ["vacation"];\nvacation text:\n${body}\n.\n;\ninclude :personal "senderban-rules";\n`;

  it.each([
    ["an odd quote", 'He said "back on Monday'],
    ["an open comment", "see /* here"],
    ["a hash", "# not a comment"],
    ["a doubled dot", ".."],
    ["a quote after a doubled dot", '..\n"odd'],
  ])("reads a script past %s in a vacation text", (_name, body) => {
    expect(includeState(vacation(body), "senderban-rules")).toBe("yes");
  });

  it("does not take an include line inside a text for a real one", () => {
    const script = 'vacation text:\ninclude :personal "senderban-rules";\n.\n;\n';
    expect(includeState(script, "senderban-rules")).toBe("no");
  });

  it("does not read `text:` inside a word or a string", () => {
    expect(stripComments('foo_text:\n"a"')).not.toBeNull();
    expect(includeState('"text:" ; include "senderban-rules";', "senderban-rules")).toBe("yes");
  });

  it("calls a text with no end unreadable, never no", () => {
    expect(includeState("vacation text:\nnever ends\n", "senderban-rules")).toBe("unreadable");
    expect(includeState('"open', "senderban-rules")).toBe("unreadable");
    expect(hasInclude('"open', "senderban-rules")).toBe(false);
  });
});

describe("stripComments / hasInclude", () => {
  it("ignores a commented-out include and keeps strings intact", () => {
    expect(stripComments('a # x\nb "#not a comment"')).toBe('a    \nb "#not a comment"');
    expect(hasInclude('# include :personal "senderban-rules";\nkeep;', "senderban-rules")).toBe(
      false,
    );
    expect(hasInclude('/* include :personal "senderban-rules"; */', "senderban-rules")).toBe(false);
    expect(
      hasInclude('require "include";\ninclude :personal "senderban-rules";', "senderban-rules"),
    ).toBe(true);
    expect(hasInclude('include "other";', "senderban-rules")).toBe(false);
  });
});

describe("insertInclude", () => {
  const rules = "senderban-rules";

  it("inserts after the require block, before the user's rules", () => {
    const user =
      'require ["fileinto"];\r\n\r\nif header :contains "subject" "x" {\r\n  fileinto "X";\r\n}\r\n';
    const out = insertInclude(user, rules);
    expect(out).toBe(
      'require ["fileinto"];\nrequire "include";\n# senderban-managed\ninclude :personal "senderban-rules";\n\nif header :contains "subject" "x" {\n  fileinto "X";\n}\n',
    );
    expect(hasInclude(out, rules)).toBe(true);
    expect(parseRequireBlock(out)?.extensions).toEqual(new Set(["fileinto", "include"]));
  });

  it('does not repeat require "include" and handles a script without requires', () => {
    expect(insertInclude('require ["include"];\nkeep;\n', rules)).toBe(
      'require ["include"];\n# senderban-managed\ninclude :personal "senderban-rules";\nkeep;\n',
    );
    expect(insertInclude("keep;\n", rules)).toBe(
      'require "include";\n# senderban-managed\ninclude :personal "senderban-rules";\nkeep;\n',
    );
    expect(insertInclude("", rules)).toBe(
      'require "include";\n# senderban-managed\ninclude :personal "senderban-rules";\n',
    );
  });

  it("refuses to edit a script it cannot parse", () => {
    expect(() => insertInclude('require "fileinto"\nkeep;', rules)).toThrow(AdapterError);
  });

  it("renderMain is a valid active script", () => {
    expect(renderMain(rules)).toBe(
      'require ["include"];\n# senderban-managed\ninclude :personal "senderban-rules";\n',
    );
    expect(() => renderMain("Bad Name")).toThrow(AdapterError);
  });
});

describe("removeInclude", () => {
  const rules = "senderban-rules";
  const original = 'require ["fileinto"];\r\nkeep;\r\n';

  it("restores the original exactly when the script is what insertInclude produced", () => {
    const edited = insertInclude(original, rules);
    expect(removeInclude(edited, rules, original)).toBe('require ["fileinto"];\nkeep;\n');
  });

  it("falls back to dropping our lines when the script changed since", () => {
    const edited = `${insertInclude(original, rules)}# later\n`;
    const out = removeInclude(edited, rules, original);
    expect(hasInclude(out, rules)).toBe(false);
    expect(out).toContain("# later");
    expect(out).toContain("keep;");
  });

  it("refuses when the include is not on a line of its own", () => {
    expect(() =>
      removeInclude(
        'require "include";\nif true { include :personal "senderban-rules"; }\n',
        rules,
        null,
      ),
    ).toThrow(AdapterError);
  });
});
