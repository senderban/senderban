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

// Keeps its children and listeners so a drawn row can be walked; `querySelectorAll` answers only "button", as the scope choice asks.
function element(tag = "div"): FakeElement {
  const children: FakeElement[] = [];
  const listeners: Record<string, () => void> = {};
  const buttons = (): FakeElement[] =>
    children.flatMap((c) => [
      ...(c.tagName === "button" ? [c] : []),
      ...(c.querySelectorAll as (s: string) => FakeElement[])("button"),
    ]);
  const self: FakeElement = {
    tagName: tag,
    children,
    listeners,
    dataset: {},
    hidden: false,
    textContent: "",
    className: "",
    childElementCount: 0,
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    append: (...added: FakeElement[]) => {
      for (const child of added) {
        child.parentElement = self;
        children.push(child);
      }
    },
    addEventListener: (type: string, handler: () => void) => {
      listeners[type] = handler;
    },
    replaceChildren: () => undefined,
    querySelectorAll: (selector: string) => (selector === "button" ? buttons() : []),
    querySelector: (selector: string) => (selector === "button" ? (buttons()[0] ?? null) : null),
    contains: () => false,
    closest: () => null,
    focus: () => undefined,
  };
  return self;
}

function walk(root: FakeElement): FakeElement[] {
  return (root.children as FakeElement[]).flatMap((c) => [c, ...walk(c)]);
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function page(options: { announce: boolean; accounts?: string[]; watched?: string[] }) {
  let seq = 0;
  let targets = new Map<string, string>();
  let changed: (() => void) | null = null;
  const log: string[] = [];
  const sent: [string, string][] = [];
  const mails = ["a", "b", "c"].map((n, i) => ({
    account: options.accounts?.[i] ?? "me@mail.example",
    from: `${n}@x.example`,
    receivedMs: 1_000 - i,
    subject: `s${n}`,
    mark: "none",
    acts: ["junk", "trash"],
    domain: "x.example",
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
  const reads = { count: 0 };
  const api = {
    recent: () => {
      reads.count += 1;
      return later(5).then(look);
    },
    recentAct: async (key: string, act: string, scope: string) => {
      sent.push([act, scope]);
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
  const empty = element();
  const count = element();
  // The list and the mailbox choice keep what the page puts in them; the choice calls its change handler as a person would.
  const list: FakeElement & { drawn: unknown[] } = {
    ...element(),
    drawn: [],
    replaceChildren: (...children: unknown[]) => {
      list.drawn = children;
    },
  };
  const choice: FakeElement & {
    value: string;
    options: { value: string }[];
    builds: number;
    onChange: () => void;
  } = {
    ...element(),
    value: "",
    options: [],
    builds: 0,
    onChange: () => undefined,
    replaceChildren: (...children: { value: string }[]) => {
      choice.options = children;
      choice.builds += 1;
    },
    addEventListener: (_type: string, handler: () => void) => {
      choice.onChange = handler;
    },
  };
  const byId: Record<string, FakeElement> = {
    "recent-status": status,
    "recent-empty": empty,
    "recent-list": list,
    "recent-account": choice,
  };
  const context = vm.createContext({
    window: { senderban: api, setTimeout },
    document: {
      getElementById: (id: string) => byId[id] ?? element(),
      createElement: element,
      addEventListener: () => undefined,
      activeElement: null,
    },
    els: { title: element(), count },
    senderValue: element,
    pill: element,
    view: "recent",
    watch: null,
    watchedNames: () => options.watched ?? [],
    Intl,
  });
  vm.runInContext(
    `${SOURCE}\n;globalThis.__act = rcAct; globalThis.__view = () => rcView; globalThis.__load = rcLoad; globalThis.__row = rcRow;`,
    context,
  );
  const exposed = context as {
    __row: (row: unknown) => FakeElement;
    __act: (row: unknown, act: string, scope: string) => Promise<void>;
    __view: () => { rows: unknown[] } | null;
    __load: (refresh: boolean) => Promise<void>;
  };
  await exposed.__load(false);
  return { ...exposed, log, sent, status, empty, count, list, choice, mails, reads };
}

describe("Recent page clicks", () => {
  it("sends clicks on three rows one after another, each with the key of the newest look, while main announces each change", async () => {
    const p = await page({ announce: true });
    const rows = p.__view()?.rows ?? [];
    await Promise.all(rows.map((row, i) => p.__act(row, i === 1 ? "trash" : "junk", "address")));
    expect(p.log).toEqual(["a@x.example", "b@x.example", "c@x.example"]);
    expect(p.sent).toEqual([
      ["junk", "address"],
      ["trash", "address"],
      ["junk", "address"],
    ]);
  });

  it("says so when the clicked mail left the list before its turn", async () => {
    const p = await page({ announce: false });
    const row = { ...(p.__view()?.rows[0] as object), subject: "not on the list" };
    await p.__act(row, "junk", "address");
    expect(p.log).toEqual([]);
    expect(p.status.textContent).toBe("That mail is no longer in the list.");
  });

  it("sends the row's whole-domain choice with the click, and names the domain while it runs", async () => {
    const p = await page({ announce: false });
    const row = p.__view()?.rows[0];
    const run = p.__act(row, "reject", "domain");
    await later(1);
    expect(p.status.textContent).toBe("Blocking x.example…");
    await run;
    expect(p.sent).toEqual([["reject", "domain"]]);
  });

  it("hides Block while Whole domain is chosen, as a domain is never refused, and draws it hidden again after a redraw", async () => {
    const p = await page({ announce: false });
    const row = { ...(p.__view()?.rows[0] as object), acts: ["junk", "trash", "reject"] };
    const drawn = (li: FakeElement) => {
      const all = walk(li);
      const select = all.find((e) => e.tagName === "select") as FakeElement & { value?: string };
      const button = (act: string) =>
        all.find((e) => e.tagName === "button" && e.dataset.act === act);
      return { select, button };
    };
    const first = drawn(p.__row(row));
    expect(first.button("reject")?.hidden).toBe(false);

    first.select.value = "domain";
    (first.select.listeners as Record<string, () => void>).change?.();
    expect(first.button("reject")?.hidden).toBe(true);
    expect(["junk", "trash", "mute"].map((a) => first.button(a)?.hidden)).toEqual([
      false,
      false,
      false,
    ]);

    const again = drawn(p.__row(row));
    expect(again.select.value).toBe("domain");
    expect(again.button("reject")?.hidden).toBe(true);

    again.select.value = "address";
    (again.select.listeners as Record<string, () => void>).change?.();
    expect(again.button("reject")?.hidden).toBe(false);
  });
});

describe("Recent page mailbox choice", () => {
  it("is hidden for one mailbox and lists each mailbox once from two on", async () => {
    const one = await page({ announce: false });
    expect(one.choice.hidden).toBe(true);
    const two = await page({
      announce: false,
      accounts: ["a@mail.example", "b@mail.example", "a@mail.example"],
    });
    expect(two.choice.hidden).toBe(false);
    expect(two.choice.options.map((o) => o.value)).toEqual([
      "",
      "a@mail.example",
      "b@mail.example",
    ]);
    expect(two.list.drawn).toHaveLength(3);
  });

  it("shows only the chosen mailbox, reads nothing for it, and does not rebuild the choice while the names stay", async () => {
    const p = await page({
      announce: false,
      accounts: ["a@mail.example", "b@mail.example", "a@mail.example"],
    });
    const builds = p.choice.builds;
    const reads = p.reads.count;
    p.choice.value = "b@mail.example";
    p.choice.onChange();
    expect(p.list.drawn).toHaveLength(1);
    expect(p.count.textContent).toBe("1 mails, newest first");
    expect(p.choice.builds).toBe(builds);
    p.choice.value = "";
    p.choice.onChange();
    expect(p.list.drawn).toHaveLength(3);
    // A read (rcLoad) answers after 5 ms: waiting past it shows the choice asked main for nothing.
    await later(20);
    expect(p.reads.count).toBe(reads);
  });

  it("keeps a chosen mailbox whose last mail left the list, and says its Inbox is empty", async () => {
    const p = await page({
      announce: false,
      accounts: ["a@mail.example", "b@mail.example", "a@mail.example"],
    });
    p.choice.value = "b@mail.example";
    p.choice.onChange();
    p.mails.splice(1, 1);
    await p.__load(false);
    expect(p.choice.value).toBe("b@mail.example");
    expect(p.choice.options.map((o) => o.value)).toEqual(["", "a@mail.example", "b@mail.example"]);
    expect(p.choice.hidden).toBe(false);
    expect(p.list.drawn).toHaveLength(0);
    expect(p.empty.textContent).toBe("No mail in this Inbox.");
  });

  it("lists a watched mailbox with an empty Inbox, sorted, so its order does not follow the newest mail", async () => {
    const p = await page({
      announce: false,
      accounts: ["b@mail.example", "a@mail.example", "b@mail.example"],
      watched: ["c@mail.example"],
    });
    expect(p.choice.options.map((o) => o.value)).toEqual([
      "",
      "a@mail.example",
      "b@mail.example",
      "c@mail.example",
    ]);
    p.choice.value = "c@mail.example";
    p.choice.onChange();
    expect(p.list.drawn).toHaveLength(0);
    expect(p.empty.textContent).toBe("No mail in this Inbox.");
  });
});
