/* global els, senderValue, pill, view, watch, watchedNames */
// The Recent mail page of the sandboxed manage page (017): the newest mail of each account, read by main when the page opens.
// Senders and subjects came from mail headers (untrusted): `senderValue` and `textContent` only. A row's buttons send its key
// (a UUID main gave with the rows) and one word; no address goes back to main.
// Scale: RECENT_MAX (10) rows per account, MAX_ACCOUNTS (50) accounts: 500 rows at most, drawn once per read or click.
const rcApi = window.senderban;
const rcEls = {
  list: document.getElementById("recent-list"),
  empty: document.getElementById("recent-empty"),
  problems: document.getElementById("recent-problems"),
  status: document.getElementById("recent-status"),
  refresh: document.getElementById("recent-refresh"),
};

// What the row says beside the sender; a plain row says nothing. Only "Not notified" is worth a look, so only it is a pill with a
// dot; the settled states are plain muted text (a colour or a dot would claim attention they do not need).
const RC_MARK = {
  blocked: "Blocked",
  muted: "Muted",
  missed: "Not notified",
  own: "Your own address",
  unreadable: "Sender could not be read",
};
// The toast's own words for where a block puts the mail (BUTTON_LABELS in toast.ts): one action, one name.
const RC_ACT = { junk: "Junk", trash: "Trash" };
const RC_PROBLEM = {
  offline: "not connected",
  error: "could not be read",
  limit: "Senderban's own daily limit for this page is reached",
  large:
    "a message there is too large to list; Senderban tries again after ten newer messages, or in half an hour",
  reading: "still reading",
};
const RC_TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const RC_DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

// Null until the first read worked: "No mail" would be a claim about mailboxes that were not read.
let rcView = null;
// Rows (rcId) whose click is running: their buttons stay off until the answer, also through a redraw, which gives new keys.
const rcActing = new Set();

function rcStatus(tone, text) {
  rcEls.status.hidden = text === "";
  rcEls.status.dataset.tone = tone;
  rcEls.status.textContent = text;
}

function rcWhen(ms) {
  if (ms === null) return "";
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? RC_TIME.format(date)
    : RC_DAY.format(date);
}

// A row as the page knows it across reads: the key changes with each read, the mail does not. Used to put focus back after a redraw.
function rcId(row) {
  return [row.account, row.from ?? "", String(row.receivedMs), row.subject].join("\n");
}

function rcButton(label, act, row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} ${row.from}`);
  button.dataset.row = rcId(row);
  button.dataset.act = act;
  // Not `disabled` while a click runs: a disabled button drops the keyboard focus to the page.
  if (rcActing.has(rcId(row))) button.setAttribute("aria-disabled", "true");
  button.addEventListener("click", () => {
    void rcAct(row, act);
  });
  return button;
}

function rcRow(row) {
  const li = document.createElement("li");

  const what = document.createElement("div");
  what.className = "what";
  if (row.from === null) {
    // Words of the page, not data: the UI face, not the mono of an address.
    const unknown = document.createElement("div");
    unknown.className = "muted";
    unknown.textContent = "Unknown sender";
    what.append(unknown);
  } else {
    what.append(senderValue(row.from));
  }
  const line = document.createElement("div");
  line.className = "meta line";
  const subject = document.createElement("span");
  subject.className = "source subject";
  subject.textContent = row.subject === "" ? "(no subject)" : row.subject;
  subject.title = subject.textContent;
  const account = document.createElement("span");
  account.className = "source";
  account.textContent = row.account;
  account.title = `To ${row.account}`;
  const when = document.createElement("span");
  when.className = "facts";
  when.textContent = row.receivedMs === null ? "  ·  " : `  ·  ${rcWhen(row.receivedMs)}  ·  `;
  line.append(subject, when, account);
  what.append(line);
  li.append(what);

  const word = RC_MARK[row.mark];
  if (word !== undefined) {
    const flags = document.createElement("div");
    flags.className = "flags";
    if (row.mark === "missed") {
      flags.append(pill("", word));
    } else {
      const settled = document.createElement("span");
      settled.className = "meta";
      settled.textContent = word;
      flags.append(settled);
    }
    li.append(flags);
  }
  // A sender that cannot be matched, or the person's own address, has nothing to click: the toast has no button for it either.
  // A blocked sender's mail no longer reaches the Inbox, so there is nothing left to mute.
  if (row.from !== null && !["own", "unreadable", "blocked"].includes(row.mark)) {
    const actions = document.createElement("div");
    actions.className = "row";
    if (row.mark !== "muted") actions.append(rcButton("Mute", "mute", row));
    if (row.mark !== "blocked")
      actions.append(rcButton(RC_ACT[row.blockAct] ?? "Junk", "block", row));
    if (actions.childElementCount > 0) li.append(actions);
  }
  return li;
}

// After a redraw, focus goes back where it was: the same button of the same mail, else that row's other button, else the first
// button from the same place on, else the title. A keyboard user must not Tab through every row again after each click.
function rcRefocus(was) {
  const buttons = [...rcEls.list.querySelectorAll("button")];
  const same = buttons.find((b) => b.dataset.row === was.row && b.dataset.act === was.act);
  const sameRow = buttons.find((b) => b.dataset.row === was.row);
  const later = [...rcEls.list.children]
    .slice(Math.max(0, was.index))
    .map((li) => li.querySelector("button"))
    .find((b) => b !== null);
  (same ?? sameRow ?? later ?? els.title).focus();
}

function rcDraw() {
  if (rcView === null || view !== "recent") return;
  const focused = rcEls.list.contains(document.activeElement) ? document.activeElement : null;
  const was =
    focused === null
      ? null
      : {
          row: focused.dataset.row,
          act: focused.dataset.act,
          index: [...rcEls.list.children].indexOf(focused.closest("li")),
        };
  rcEls.list.replaceChildren(...rcView.rows.map(rcRow));
  if (was !== null) rcRefocus(was);
  els.count.textContent =
    rcView.rows.length === 0 ? "" : `${String(rcView.rows.length)} mails, newest first`;
  rcEls.empty.hidden = rcView.rows.length > 0;
  // Main tells the page when start ends (onChanged), and the page reads again then. Which mailboxes exist comes from the status;
  // before it came, the page does not know, and says both.
  const mailboxes = watch === null ? null : watchedNames().length;
  rcEls.empty.textContent = rcView.starting
    ? "Senderban is still starting. The list fills in when it is ready."
    : rcView.problems.length > 0
      ? "No mail could be read right now."
      : mailboxes === 0
        ? "No mailbox yet. Add one in Accounts."
        : mailboxes === null
          ? "No mail in the Inbox, or no mailbox added yet."
          : "No mail in the Inbox.";
  rcEls.problems.hidden = rcView.problems.length === 0;
  rcEls.problems.textContent = rcView.problems
    .map((p) => `${p.account}: ${RC_PROBLEM[p.status] ?? "could not be read"}.`)
    .join(" ");
}

// One read at a time: a second open while one reads waits for it (main answers both with the same look). A call made meanwhile gets
// the running read, which asks once more before it ends: when it resolves, rcView holds keys from a look after the call. A row click
// waits for that, since main announces a change during each click and the next click needs the keys of the look after it.
let rcLoading = false;
let rcLoadAgain = false;
let rcRun = Promise.resolve();
// An account still reading when main answered: ask again every RC_AGAIN_MS while one is (main waits up to 5 s for it each time and
// ends a read at 15 s, so this stops by itself).
const RC_AGAIN_MS = 2_000;
let rcAgainTimer = null;

function rcAskAgainIfReading() {
  if (rcAgainTimer !== null || !rcView.problems.some((p) => p.status === "reading")) return;
  rcAgainTimer = window.setTimeout(() => {
    rcAgainTimer = null;
    if (view === "recent") void rcLoad(false);
  }, RC_AGAIN_MS);
}

function rcLoad(refresh) {
  if (rcLoading) {
    rcLoadAgain = true;
    return rcRun;
  }
  rcLoading = true;
  rcRun = rcRead(refresh);
  return rcRun;
}

async function rcRead(refresh) {
  // Not `disabled`: that would drop the keyboard focus of the person who just pressed it.
  rcEls.refresh.setAttribute("aria-disabled", "true");
  if (rcView === null) rcStatus("working", "Reading recent mail…");
  try {
    let again = refresh;
    do {
      rcLoadAgain = false;
      const next = await rcApi.recent(again).catch(() => null);
      again = false;
      if (next === null) {
        rcStatus("error", "Could not read recent mail. See the log.");
        return;
      }
      rcView = next;
      if (rcEls.status.dataset.tone === "working") rcStatus("", "");
      rcDraw();
      rcAskAgainIfReading();
    } while (rcLoadAgain);
  } finally {
    rcLoading = false;
    rcEls.refresh.removeAttribute("aria-disabled");
  }
}

// Main takes one row click at a time and refuses one sent meanwhile: a click on another row waits here for its turn.
let rcActTurn = Promise.resolve();

async function rcAct(row, act) {
  const id = rcId(row);
  if (rcActing.has(id)) return;
  rcActing.add(id);
  // Marked in place, not redrawn: the focused button stays where it is.
  for (const button of rcEls.list.querySelectorAll("button")) {
    if (button.dataset.row === id) button.setAttribute("aria-disabled", "true");
  }
  const turn = rcActTurn.then(() => rcActNow(id, act));
  rcActTurn = turn.catch(() => undefined);
  await turn;
}

async function rcActNow(id, act) {
  // The click before redrew the list, which gave every row a new key: the row is looked up again in the newest look.
  const row = rcView?.rows.find((r) => rcId(r) === id) ?? null;
  if (row === null) {
    rcActing.delete(id);
    rcStatus("warn", "That mail is no longer in the list.");
    rcDraw();
    return;
  }
  rcStatus("working", act === "block" ? `Blocking ${row.from}…` : `Muting ${row.from}…`);
  const reply = await rcApi.recentAct(row.key, act).catch(() => null);
  rcActing.delete(id);
  if (reply === null) rcStatus("error", "Something went wrong. See the log.");
  else rcStatus(reply.tone, reply.text);
  // The marks come from the lists main holds: asking again reads no mailbox inside the page's few minutes. The redraw puts the
  // focus back on the row (rcRefocus).
  await rcLoad(false);
}

rcEls.refresh.addEventListener("click", () => {
  if (rcLoading) return;
  rcStatus("", "");
  void rcLoad(true);
});
// A block or a mute from a notification changes the marks.
rcApi.onChanged(() => {
  if (view === "recent") void rcLoad(false);
});
document.addEventListener("senderban-view", (event) => {
  if (event.detail !== "recent") return;
  rcDraw();
  void rcLoad(false);
});
// The window may have switched here before this script ran (a notification click answered by a fast `init`).
if (view === "recent") void rcLoad(false);
