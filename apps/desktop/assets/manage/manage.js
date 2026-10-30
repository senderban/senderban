/* exported stateBadge, leaveAddView */
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
  listSection: $("list-section"),
  filter: $("filter"),
  tabs: $("tabs"),
  behind: $("behind"),
  list: $("list"),
  empty: $("empty"),
  listCap: $("list-cap"),
  status: $("status"),
  notice: $("notice"),
  navBlocked: $("nav-blocked"),
  navAccounts: $("nav-accounts"),
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
const MATCH_LABEL = {
  exactAddress: "This address",
  exactDomain: "This domain only",
  subdomains: "Domain and subdomains",
};
const ACTION_PILL = {
  junk: ["", "Junk"],
  trash: ["", "Trash"],
  reject: ["warn", "Junk. Not refused at the server"],
};
const AT_SERVER_PILL = ["ok", "Server block, Junk backup"];
const UNCONFIRMED_PILL = ["warn", "Not confirmed"];

// What a signed-in Gmail account does with the entry (a single address becomes a Trash filter); absent: no Gmail account.
const GMAIL_PILL = { trash: ["", "Gmail: Trash"], no: ["warn", "Gmail: not applied"] };
const OWN_PILL = ["warn", "Not applied: your own mail"];

const TABS = [
  { id: "all", label: "All", holds: () => true },
  { id: "server", label: "At server", holds: (e) => e.atServer },
  {
    id: "junk",
    label: "Junk",
    holds: (e) => e.action !== "trash" && !e.atServer && e.own !== true,
  },
  { id: "trash", label: "Trash", holds: (e) => e.action === "trash" },
  { id: "not", label: "Needs a look", holds: (e) => e.applied !== "yes" || e.gmail === "no" },
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

const VIEW_TITLE = { blocked: "Blocked senders", accounts: "Accounts", add: "Add mailbox" };

let entries = [];
let busy = false;
let tab = "all";
let view = "blocked";
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

function row(entry) {
  const li = document.createElement("li");

  const what = document.createElement("div");
  what.className = "what";
  const meta = document.createElement("div");
  meta.className = "meta line";
  const added = new Date(entry.createdAt).toLocaleDateString();
  const scope = document.createElement("span");
  scope.textContent = `${MATCH_LABEL[entry.match] ?? entry.match} · added ${added}`;
  meta.append(scope);
  // An entry over the person's own mail is applied nowhere: say that instead of a per-provider label.
  if (entry.own === true) {
    meta.append(pill(...OWN_PILL));
  } else {
    const action = entry.atServer ? AT_SERVER_PILL : ACTION_PILL[entry.action];
    if (action !== undefined) meta.append(pill(...action));
    const gmail = GMAIL_PILL[entry.gmail];
    if (gmail !== undefined) meta.append(pill(...gmail));
    if (entry.applied === "unknown") meta.append(pill(...UNCONFIRMED_PILL));
  }
  what.append(senderValue(entry.value), meta);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "small";
  button.textContent = "Unblock";
  button.setAttribute("aria-label", `Unblock ${entry.value}`);
  button.disabled = busy;
  button.addEventListener("click", () => void unblock(entry));

  li.append(what, button);
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
  const found = entries.filter((e) => needle === "" || e.value.includes(needle));
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

  drawFirstRun();
  els.filter.hidden = entries.length === 0;
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
  els.listSection.hidden = firstRun;
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
  els.navBlocked.toggleAttribute("aria-current", false);
  els.navAccounts.toggleAttribute("aria-current", false);
  (name === "blocked" ? els.navBlocked : els.navAccounts).setAttribute("aria-current", "page");
  if (!keepNotice && els.notice.dataset.tone !== "working") setNotice("", "");
  els.count.textContent = "";
  if (name === "blocked") render();
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
  const behind = `Blocks may be missing from ${watch.behind.join(", ")}: the last update failed.`;
  // A live region: written only when the text changes, so a reconnect elsewhere does not read it out again.
  if (els.behind.textContent !== behind) els.behind.textContent = behind;
  drawStates();
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
      render();
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
els.navBlocked.addEventListener("click", () => {
  showView("blocked");
});
els.navAccounts.addEventListener("click", () => {
  showView("accounts");
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
showView("blocked");
void refresh();
void refreshStatus();
