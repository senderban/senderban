/* exported stateBadge, leaveAddView, senderValue, accountChoices, accountHolds, accountEmpty */
// Runs in the sandboxed manage page. Every sender value came from a mail header (untrusted), so it
// is only ever assigned through textContent. This file holds the frame (views, side bar, restart
// bar) and the block list; the other page scripts share its global scope.
const api = window.senderban;
const $ = (id) => document.getElementById(id);

const els = {
  title: $("title"),
  count: $("count"),
  goAdd: $("go-add"),
  firstRun: $("first-run"),
  firstAdd: $("first-add"),
  filter: $("filter"),
  filterRow: $("filter-row"),
  filterAccount: $("filter-account"),
  tabs: $("tabs"),
  behind: $("behind"),
  list: $("list"),
  empty: $("empty"),
  listCap: $("list-cap"),
  localNote: $("local-note"),
  status: $("status"),
  notice: $("notice"),
  navHome: $("nav-home"),
  navSponsor: $("nav-sponsor"),
  homeBody: $("home-body"),
  homeBlockedLabel: $("home-blocked-label"),
  homeBlockedNum: $("home-blocked-num"),
  homeWeek: $("home-week"),
  homeTrace: $("home-trace"),
  homeChart: $("home-chart"),
  homeChartFrom: $("home-chart-from"),
  homeSplit: $("home-split"),
  lampWatch: $("lamp-watch"),
  lampWatchText: $("lamp-watch-text"),
  lampBlocks: $("lamp-blocks"),
  lampBlocksText: $("lamp-blocks-text"),
  lampSync: $("lamp-sync"),
  lampSyncText: $("lamp-sync-text"),
  homeBoxes: $("home-boxes"),
  homeBoxesMore: $("home-boxes-more"),
  homeBoxesEmpty: $("home-boxes-empty"),
  homeManage: $("home-manage"),
  homeRecent: $("home-recent"),
  homeRecentEmpty: $("home-recent-empty"),
  homeAll: $("home-all"),
  navBlocked: $("nav-blocked"),
  navAccounts: $("nav-accounts"),
  navQuiet: $("nav-quiet"),
  navSettings: $("nav-settings"),
  navHelp: $("nav-help"),
  navHelpCount: $("nav-help-count"),
  updatesCard: $("settings-updates-card"),
  navBlockedCount: $("nav-blocked-count"),
  navAccountsCount: $("nav-accounts-count"),
  health: $("health"),
  healthText: $("health-text"),
  pause: $("pause"),
  version: $("version"),
  restartBar: $("restart-bar"),
  restartText: $("restart-text"),
  restart: $("restart"),
  accountsEmpty: $("accounts-empty"),
};

// A list can hold thousands of entries; the page draws a bounded slice and the filter narrows it.
const VISIBLE_MAX = 500;
// The row says what is normal in plain words on one quiet line; a pill (a dot and a word) is kept for what needs a look.
const MATCH_WORD = { exactDomain: "Domain only", subdomains: "Whole domain" };
const ACTION_WORD = { junk: "Junk", trash: "Trash", reject: "Junk" };
const AT_SERVER_WORD = "Refused at server";
const REJECT_PILL = ["warn", "Server block not confirmed"];
const UNCONFIRMED_PILL = ["warn", "Not confirmed"];

// A Gmail account that could not take the entry; the normal case (a Trash filter) needs no word.
const GMAIL_PILL = { no: ["warn", "Gmail: not applied"] };
// A domain on a Microsoft account is a text match: it can also catch longer domains that start the same way, and one that would catch the person's own mail is not written.
const OUTLOOK_PILL = {
  wide: ["warn", "Outlook: text match"],
  no: ["warn", "Outlook: not applied"],
};
const OWN_PILL = ["warn", "Not applied: your own mail"];
const HOME_RECENT = 4;
const HOME_WEEKS = 12;
const HOME_BOXES = 6;

const TABS = [
  { id: "all", label: "All", holds: () => true },
  { id: "server", label: "At server", holds: (e) => e.atServer },
  {
    id: "junk",
    label: "Junk",
    holds: (e) => e.action !== "trash" && !e.atServer && e.own !== true,
  },
  { id: "trash", label: "Trash", holds: (e) => e.action === "trash" },
  {
    id: "not",
    label: "Needs a look",
    holds: (e) => e.applied !== "yes" || e.gmail === "no" || e.outlook === "no",
  },
];

// A watcher's state as the row says it: in words, never by colour alone.
const STATE_LABEL = {
  watching: ["ok", "Watching"],
  connecting: ["", "Connecting"],
  starting: ["", "Connecting"],
  backoff: ["warn", "Reconnecting"],
  stopped: ["warn", "Stopped"],
  halted: ["error", "Stopped. See the log"],
  "halted-auth": ["error", "Sign in again"],
  "halted-rejected": ["error", "Stopped. See the log"],
};

const VIEW_TITLE = {
  home: "Home",
  blocked: "Blocked senders",
  accounts: "Accounts",
  add: "Add mailbox",
  quiet: "Don't ask again",
  settings: "Settings",
  help: "Help",
};

let entries = [];
// False until the first read of the list worked: until then Home says nothing about it.
let entriesLoaded = false;
let busy = false;
let tab = "all";
let view = "home";
let watch = null;
// The mailbox names of the last status, to tell when the account choice of a list has to be rebuilt.
let watchedKey = "";
let pausing = false;
let restarting = false;

function setStatus(tone, text) {
  els.status.hidden = text === "";
  els.status.dataset.tone = tone;
  els.status.textContent = text;
}

/** The one line for what a step did, above the views, so that it survives the step moving to another view. */
function setNotice(tone, text) {
  els.notice.hidden = text === "";
  els.notice.dataset.tone = tone;
  els.notice.textContent = text;
}

function pill(tone, text) {
  const span = document.createElement("span");
  span.className = "pill";
  if (tone !== "") span.dataset.tone = tone;
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  span.append(dot, document.createTextNode(text));
  return span;
}

/** A row's watcher word. It redraws by itself when the status changes (`drawStates`). */
function stateBadge(accountId) {
  const span = document.createElement("span");
  span.className = "state";
  span.dataset.account = accountId;
  fillBadge(span);
  return span;
}

function fillBadge(span) {
  const known = watch?.accounts.find((a) => a.accountId === span.dataset.account);
  const [tone, text] =
    watch?.paused === true && known?.state === "stopped"
      ? ["warn", "Paused"]
      : (STATE_LABEL[known?.state] ?? ["warn", "Not watching"]);
  span.replaceChildren(pill(tone, text));
}

function drawStates() {
  for (const span of document.querySelectorAll(".state")) fillBadge(span);
}

/** The local part is dimmed and the domain is not: the domain is what a look-alike address has to change. */
function senderValue(value) {
  const node = document.createElement("div");
  node.className = "value";
  node.title = value;
  const at = value.lastIndexOf("@");
  if (at === -1) {
    node.classList.add("plain");
    node.textContent = value;
    return node;
  }
  const local = document.createElement("span");
  local.className = "local";
  local.textContent = value.slice(0, at + 1);
  const domain = document.createElement("span");
  domain.className = "domain";
  domain.textContent = value.slice(at + 1);
  node.append(local, domain);
  return node;
}

// The account filter of a list. "" is every account; NOT_RECORDED is the rows made before 0.3, which carry no mailbox (a mailbox
// name is 3 characters or more, so it cannot be "-").
const NOT_RECORDED = "-";

function option(value, text) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
}

/** The mailboxes that are set up, under the name a block made from them keeps as its source (null until the watcher exists). */
function watchedNames() {
  return (watch?.accounts ?? []).map((a) => a.label).filter((name) => typeof name === "string");
}

/**
 * Offers every mailbox that is set up and every one a row came from, each with its count, so the choice explains itself: a list
 * made before 0.3 shows its mailboxes at 0 and its rows under "Not recorded". Rebuilt only when a name or a count changes, so a
 * choice survives a refresh; a choice that is gone falls back to all.
 */
function accountChoices(select, rows) {
  const counts = new Map(watchedNames().map((name) => [name, 0]));
  let unrecorded = 0;
  for (const r of rows) {
    if (r.source === undefined) unrecorded += 1;
    else counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  }
  const choices = [["", "All accounts"]];
  for (const name of [...counts.keys()].sort()) {
    choices.push([name, `${name} · ${String(counts.get(name))}`]);
  }
  if (unrecorded > 0 && counts.size > 0) {
    choices.push([NOT_RECORDED, `Not recorded (before 0.3) · ${String(unrecorded)}`]);
  }
  const key = choices.map(([, text]) => text).join("\n");
  if (select.dataset.key === key) return;
  const wanted = select.value;
  select.replaceChildren(...choices.map(([value, text]) => option(value, text)));
  select.dataset.key = key;
  select.value = choices.some(([value]) => value === wanted) ? wanted : "";
}

/**
 * Why a mailbox's list is empty when the reason is the list's age: rows made before 0.3 carry no mailbox. Null when another
 * filter (the text, a tab) is the reason.
 */
function accountEmpty(select, rows, needle) {
  const wanted = select.value;
  if (needle !== "" || wanted === "" || wanted === NOT_RECORDED) return null;
  if (rows.some((r) => r.source === wanted)) return null;
  const unrecorded = rows.filter((r) => r.source === undefined).length;
  if (unrecorded === 0) return "Nothing was added from this mailbox.";
  return `Nothing was added from this mailbox since 0.3. ${String(unrecorded)} older ${
    unrecorded === 1 ? "entry is" : "entries are"
  } under "Not recorded (before 0.3)": Senderban did not keep the mailbox then.`;
}

function accountHolds(select, row) {
  const wanted = select.value;
  if (wanted === "") return true;
  return wanted === NOT_RECORDED ? row.source === undefined : row.source === wanted;
}

const DATE = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** One quiet line: the mailbox the block came from (entries before 0.3 have none), where the mail goes, the date. */
function rowLine(entry, withSource) {
  const words = [];
  const scope = MATCH_WORD[entry.match];
  if (scope !== undefined) words.push(scope);
  // An entry over the person's own mail goes nowhere: its pill says so.
  if (entry.own !== true) {
    words.push(entry.atServer ? AT_SERVER_WORD : (ACTION_WORD[entry.action] ?? entry.action));
    // A Gmail filter can only trash: say where a Junk entry goes there.
    if (entry.gmail === "trash" && entry.action !== "trash") words.push("Gmail: Trash");
  }
  words.push(DATE.format(new Date(entry.createdAt)));
  const line = document.createElement("div");
  line.className = "meta line";
  const rest = document.createElement("span");
  rest.className = "facts";
  rest.textContent = words.join(" · ");
  if (withSource && entry.source !== undefined) {
    const from = document.createElement("span");
    from.className = "source";
    from.textContent = `from ${entry.source}`;
    rest.textContent = ` · ${rest.textContent}`;
    line.append(from);
  }
  line.append(rest);
  line.title = line.textContent;
  return line;
}

/** Only what needs a look: an entry over the person's own mail, a provider that did not take it, a block not read back. */
function rowPills(entry) {
  if (entry.own === true) return [pill(...OWN_PILL)];
  const pills = [];
  if (entry.action === "reject" && !entry.atServer) pills.push(pill(...REJECT_PILL));
  const gmail = GMAIL_PILL[entry.gmail];
  if (gmail !== undefined) pills.push(pill(...gmail));
  const outlook = OUTLOOK_PILL[entry.outlook];
  if (outlook !== undefined) pills.push(pill(...outlook));
  if (entry.applied === "unknown") pills.push(pill(...UNCONFIRMED_PILL));
  return pills;
}

function row(entry, { unblockButton = true, source = true } = {}) {
  const li = document.createElement("li");

  const what = document.createElement("div");
  what.className = "what";
  what.append(senderValue(entry.value), rowLine(entry, source));
  li.append(what);
  const pills = rowPills(entry);
  if (pills.length > 0) {
    const flags = document.createElement("div");
    flags.className = "flags";
    flags.append(...pills);
    li.append(flags);
  }
  if (!unblockButton) return li;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "small";
  button.textContent = "Unblock";
  button.setAttribute("aria-label", `Unblock ${entry.value}`);
  button.disabled = busy;
  button.addEventListener("click", () => void unblock(entry));

  li.append(button);
  return li;
}

const tabButtons = TABS.map((t) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab";
  button.addEventListener("click", () => {
    tab = t.id;
    render();
  });
  return { ...t, button };
});
els.tabs.append(...tabButtons.map((t) => t.button));

function render() {
  const needle = els.filter.value.trim().toLowerCase();
  accountChoices(els.filterAccount, entries);
  // Newest first: the store keeps the list oldest first.
  const found = entries
    .filter(
      (e) => (needle === "" || e.value.includes(needle)) && accountHolds(els.filterAccount, e),
    )
    .reverse();
  const holds = TABS.find((t) => t.id === tab)?.holds ?? (() => true);
  const matching = found.filter(holds);
  const shown = matching.slice(0, VISIBLE_MAX);

  els.list.replaceChildren(...shown.map(row));
  for (const t of tabButtons) {
    t.button.textContent = `${t.label} ${String(found.filter(t.holds).length)}`;
    t.button.setAttribute("aria-pressed", String(t.id === tab));
  }
  if (view === "blocked") {
    els.count.textContent =
      entries.length === 0
        ? ""
        : matching.length === entries.length
          ? `${String(entries.length)} blocked`
          : `${String(matching.length)} of ${String(entries.length)}`;
  }
  els.navBlockedCount.textContent = String(entries.length);

  drawHome();
  drawFirstRun();
  els.filterRow.hidden = entries.length === 0;
  // Every entry has the same `local` (any Other (IMAP) mailbox): one line for the list, not a word on each row.
  els.localNote.hidden = !entries.some((e) => e.local === true);
  els.tabs.hidden = entries.length === 0;
  els.empty.hidden = matching.length > 0;
  els.empty.textContent =
    entries.length === 0
      ? "Nothing is blocked yet. Block a sender from the notification that appears with a new mail."
      : (accountEmpty(els.filterAccount, entries, needle) ??
        "No blocked sender matches this filter.");
  els.listCap.hidden = matching.length <= shown.length;
  els.listCap.textContent = `Showing the first ${String(VISIBLE_MAX)} of ${String(matching.length)}. Type to narrow the list.`;
}

function drawFirstRun() {
  const firstRun = entries.length === 0 && watch !== null && watch.accounts.length === 0;
  els.firstRun.hidden = !firstRun;
  els.homeBody.hidden = firstRun;
}

// Home, the cockpit: one readout that leads (the count beside its twelve-week trace), three lamps that say whether anything
// needs a look, the mailboxes on watch and the newest blocks. All of it is drawn from the list and the status the page already
// holds: no request of its own.
// Scale: the list holds at most 5,000 entries (core MAX_ENTRIES) and the status at most 50 mailboxes (MAX_ACCOUNTS). Home is
// drawn only while it is the view: five passes over the list per list change or per entry into Home (measured 1.7 ms median at
// 5,000 entries, plain JS), 12 bars, at most HOME_BOXES mailbox rows and HOME_RECENT block rows. A status signal (at most 2 a
// second, manage.ts STATUS_PUSH_GAP_MS) walks the mailboxes, never the list.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
// CSS px. The top band holds a value label; the corner radius below the baseline is cut by the viewport, so a bar is round at
// the data end and square where it stands.
const CHART = { height: 76, top: 18, radius: 3, least: 3 };
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const LAST_BLOCK = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
// The provider word main adds to a mailbox's name: shown beside the address, not as part of its domain.
const BOX_TAG = / \((Gmail|Outlook)\)$/;
const SPLIT = [
  ["Junk", "junk"],
  ["Trash", "trash"],
  [AT_SERVER_WORD, "server"],
];

// How many blocks need a look, counted when the list changes; null until the list was read. The lamps redraw on every status
// signal and must not walk the list for it.
let homeLook = null;

function tabCount(id) {
  const holds = TABS.find((t) => t.id === id)?.holds ?? (() => false);
  return entries.filter(holds).length;
}

function svgNode(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** Blocks per rolling week, oldest first. The last bucket is the last 7 days: the span the line under the count names. */
function weekCounts(now) {
  const counts = new Array(HOME_WEEKS).fill(0);
  for (const e of entries) {
    // A clock that ran ahead when the block was made: it counts as now.
    const age = Math.max(0, Math.floor((now - Date.parse(e.createdAt)) / WEEK_MS));
    if (age < HOME_WEEKS) counts[HOME_WEEKS - 1 - age] += 1;
  }
  return counts;
}

/** One bar a week. Only the newest week wears the accent; it and the tallest week carry their number, the rest answer the pointer. */
function drawChart(counts, now) {
  const peak = Math.max(...counts);
  const peakAt = counts.lastIndexOf(peak);
  const newest = HOME_WEEKS - 1;
  const slot = 100 / HOME_WEEKS;
  const plot = CHART.height - CHART.top;
  const columns = counts.map((count, i) => {
    const from = new Date(now - (HOME_WEEKS - i) * WEEK_MS);
    const to = new Date(now - (newest - i) * WEEK_MS);
    const column = svgNode("g", {});
    const title = svgNode("title", {});
    title.textContent = `${SHORT_DATE.format(from)} to ${SHORT_DATE.format(to)}: ${String(count)} ${
      count === 1 ? "block" : "blocks"
    }`;
    column.append(
      title,
      svgNode("rect", {
        class: "wk-hit",
        x: `${String(i * slot)}%`,
        y: 0,
        width: `${String(slot)}%`,
        height: CHART.height,
      }),
    );
    if (count === 0) return column;
    // An older week is an outline and the newest is solid: told apart by shape, not by colour alone.
    const tall = Math.max(CHART.least, Math.round((count / peak) * plot));
    column.append(
      svgNode("rect", {
        class: i === newest ? "wk wk-now" : "wk",
        x: `${String((i + 0.2) * slot)}%`,
        y: CHART.height - tall,
        width: `${String(0.6 * slot)}%`,
        height: tall + CHART.radius,
        rx: CHART.radius,
      }),
    );
    if (i === newest || i === peakAt) {
      const label = svgNode("text", {
        class: "wk-label",
        x: `${String((i + 0.5) * slot)}%`,
        y: CHART.height - tall - 5,
        "text-anchor": "middle",
      });
      label.textContent = String(count);
      column.append(label);
    }
    return column;
  });
  const base = svgNode("line", {
    class: "wk-base",
    x1: 0,
    x2: "100%",
    y1: CHART.height - 0.5,
    y2: CHART.height - 0.5,
  });
  els.homeChart.replaceChildren(base, ...columns);
  const since = SHORT_DATE.format(new Date(now - HOME_WEEKS * WEEK_MS));
  // The same numbers as words, for a reader that cannot see the bars.
  els.homeChart.setAttribute(
    "aria-label",
    `Blocks per week for the last ${String(HOME_WEEKS)} weeks, from ${since}, oldest first: ${counts.join(", ")}.`,
  );
  els.homeChartFrom.textContent = since;
}

/** Where the mail of the blocked senders goes, as counts; a part with nothing in it is left out. */
function drawSplit() {
  const parts = [];
  for (const [word, id] of SPLIT) {
    const count = tabCount(id);
    if (count === 0) continue;
    const part = document.createElement("li");
    part.className = "fact";
    const num = document.createElement("span");
    num.className = "data";
    num.textContent = String(count);
    part.append(`${word} `, num);
    parts.push(part);
  }
  els.homeSplit.replaceChildren(...parts);
  els.homeSplit.hidden = parts.length === 0;
}

function setLamp(text, tone, words) {
  text.parentElement.dataset.tone = tone;
  // Written only when it changed: the strip is redrawn on every status signal.
  if (text.textContent !== words) text.textContent = words;
}

/**
 * Three lamps, each in words: the watchers, the blocks that need a look, the servers a block has not reached. A lamp that is
 * fine stays quiet (the stylesheet gives its words no colour) and one that is not takes the strip above the count.
 */
function drawLamps() {
  if (homeLook === null) setLamp(els.lampBlocksText, "working", "–");
  else if (entries.length === 0) setLamp(els.lampBlocksText, "working", "None yet");
  else {
    const look = homeLook;
    if (look === 0) setLamp(els.lampBlocksText, "ok", "Nothing to check");
    else {
      setLamp(
        els.lampBlocksText,
        "warn",
        `${String(look)} ${look === 1 ? "needs" : "need"} a look`,
      );
    }
  }
  if (watch === null) {
    setLamp(els.lampWatchText, "working", "–");
    setLamp(els.lampSyncText, "working", "–");
    return;
  }
  const total = watch.accounts.length;
  const running = watch.accounts.filter((a) => a.state === "watching").length;
  const signIn = watch.accounts.filter((a) => a.state === "halted-auth").length;
  const halted = watch.accounts.filter(
    (a) => a.state === "halted" || a.state === "halted-rejected",
  ).length;
  // The same words as the side bar; a watcher that stopped for good is said first, in the tone its row has.
  if (total === 0) setLamp(els.lampWatchText, "working", "No mailbox yet");
  else if (watch.paused) setLamp(els.lampWatchText, "warn", "Paused");
  else if (signIn > 0) {
    setLamp(
      els.lampWatchText,
      "error",
      `${String(signIn)} ${signIn === 1 ? "needs" : "need"} sign-in`,
    );
  } else if (halted > 0) setLamp(els.lampWatchText, "error", `${String(halted)} stopped`);
  else if (running < total) {
    setLamp(els.lampWatchText, "warn", `${String(running)} of ${String(total)} watching`);
  } else
    setLamp(els.lampWatchText, "ok", total === 1 ? "Watching" : `All ${String(total)} watching`);
  // `behind` names what a sync failed on. Empty is not proof that every server holds every block (a first sync may still
  // run), so the quiet word claims only that; and it is a list of lanes, not of mailboxes, so it is not counted.
  if (total === 0) setLamp(els.lampSyncText, "working", "No mailbox yet");
  else if (watch.behind.length === 0) setLamp(els.lampSyncText, "ok", "No failed sync");
  else setLamp(els.lampSyncText, "warn", "Blocks may be missing");
}

function boxRow(account) {
  const li = document.createElement("li");
  const what = document.createElement("div");
  what.className = "what";
  // Under the address, as on a block's row: the watcher word, then the provider word.
  const line = document.createElement("div");
  line.className = "meta line";
  line.append(stateBadge(account.accountId));
  if (typeof account.label === "string") {
    const tag = BOX_TAG.exec(account.label);
    const name = senderValue(tag === null ? account.label : account.label.slice(0, tag.index));
    name.title = account.label;
    what.append(name);
    if (tag !== null) line.append(` · ${tag[1]}`);
  } else {
    // Main has no name for it: added and waiting for the restart that starts its watcher, or a watcher that never started.
    const name = document.createElement("div");
    name.textContent = watch?.restartPending === true ? "New mailbox" : "Mailbox";
    what.append(name);
  }
  what.append(line);
  li.append(what);
  return li;
}

/** The mailboxes and their watcher words. Rows are rebuilt only when the set changes; the words follow by themselves (`drawStates`). */
function drawBoxes() {
  if (watch === null) return;
  const accounts = watch.accounts;
  const key = accounts.map((a) => `${a.accountId}\n${a.label ?? ""}`).join("\n\n");
  if (els.homeBoxes.dataset.key !== key || els.homeBoxes.childElementCount === 0) {
    els.homeBoxes.dataset.key = key;
    els.homeBoxes.replaceChildren(...accounts.slice(0, HOME_BOXES).map(boxRow));
  }
  const more = accounts.length - HOME_BOXES;
  els.homeBoxesMore.hidden = more <= 0;
  if (more > 0) els.homeBoxesMore.textContent = `And ${String(more)} more in Accounts.`;
  els.homeBoxesEmpty.hidden = accounts.length > 0;
}

/** The part of Home that follows the block list: the count, its trace, where the mail goes, the newest blocks. */
function drawHome() {
  // Only while Home shows: `render` also runs on every keystroke in a list's filter.
  if (view !== "home") return;
  els.homeRecentEmpty.hidden = true;
  homeLook = entriesLoaded ? tabCount("not") : null;
  drawLamps();
  drawBoxes();
  if (!entriesLoaded) {
    // Not "0": that would be a claim about a list that was not read.
    els.homeBlockedNum.textContent = "–";
    els.homeWeek.textContent = "";
    els.homeTrace.hidden = true;
    els.homeSplit.hidden = true;
    els.homeAll.hidden = true;
    return;
  }
  const now = Date.now();
  const counts = weekCounts(now);
  const total = entries.length;
  const week = counts[HOME_WEEKS - 1];
  const traced = counts.some((count) => count > 0);
  els.homeBlockedLabel.textContent = total === 1 ? "Sender blocked" : "Senders blocked";
  els.homeBlockedNum.textContent = String(total);
  els.homeWeek.textContent =
    total === 0
      ? "Block a sender from the notification that appears with a new mail."
      : week > 0
        ? `${String(week)} in the last 7 days`
        : traced
          ? "None in the last 7 days"
          : `None in the last ${String(HOME_WEEKS)} weeks`;
  els.homeTrace.hidden = !traced;
  if (traced) drawChart(counts, now);
  drawSplit();
  const recent = entries.slice(-HOME_RECENT).reverse();
  // Without the mailbox it came from: the list has it, and here the line stays whole in a narrow column.
  els.homeRecent.replaceChildren(
    ...recent.map((e) => row(e, { unblockButton: false, source: false })),
  );
  els.homeRecentEmpty.hidden = recent.length > 0;
  els.homeAll.hidden = total === 0;
  if (view === "home") {
    // The store keeps the list oldest first: the last entry is the newest block.
    els.count.textContent =
      total === 0 ? "" : `Last block ${LAST_BLOCK.format(new Date(entries[total - 1].createdAt))}`;
  }
}

/** The part of Home that follows the status: the lamps and the mailboxes. Runs on every status signal, so it reads no list. */
function drawHomeWatch() {
  if (view !== "home") return;
  drawLamps();
  drawBoxes();
}

/**
 * Switches the view. The notice stays when a step moved here to report (`keepNotice`) and while a step still runs, whose only
 * sign of life it is. `focusTitle`: the control that was clicked is about to hide, so keyboard focus needs a new place.
 */
function showView(name, { keepNotice = false, focusTitle = false } = {}) {
  view = name;
  for (const id of Object.keys(VIEW_TITLE)) $(`view-${id}`).hidden = id !== name;
  els.title.textContent = VIEW_TITLE[name];
  els.goAdd.hidden = name !== "accounts";
  els.navHome.toggleAttribute("aria-current", false);
  els.navBlocked.toggleAttribute("aria-current", false);
  els.navAccounts.toggleAttribute("aria-current", false);
  els.navQuiet.toggleAttribute("aria-current", false);
  els.navSettings.toggleAttribute("aria-current", false);
  els.navHelp.toggleAttribute("aria-current", false);
  const current =
    {
      home: els.navHome,
      blocked: els.navBlocked,
      quiet: els.navQuiet,
      settings: els.navSettings,
      help: els.navHelp,
    }[name] ?? els.navAccounts;
  current.setAttribute("aria-current", "page");
  if (!keepNotice && els.notice.dataset.tone !== "working") setNotice("", "");
  els.count.textContent = "";
  if (name === "blocked" || name === "home") render();
  if (focusTitle) els.title.focus();
  document.dispatchEvent(new window.CustomEvent("senderban-view", { detail: name }));
}

/** A step that finished in the add view moves to the list it changed; a person who already left stays where they are. */
function leaveAddView() {
  if (view === "add") showView("accounts", { keepNotice: true, focusTitle: true });
}

/** Screen readers announce a status line on every write: write it only when it changed. */
function setHealth(tone, text) {
  els.health.dataset.tone = tone;
  if (els.healthText.textContent !== text) els.healthText.textContent = text;
}

function drawWatch() {
  const accounts = watch.accounts;
  const running = accounts.filter((a) => a.state === "watching").length;
  els.navAccountsCount.textContent = String(accounts.length);
  els.version.textContent = `v${watch.version}`;
  els.accountsEmpty.hidden = accounts.length > 0;
  let tone = "ok";
  let text = `Watching ${String(accounts.length)} ${accounts.length === 1 ? "mailbox" : "mailboxes"}`;
  if (accounts.length === 0) {
    tone = "working";
    text = "No mailbox yet";
  } else if (watch.paused) {
    tone = "warn";
    text = "Paused";
  } else if (running < accounts.length) {
    tone = "warn";
    text = `Watching ${String(running)} of ${String(accounts.length)}`;
  }
  setHealth(tone, text);
  els.pause.hidden = accounts.length === 0;
  els.pause.textContent = watch.paused ? "Resume" : "Pause";
  els.restartBar.hidden = watch.restartPending !== true;
  els.restartText.textContent = "Restart Senderban to apply your changes.";
  els.behind.hidden = watch.behind.length === 0;
  const behind = `Blocks may be missing from ${watch.behind.join(", ")}. See Accounts.`;
  // A live region: written only when the text changes, so a reconnect elsewhere does not read it out again.
  if (els.behind.textContent !== behind) els.behind.textContent = behind;
  // A newer release from the daily check: a word on Help, and the Help page says which (help.js). Text only, never a link.
  els.navHelpCount.textContent = watch.update ? "New" : "";
  els.updatesCard.hidden = watch.storeManaged === true;
  // A link to a payment page is left out of the Store build until the Store's rules on it are read.
  els.navSponsor.hidden = watch.storeManaged === true;
  drawStates();
  drawHomeWatch();
  // A mailbox that came or went changes what the list's account choice offers. The list is drawn again then, so that the
  // choice and the rows agree, and only then: this runs on every status signal.
  const names = watchedNames().join("\n");
  if (names !== watchedKey) {
    watchedKey = names;
    if (view === "blocked") render();
  }
  // Not the whole list: this runs on every status signal, and a rebuild would take focus off the row being used.
  drawFirstRun();
}

// One status request at a time, as for the list below.
let statusing = false;
let statusAgain = false;

async function refreshStatus() {
  if (statusing) {
    statusAgain = true;
    return;
  }
  statusing = true;
  try {
    do {
      statusAgain = false;
      const result = await api.status();
      if (result === null) {
        setHealth("error", "Status unavailable. See the log.");
        return;
      }
      watch = result;
      drawWatch();
    } while (statusAgain);
  } finally {
    statusing = false;
  }
}

// One list request at a time: a burst of "changed" events (a client change signs out every Gmail
// account, one event each) costs one request in flight plus one more, not one per event.
let refreshing = false;
let refreshAgain = false;

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const init = await api.init();
      if (init === null) {
        // Not the empty text: "Nothing is blocked yet" would be a claim about a list that was not read.
        setNotice("error", "Could not read the block list. See the log.");
        return;
      }
      entries = init.entries;
      entriesLoaded = true;
      render();
      // Main says this once, on the first load after a restart asked for here (an add or the restart bar).
      if (init.restarted === true) {
        showView("accounts");
        setNotice("ok", "Senderban restarted.");
      }
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
}

async function unblock(entry) {
  if (busy) return;
  busy = true;
  render();
  setStatus("working", `Unblocking ${entry.value}…`);
  const result = await api.unblock(entry.id);
  busy = false;
  if (result !== null) entries = result.entries;
  render();
  if (result === null) setStatus("error", "Could not unblock. See the log.");
  else setStatus(result.tone, result.text);
}

els.filter.addEventListener("input", render);
els.filterAccount.addEventListener("change", render);
els.navHome.addEventListener("click", () => {
  showView("home");
});
// A lamp opens the view that holds what it reports. The control that was clicked hides with Home, so the title takes the focus.
els.lampWatch.addEventListener("click", () => {
  showView("accounts", { focusTitle: true });
});
els.lampSync.addEventListener("click", () => {
  showView("accounts", { focusTitle: true });
});
els.lampBlocks.addEventListener("click", () => {
  // The lamp counted the whole list: a filter left from an earlier visit would hide what it points at.
  els.filter.value = "";
  els.filterAccount.value = "";
  tab = homeLook !== null && homeLook > 0 ? "not" : "all";
  showView("blocked", { focusTitle: true });
});
els.homeManage.addEventListener("click", () => {
  showView("accounts", { focusTitle: true });
});
els.homeAll.addEventListener("click", () => {
  tab = "all";
  showView("blocked", { focusTitle: true });
});
// Opens the maintainer's GitHub Sponsors page; main owns the address (core HELP_LINKS), the page sends one word.
els.navSponsor.addEventListener("click", () => {
  void api.openHelp("sponsor").then(
    (reply) => {
      if (reply !== "done") setNotice("error", "Could not open the Sponsors page. See the log.");
    },
    () => {
      setNotice("error", "Could not open the Sponsors page. See the log.");
    },
  );
});
els.navBlocked.addEventListener("click", () => {
  showView("blocked");
});
els.navAccounts.addEventListener("click", () => {
  showView("accounts");
});
els.navQuiet.addEventListener("click", () => {
  showView("quiet");
});
els.navSettings.addEventListener("click", () => {
  showView("settings");
});
els.navHelp.addEventListener("click", () => {
  showView("help");
});
els.goAdd.addEventListener("click", () => {
  showView("add", { focusTitle: true });
});
els.firstAdd.addEventListener("click", () => {
  showView("add", { focusTitle: true });
});

els.pause.addEventListener("click", () => {
  // A flag, not `disabled`: a disabled button drops keyboard focus.
  if (watch === null || pausing) return;
  pausing = true;
  void api
    .pause(!watch.paused)
    .then(
      (reply) => {
        // "busy" is the step already under way: refreshStatus below shows where it ended.
        if (reply !== "done" && reply !== "busy") {
          setNotice("error", "Could not change watching. See the log.");
        }
      },
      () => {
        setNotice("error", "Could not change watching. See the log.");
      },
    )
    .then(refreshStatus)
    .finally(() => {
      pausing = false;
    });
});

els.restart.addEventListener("click", () => {
  if (restarting) return;
  restarting = true;
  void api.restart().then(
    (reply) => {
      // Main refuses while a step (an Unblock too) is still running: say so and let the person try again.
      if (reply === "restarting") return;
      setNotice(
        "warn",
        reply === "busy"
          ? "A step is still running. Wait for it to finish, then restart."
          : "Could not restart. See the log.",
      );
      restarting = false;
    },
    () => {
      setNotice("error", "Could not restart. See the log.");
      restarting = false;
    },
  );
});

// A change elsewhere in the window that waits for a restart.
document.addEventListener("senderban-restart-due", () => {
  void refreshStatus();
});

api.onChanged(() => {
  void refresh();
  void refreshStatus();
});
api.onStatus(() => {
  void refreshStatus();
});
showView("home");
void refresh();
void refreshStatus();
