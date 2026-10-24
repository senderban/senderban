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
};

let isMail = false;

function render(view) {
  const idle = view.phase === "idle";
  els.actions.hidden = !idle || !isMail;
  els.status.hidden = idle;
  if (idle) return;
  els.status.textContent = view.text;
  els.status.dataset.tone = view.phase === "working" ? "working" : view.tone;
}

async function start() {
  const init = await api.init();
  if (init === null) return;
  const { model, view } = init;
  isMail = model.id !== null;

  els.title.textContent = model.title;
  els.body.textContent = model.body;
  els.body.hidden = model.body === "";
  els.account.textContent = model.account === null ? "" : `to ${model.account}`;
  els.account.hidden = model.account === null;

  // A notice has no buttons and no gear; the gear is on mail popups only.
  els.gear.hidden = !isMail;
  els.blockAddress.hidden = !isMail;
  els.blockDomain.hidden = model.domain === null;
  if (model.domain !== null) {
    els.blockDomain.textContent = `Block ${model.domain}`;
    els.blockDomain.title = `Block ${model.domain} and its subdomains`;
  }

  els.blockAddress.addEventListener("click", () => void api.choose("address"));
  els.blockDomain.addEventListener("click", () => void api.choose("domain"));
  els.gear.addEventListener("click", () => {
    api.openSettings();
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
