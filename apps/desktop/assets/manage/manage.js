// Runs in the sandboxed manage page. Every sender value came from a mail header (untrusted), so it
// is only ever assigned through textContent.
const api = window.senderban;
const $ = (id) => document.getElementById(id);

const els = {
  count: $("count"),
  filter: $("filter"),
  list: $("list"),
  empty: $("empty"),
  status: $("status"),
  seconds: $("seconds"),
  save: $("save"),
  settingsMessage: $("settings-message"),
};

// A list can hold thousands of entries; the page draws a bounded slice and the filter narrows it.
const VISIBLE_MAX = 500;
const MATCH_LABEL = {
  exactAddress: "This address",
  exactDomain: "This domain only",
  subdomains: "Domain and its subdomains",
};
const ACTION_LABEL = { junk: "moved to Junk", trash: "moved to Trash" };

let entries = [];
let limits = { min: 3, max: 60 };
let busy = false;

function setStatus(tone, text) {
  els.status.hidden = text === "";
  els.status.dataset.tone = tone;
  els.status.textContent = text;
}

function row(entry) {
  const li = document.createElement("li");

  const what = document.createElement("div");
  what.className = "what";
  const value = document.createElement("div");
  value.className = "value";
  value.textContent = entry.value;
  value.title = entry.value;
  const meta = document.createElement("div");
  meta.className = "meta";
  const added = new Date(entry.createdAt).toLocaleDateString();
  meta.textContent = `${MATCH_LABEL[entry.match] ?? entry.match} · ${ACTION_LABEL[entry.action] ?? entry.action} · added ${added}`;
  what.append(value, meta);

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Unblock";
  button.setAttribute("aria-label", `Unblock ${entry.value}`);
  button.disabled = busy;
  button.addEventListener("click", () => void unblock(entry));

  li.append(what, button);
  return li;
}

function render() {
  const needle = els.filter.value.trim().toLowerCase();
  const matching = entries.filter((e) => needle === "" || e.value.includes(needle));
  const shown = matching.slice(0, VISIBLE_MAX);

  els.list.replaceChildren(...shown.map(row));
  els.count.textContent =
    entries.length === 0
      ? ""
      : matching.length === entries.length
        ? `${entries.length} blocked`
        : `${matching.length} of ${entries.length}`;

  els.empty.hidden = matching.length > 0;
  els.empty.textContent =
    entries.length === 0
      ? "Nothing is blocked yet. Block a sender from the popup that appears with a new mail."
      : "No blocked sender matches this filter.";
  if (matching.length > shown.length) {
    setStatus(
      "warn",
      `Showing the first ${VISIBLE_MAX} of ${matching.length}. Type to narrow the list.`,
    );
  }
}

async function refresh() {
  const init = await api.init();
  if (init === null) return;
  entries = init.entries;
  limits = init.limits;
  els.seconds.min = String(limits.min);
  els.seconds.max = String(limits.max);
  if (document.activeElement !== els.seconds) els.seconds.value = String(init.seconds);
  els.settingsMessage.textContent = `Between ${limits.min} and ${limits.max} seconds.`;
  render();
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

async function save() {
  const value = Number(els.seconds.value);
  const valid = Number.isInteger(value) && value >= limits.min && value <= limits.max;
  if (!valid) {
    els.settingsMessage.dataset.tone = "error";
    els.settingsMessage.textContent = `Enter a whole number from ${limits.min} to ${limits.max}.`;
    return;
  }
  const saved = await api.saveSeconds(value);
  els.settingsMessage.dataset.tone = saved === null ? "error" : "ok";
  els.settingsMessage.textContent = saved === null ? "Could not save the setting." : "Saved.";
}

els.filter.addEventListener("input", render);
els.save.addEventListener("click", () => void save());
els.seconds.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void save();
});
api.onChanged(() => void refresh());
void refresh();
