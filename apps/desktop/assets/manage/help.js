// The Help page of the sandboxed manage page. A button names a fixed target (core HELP_TARGETS); main owns the
// addresses and opens them, so the page never hands a URL to the browser.
const hpApi = window.senderban;
const hpEls = {
  view: document.getElementById("view-help"),
  version: document.getElementById("help-version"),
  sideVersion: document.getElementById("version"),
  status: document.getElementById("help-status"),
};

function hpStatus(text) {
  hpEls.status.hidden = text === "";
  hpEls.status.dataset.tone = "error";
  hpEls.status.textContent = text;
}

hpEls.view.addEventListener("click", (event) => {
  const button = event.target.closest?.("button[data-help]");
  if (!button) return;
  hpStatus("");
  void hpApi.openHelp(button.dataset.help).then(
    (reply) => {
      if (reply !== "done") hpStatus("Could not open it. See the log.");
    },
    () => {
      hpStatus("Could not open it. See the log.");
    },
  );
});

document.addEventListener("senderban-view", (event) => {
  if (event.detail !== "help") return;
  hpStatus("");
  // The side bar already shows the running version (from the status call): no second request for it.
  hpEls.version.textContent = hpEls.sideVersion.textContent;
});
