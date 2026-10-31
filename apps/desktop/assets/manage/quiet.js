/* global VISIBLE_MAX, els, senderValue, view */
// The Don't ask again page of the sandboxed manage page. Entries came from mail headers (untrusted): `senderValue` and `textContent` only.
// Scale: QUIET_MAX (2,000) short strings in memory, filtered per keystroke with no IPC, and at most VISIBLE_MAX rows drawn.
const qtApi = window.senderban;
const qtEls = {
  filter: document.getElementById("quiet-filter"),
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

function qtRow(value) {
  const row = document.createElement("li");
  const what = document.createElement("div");
  what.className = "what";
  what.append(senderValue(value));
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
        if (reply === "removed") qtEntries = qtEntries.filter((entry) => entry !== value);
        qtStatus(reply === "removed" ? "" : "Could not save. See the log.");
        qtDraw();
        // The row with the focus is gone.
        (qtEls.filter.hidden ? els.title : qtEls.filter).focus();
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
  const matching = qtEntries.filter((value) => needle === "" || value.includes(needle));
  const shown = matching.slice(0, VISIBLE_MAX);

  qtEls.list.replaceChildren(...shown.map(qtRow));
  els.count.textContent =
    matching.length === qtEntries.length
      ? ""
      : `${String(matching.length)} of ${String(qtEntries.length)}`;
  qtEls.filter.hidden = qtEntries.length === 0;
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
