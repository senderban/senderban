import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// The Recent page script (assets/manage/recent.js) run in a bare context with a fake bridge that behaves as main does: each look
// gives every row a new key and drops the old ones, a key works once, and a click announces a change (`manage:changed`) before it
// answers, as `choose` and the mute path do.
const SOURCE = readFileSync(
  fileURLToPath(new URL("../assets/manage/recent.js", import.meta.url)),
  "utf8",
);

interface FakeElement {
  dataset: Record<string, string>;
  hidden: boolean;
  textContent: string;
  [name: string]: unknown;
}

function element(): FakeElement {
  return {
    dataset: {},
    hidden: false,
    textContent: "",
    className: "",
    childElementCount: 0,
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    append: () => undefined,
    addEventListener: () => undefined,
    replaceChildren: () => undefined,
    querySelectorAll: () => [],
    querySelector: () => null,
    contains: () => false,
    closest: () => null,
    focus: () => undefined,
  };
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function page(options: { announce: boolean }) {
  let seq = 0;
  let targets = new Map<string, string>();
  let changed: (() => void) | null = null;
  const log: string[] = [];
  const mails = ["a", "b", "c"].map((n, i) => ({
    account: "me@mail.example",
    from: `${n}@x.example`,
    receivedMs: 1_000 - i,
    subject: `s${n}`,
    mark: "none",
    blockAct: "junk",
  }));
  const look = () => {
    targets = new Map();
    return {
      starting: false,
      problems: [],
      rows: mails.map((m) => {
        seq += 1;
        const key = `k${String(seq)}`;
        targets.set(key, m.from);
        return { ...m, key };
      }),
    };
  };
  let running = 0;
  const api = {
    recent: () => later(5).then(look),
    recentAct: async (key: string) => {
      // Main takes one click at a time.
      if (running > 0) {
        log.push("refused: busy");
        return null;
      }
      running += 1;
      await later(5);
      const sender = targets.get(key);
      targets.delete(key);
      if (sender === undefined) {
        running -= 1;
        log.push("refused: out of date");
        return { tone: "warn", text: "This list is out of date." };
      }
      log.push(sender);
      if (options.announce) changed?.();
      await later(1);
      running -= 1;
      return { tone: "ok", text: "Done." };
    },
    onChanged: (callback: () => void) => {
      changed = callback;
    },
  };
  const status = element();
  const context = vm.createContext({
    window: { senderban: api, setTimeout },
    document: {
      getElementById: (id: string) => (id === "recent-status" ? status : element()),
      createElement: element,
      addEventListener: () => undefined,
      activeElement: null,
    },
    els: { title: element(), count: element() },
    senderValue: element,
    pill: element,
    view: "recent",
    watch: null,
    watchedNames: () => [],
    Intl,
  });
  vm.runInContext(
    `${SOURCE}\n;globalThis.__act = rcAct; globalThis.__view = () => rcView; globalThis.__load = rcLoad;`,
    context,
  );
  const exposed = context as {
    __act: (row: unknown, act: string) => Promise<void>;
    __view: () => { rows: unknown[] } | null;
    __load: (refresh: boolean) => Promise<void>;
  };
  await exposed.__load(false);
  return { ...exposed, log, status };
}

describe("Recent page clicks", () => {
  it("sends clicks on three rows one after another, each with the key of the newest look, while main announces each change", async () => {
    const p = await page({ announce: true });
    const rows = p.__view()?.rows ?? [];
    await Promise.all(rows.map((row) => p.__act(row, "block")));
    expect(p.log).toEqual(["a@x.example", "b@x.example", "c@x.example"]);
  });

  it("says so when the clicked mail left the list before its turn", async () => {
    const p = await page({ announce: false });
    const row = { ...(p.__view()?.rows[0] as object), subject: "not on the list" };
    await p.__act(row, "block");
    expect(p.log).toEqual([]);
    expect(p.status.textContent).toBe("That mail is no longer in the list.");
  });
});
