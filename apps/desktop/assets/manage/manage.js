/* exported stateBadge, leaveAddView, senderValue, accountChoices, accountHolds */
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
  homeAccounts: $("home-accounts"),
  homeAccountsNum: $("home-accounts-num"),
  homeAccountsText: $("home-accounts-text"),
  homeBlocked: $("home-blocked"),
  homeBlockedNum: $("home-blocked-num"),
  homeBlockedText: $("home-blocked-text"),
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
const HOME_RECENT = 5;

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

/** Offers the mailboxes the rows came from. Rebuilt only when that set changes, so a choice survives a refresh; a choice that is gone falls back to all. */
function accountChoices(select, rows) {
  const names = [...new Set(rows.map((r) => r.source).filter((s) => s !== undefined))].sort();
  const values = ["", ...names];
  if (names.length > 0 && rows.some((r) => r.source === undefined)) values.push(NOT_RECORDED);
  const key = values.join("\n");
  if (select.dataset.key === key) return;
  const wanted = select.value;
  select.replaceChildren(
    ...values.map((v) =>
      option(v, v === "" ? "All accounts" : v === NOT_RECORDED ? "Not recorded (before 0.3)" : v),
    ),
  );
  select.dataset.key = key;
  select.value = values.includes(wanted) ? wanted : "";
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
function rowLine(entry) {
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
  if (entry.source !== undefined) {
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

function row(entry, { unblockButton = true } = {}) {
  const li = document.createElement("li");

  const what = document.createElement("div");
  what.className = "what";
  what.append(senderValue(entry.value), rowLine(entry));
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
      : "No blocked sender matches this filter.";
  els.listCap.hidden = matching.length <= shown.length;
  els.listCap.textContent = `Showing the first ${String(VISIBLE_MAX)} of ${String(matching.length)}. Type to narrow the list.`;
}

function drawFirstRun() {
  const firstRun = entries.length === 0 && watch !== null && watch.accounts.length === 0;
  els.firstRun.hidden = !firstRun;
  els.homeBody.hidden = firstRun;
}

/** The Home view: two counts that open their views, and the newest blocks. Drawn from the list and status already held. */
function drawHome() {
  els.homeRecentEmpty.hidden = true;
  if (!entriesLoaded) {
    els.homeBlockedNum.textContent = "–";
    els.homeBlockedText.textContent = "senders blocked";
    els.homeAll.hidden = true;
    drawHomeAccounts();
    return;
  }
  const recent = entries.slice(-HOME_RECENT).reverse();
  els.homeRecent.replaceChildren(...recent.map((e) => row(e, { unblockButton: false })));
  els.homeRecentEmpty.hidden = recent.length > 0;
  els.homeAll.hidden = entries.length === 0;
  els.homeBlockedNum.textContent = String(entries.length);
  els.homeBlockedText.textContent = entries.length === 1 ? "sender blocked" : "senders blocked";
  drawHomeAccounts();
}

function drawHomeAccounts() {
  if (watch === null) {
    // Status not read (yet): the tile still has a name.
    els.homeAccountsNum.textContent = "–";
    els.homeAccountsText.textContent = "mailboxes";
    return;
  }
  const total = watch.accounts.length;
  const running = watch.accounts.filter((a) => a.state === "watching").length;
  // The same words as the side bar ("Watching 2 of 3").
  els.homeAccountsNum.textContent =
    running === total ? String(total) : `${String(running)} of ${String(total)}`;
  els.homeAccountsText.textContent = watch.paused
    ? "mailboxes, paused"
    : `${total === 1 ? "mailbox" : "mailboxes"} watched`;
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
  drawHome();
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
els.homeAccounts.addEventListener("click", () => {
  showView("accounts");
});
els.homeBlocked.addEventListener("click", () => {
  showView("blocked");
});
els.homeAll.addEventListener("click", () => {
  showView("blocked");
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
