// The Settings page of the sandboxed manage page. Every value is a closed list or a switch, and main checks the whole object against
// the core schema again. A choice shows as made only once it is on disk: a failed save puts the page back.
const stApi = window.senderban;
const stEls = {
  action: document.getElementById("setting-action"),
  duration: document.getElementById("setting-duration"),
  server: document.getElementById("setting-server"),
  serverText: document.getElementById("setting-server-text"),
  confirm: document.getElementById("setting-confirm"),
  confirmText: document.getElementById("setting-confirm-text"),
  status: document.getElementById("settings-status"),
  quietList: document.getElementById("quiet-list"),
  quietEmpty: document.getElementById("quiet-empty"),
};

// What the page shows, and what main last confirmed.
let stWanted = null;
let stSaved = null;
let stSaving = false;

function stStatus(text) {
  stEls.status.hidden = text === "";
  stEls.status.dataset.tone = "error";
  stEls.status.textContent = text;
}

function stDrawChoices(group, value) {
  for (const button of group.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

function stDraw() {
  stDrawChoices(stEls.action, stWanted.defaultAction);
  stDrawChoices(stEls.duration, stWanted.toastDuration);
  stEls.server.checked = stWanted.preferServerBlock;
  stEls.serverText.textContent = stWanted.preferServerBlock ? "On" : "Off";
  stEls.confirm.checked = stWanted.confirmBlocks;
  stEls.confirmText.textContent = stWanted.confirmBlocks ? "On" : "Off";
}

// One save at a time: quick clicks cost one write in flight plus one with the last choice, not one write per click.
async function stSave() {
  if (stSaving) return;
  stSaving = true;
  try {
    while (stWanted !== stSaved) {
      const sending = stWanted;
      const reply = await stApi.saveSettings(sending).catch(() => "failed");
      if (reply !== "saved") {
        stWanted = stSaved;
        stDraw();
        stStatus("Could not save. See the log.");
        return;
      }
      stSaved = sending;
      stStatus("");
    }
  } finally {
    stSaving = false;
  }
}

function stChange(change) {
  if (stWanted === null) return;
  stWanted = { ...stWanted, ...change };
  stDraw();
  void stSave();
}

function stChoices(group, key) {
  group.addEventListener("click", (event) => {
    const value = event.target.dataset?.value;
    if (value !== undefined && value !== stWanted?.[key]) stChange({ [key]: value });
  });
}

stChoices(stEls.action, "defaultAction");
stChoices(stEls.duration, "toastDuration");
stEls.server.addEventListener("change", () => {
  stChange({ preferServerBlock: stEls.server.checked });
});
stEls.confirm.addEventListener("change", () => {
  stChange({ confirmBlocks: stEls.confirm.checked });
});

// Entries are sender text: `textContent` only.
function stQuietRow(value) {
  const row = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = value;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${value}`);
  remove.addEventListener("click", () => {
    remove.disabled = true;
    void stApi
      .quietRemove(value)
      .catch(() => "failed")
      .then((reply) => {
        if (reply !== "removed") stStatus("Could not save. See the log.");
        void stQuietLoad();
      });
  });
  row.append(name, remove);
  return row;
}

async function stQuietLoad() {
  const entries = await stApi.quiet().catch(() => null);
  if (entries === null) {
    stStatus("Could not read the settings. See the log.");
    return;
  }
  stEls.quietList.replaceChildren(...entries.map(stQuietRow));
  stEls.quietEmpty.hidden = entries.length > 0;
}

stApi.onChanged(() => {
  void stQuietLoad();
});

document.addEventListener("senderban-view", (event) => {
  if (event.detail !== "settings") return;
  void stQuietLoad();
  if (stSaving) return;
  void stApi.settings().then(
    (settings) => {
      if (settings === null) {
        stStatus("Could not read the settings. See the log.");
        return;
      }
      stStatus("");
      stWanted = settings;
      stSaved = settings;
      stDraw();
    },
    () => {
      stStatus("Could not read the settings. See the log.");
    },
  );
});
