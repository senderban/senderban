// The Settings page of the sandboxed manage page. Every value is a closed list or a switch, and main checks the whole object against
// the core schema again. A choice shows as made only once it is on disk: a failed save puts the page back.
const stApi = window.senderban;
const stEls = {
  action: document.getElementById("setting-action"),
  actionRow: document.getElementById("setting-action-row"),
  duration: document.getElementById("setting-duration"),
  server: document.getElementById("setting-server"),
  serverText: document.getElementById("setting-server-text"),
  confirm: document.getElementById("setting-confirm"),
  updates: document.getElementById("setting-updates"),
  updatesText: document.getElementById("setting-updates-text"),
  confirmText: document.getElementById("setting-confirm-text"),
  status: document.getElementById("settings-status"),
  startupCard: document.getElementById("settings-startup-card"),
  login: document.getElementById("setting-login"),
  loginText: document.getElementById("setting-login-text"),
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
  // The domain fallback only matters while Block is offered (toast.ts missingNote / parseActivation).
  stEls.actionRow.hidden = !stWanted.preferServerBlock;
  stEls.confirm.checked = stWanted.confirmBlocks;
  stEls.confirmText.textContent = stWanted.confirmBlocks ? "On" : "Off";
  stEls.updates.checked = stWanted.checkUpdates;
  stEls.updatesText.textContent = stWanted.checkUpdates ? "On" : "Off";
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
stEls.updates.addEventListener("change", () => {
  stChange({ checkUpdates: stEls.updates.checked });
});

// Start at sign-in lives in Windows, not in the settings file: read it each time the page opens, write it on its own channel.
let stLoginSaving = false;

function stDrawLogin(on) {
  stEls.login.checked = on;
  stEls.loginText.textContent = on ? "On" : "Off";
}

stEls.login.addEventListener("change", () => {
  // A flag, not `disabled`: a disabled switch drops keyboard focus. A click while a write runs is put back.
  if (stLoginSaving) {
    stDrawLogin(!stEls.login.checked);
    return;
  }
  const on = stEls.login.checked;
  stDrawLogin(on);
  stLoginSaving = true;
  void stApi
    .saveLoginItem(on)
    .catch(() => "failed")
    .then((reply) => {
      if (reply === "saved") {
        stStatus("");
        return;
      }
      stDrawLogin(!on);
      stStatus("Could not change start at sign-in. See the log.");
    })
    .finally(() => {
      stLoginSaving = false;
    });
});

document.addEventListener("senderban-view", (event) => {
  if (event.detail !== "settings") return;
  if (!stLoginSaving) {
    // null: not offered here (a Store install), or the answer did not come: the card stays hidden.
    void stApi.loginItem().then(
      (on) => {
        stEls.startupCard.hidden = typeof on !== "boolean";
        if (typeof on === "boolean") stDrawLogin(on);
      },
      () => {
        stEls.startupCard.hidden = true;
      },
    );
  }
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
