// Runs in the sandboxed popup page. Everything shown here came from the mailbox (untrusted), so it
// is only ever assigned through textContent.
const api = window.senderban;
const $ = (id) => document.getElementById(id);

const els = {
  gear: $("gear"),
  close: $("close"),
  mail: $("mail"),
  title: $("title"),
  body: $("body"),
  account: $("account"),
  actions: $("actions"),
  blockAddress: $("block-address"),
  blockDomain: $("block-domain"),
  status: $("status"),
  settings: $("settings"),
  seconds: $("seconds"),
  settingsMessage: $("settings-message"),
  save: $("save"),
  back: $("back"),
};

let limits = { min: 3, max: 60 };
let isMail = false;

function render(view) {
  const idle = view.phase === "idle";
  els.actions.hidden = !idle || !isMail;
  els.status.hidden = idle;
  if (idle) return;
  els.status.textContent = view.text;
  els.status.dataset.tone = view.phase === "working" ? "working" : view.tone;
}

function showMessage(tone, text) {
  els.settingsMessage.dataset.tone = tone;
  els.settingsMessage.textContent = text;
}

function showSettings(open) {
  els.settings.hidden = !open;
  els.mail.hidden = open;
  els.gear.hidden = open || !isMail;
  showMessage("muted", `Between ${limits.min} and ${limits.max} seconds.`);
  api.settingsOpen(open);
  if (open) els.seconds.focus();
}

async function save() {
  const value = Number(els.seconds.value);
  const valid = Number.isInteger(value) && value >= limits.min && value <= limits.max;
  if (!valid) {
    showMessage("error", `Enter a whole number from ${limits.min} to ${limits.max}.`);
    return;
  }
  const saved = await api.saveSeconds(value);
  if (saved === null) showMessage("error", "Could not save the setting.");
  else showMessage("ok", "Saved.");
}

async function start() {
  const init = await api.init();
  if (init === null) return;
  const { model, view, seconds } = init;
  limits = init.limits;
  isMail = model.id !== null;

  els.title.textContent = model.title;
  els.body.textContent = model.body;
  els.body.hidden = model.body === "";
  els.account.textContent = model.account === null ? "" : `to ${model.account}`;
  els.account.hidden = model.account === null;

  // A notice window is too short to hold the settings panel; settings live on the mail popups.
  els.gear.hidden = !isMail;
  els.blockAddress.hidden = !isMail;
  els.blockDomain.hidden = model.domain === null;
  if (model.domain !== null) {
    els.blockDomain.textContent = `Block ${model.domain}`;
    els.blockDomain.title = `Block ${model.domain} and its subdomains`;
  }

  els.seconds.min = String(limits.min);
  els.seconds.max = String(limits.max);
  els.seconds.value = String(seconds);

  els.blockAddress.addEventListener("click", () => void api.choose("address"));
  els.blockDomain.addEventListener("click", () => void api.choose("domain"));
  els.gear.addEventListener("click", () => {
    showSettings(true);
  });
  els.back.addEventListener("click", () => {
    showSettings(false);
  });
  els.save.addEventListener("click", () => void save());
  els.seconds.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void save();
  });
  els.close.addEventListener("click", () => {
    api.close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") api.close();
  });
  document.addEventListener("mouseenter", () => {
    api.hover(true);
  });
  document.addEventListener("mouseleave", () => {
    api.hover(false);
  });

  api.onView(render);
  render(view);
}

void start();
