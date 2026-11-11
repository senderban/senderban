/* global VISIBLE_MAX, els, senderValue, view, accountChoices, accountHolds */
// The Don't ask again page of the sandboxed manage page. Entries came from mail headers (untrusted): `senderValue` and `textContent` only.
// Each row is { value, source? }: source is the mailbox it was chosen in, absent before 0.3.
// Scale: QUIET_MAX (2,000) short rows in memory, filtered per keystroke with no IPC, and at most VISIBLE_MAX rows drawn.
const qtApi = window.senderban;
const qtEls = {
  filter: document.getElementById("quiet-filter"),
  filterRow: document.getElementById("quiet-filter-row"),
  account: document.getElementById("quiet-account"),
  list: document.getElementById("quiet-list"),
  empty: document.getElementById("quiet-empty"),
  cap: document.getElementById("quiet-cap"),
  status: document.getElementById("quiet-status"),
  navCount: document.getElementById("nav-quiet-count"),
};

// Null until the first read worked: "nothing here" would be a claim about a list that was not read.
let qtEntries = null;

function qtStatus(text) {
  qtEls.status.hidden = text === "";
  qtEls.status.dataset.tone = "error";
  qtEls.status.textContent = text;
}

function qtRow({ value, source }) {
  const row = document.createElement("li");
  const what = document.createElement("div");
  what.className = "what";
  what.append(senderValue(value));
  if (source !== undefined) {
    const line = document.createElement("div");
    line.className = "meta line";
    const text = document.createElement("span");
    text.className = "source";
    text.textContent = `from ${source}`;
    line.append(text);
    what.append(line);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${value}`);
  remove.addEventListener("click", () => {
    remove.disabled = true;
    void qtApi
      .quietRemove(value)
      .catch(() => "failed")
      .then((reply) => {
        if (reply === "removed") qtEntries = qtEntries.filter((entry) => entry.value !== value);
        qtStatus(reply === "removed" ? "" : "Could not save. See the log.");
        qtDraw();
        // The row with the focus is gone.
        (qtEls.filterRow.hidden ? els.title : qtEls.filter).focus();
        void qtLoad();
      });
  });
  row.append(what, remove);
  return row;
}

function qtDraw() {
  if (qtEntries === null) return;
  qtEls.navCount.textContent = String(qtEntries.length);
  // Hidden, only the count shows: a burst of "changed" events does not rebuild rows nobody sees.
  if (view !== "quiet") return;
  const needle = qtEls.filter.value.trim().toLowerCase();
  accountChoices(qtEls.account, qtEntries);
  // Newest first, as on the block list: the file keeps them in the order they were added.
  const matching = qtEntries
    .filter((e) => (needle === "" || e.value.includes(needle)) && accountHolds(qtEls.account, e))
    .reverse();
  const shown = matching.slice(0, VISIBLE_MAX);

  qtEls.list.replaceChildren(...shown.map(qtRow));
  els.count.textContent =
    matching.length === qtEntries.length
      ? ""
      : `${String(matching.length)} of ${String(qtEntries.length)}`;
  qtEls.filterRow.hidden = qtEntries.length === 0;
  qtEls.empty.hidden = matching.length > 0;
  qtEls.empty.textContent =
    qtEntries.length === 0
      ? "Choose Don't ask again on a notification to add a sender."
      : "No sender matches this filter.";
  qtEls.cap.hidden = matching.length <= shown.length;
  qtEls.cap.textContent = `Showing the first ${String(VISIBLE_MAX)} of ${String(matching.length)}. Type to narrow the list.`;
}

// One read at a time, as for the block list: a burst of "changed" events costs one read in flight plus one more.
let qtLoading = false;
let qtLoadAgain = false;

async function qtLoad() {
  if (qtLoading) {
    qtLoadAgain = true;
    return;
  }
  qtLoading = true;
  try {
    do {
      qtLoadAgain = false;
      const entries = await qtApi.quiet().catch(() => null);
      if (entries === null) {
        qtStatus("Could not read the list. See the log.");
        return;
      }
      qtEntries = entries;
      qtDraw();
    } while (qtLoadAgain);
  } finally {
    qtLoading = false;
  }
}

qtEls.filter.addEventListener("input", qtDraw);
qtEls.account.addEventListener("change", qtDraw);
qtApi.onChanged(() => {
  void qtLoad();
});
document.addEventListener("senderban-view", (event) => {
  if (event.detail !== "quiet") return;
  qtStatus("");
  qtDraw();
  void qtLoad();
});
void qtLoad();
