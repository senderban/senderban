// MXroute accounts section of the sandboxed manage page. The password is typed here, sent once to the main process and then
// forgotten: nothing here ever receives it back, and every value shown came from main as plain text (textContent only).
const acApi = window.senderban;
const acEls = {
  details: document.getElementById("accounts"),
  list: document.getElementById("account-list"),
  form: document.getElementById("account-form"),
  address: document.getElementById("account-address"),
  password: document.getElementById("account-password"),
  host: document.getElementById("account-host"),
  save: document.getElementById("account-save"),
  restart: document.getElementById("account-restart"),
  message: document.getElementById("account-message"),
};

// Replies of the main process, as sentences. The input is never echoed.
const AC_REPLY = {
  saved: ["ok", "Added. Restart Senderban to start blocking on this account."],
  "saved-own-entries": [
    "warn",
    "Added. Blocks on your list for this mail domain no longer apply, because it now counts as your own. Restart Senderban to start blocking on this account.",
  ],
  exists: ["error", "This mailbox is already set up."],
  limit: ["error", "Senderban cannot hold more accounts."],
  "login-refused": ["error", "The server refused this address or password."],
  "sieve-missing": [
    "error",
    "The login worked, but Senderban could not reach ManageSieve on port 4190, which it needs to write rules. Nothing was saved.",
  ],
  unreachable: ["error", "Could not reach this server. Check its name and try again."],
  "tls-refused": [
    "error",
    "This server's certificate could not be verified, so Senderban stopped. Check its name. Nothing was saved.",
  ],
  cancelled: ["warn", "Cancelled. Nothing was saved."],
  busy: ["warn", "A check is still running."],
  invalid: [
    "error",
    "Check the address, the password and the server, which must be a public host name.",
  ],
  denied: ["error", "Could not add the account. See the log."],
  failed: ["error", "Could not add the account. See the log."],
};

// Replies to a removal, as sentences.
const AC_REMOVE_REPLY = {
  removed: ["ok", "Removed. Restart Senderban to finish."],
  "removed-blacklist-remains": [
    "warn",
    "Removed. Senders it put on the MXroute blacklist stay there: delete them in your MXroute panel. Your API key stays under Advanced. Restart Senderban to finish.",
  ],
  "removed-rules-remain": [
    "warn",
    "Removed, but its rules are still on the mail server and go on moving mail from blocked senders. Delete them at your provider. Restart Senderban to finish.",
  ],
  "restart-first": [
    "warn",
    "Restart Senderban first, so it can delete this account's rules, then remove it. Nothing was changed.",
  ],
  "rules-left": [
    "error",
    "Senderban could not delete this account's rules, so the account was kept. Check your connection and password, then try again.",
  ],
  "unknown-account": ["error", "That account is no longer set up."],
  cancelled: ["warn", "Cancelled. Nothing was changed."],
  busy: ["warn", "A check is still running."],
  invalid: ["error", "Could not remove the account. See the log."],
  denied: ["error", "Could not remove the account. See the log."],
  failed: ["error", "Could not remove the account. See the log."],
};

let acBusy = false;
let acLimits = null;

function acSetMessage(tone, text) {
  acEls.message.dataset.tone = tone;
  acEls.message.textContent = text;
}

/** Marks a value longer than the limit as invalid (the form then refuses to send it) instead of cutting it. */
function acCheckLength(input, max) {
  input.setCustomValidity(input.value.length > max ? `At most ${String(max)} characters.` : "");
}

/** The password's limit is in octets, as the schema counts it: a multi-byte password holds fewer characters. */
function acCheckOctets(input, max) {
  const size = new window.TextEncoder().encode(input.value).length;
  input.setCustomValidity(size > max ? `Too long: at most ${String(max)} bytes.` : "");
}

function acSetBusy(busy) {
  acBusy = busy;
  acEls.save.disabled = busy;
  acEls.restart.disabled = busy;
  for (const button of acEls.list.querySelectorAll("button")) button.disabled = busy;
}

function acRow(account) {
  const li = document.createElement("li");
  const title = document.createElement("div");
  title.className = "value";
  title.textContent = account.label;
  title.title = account.label;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${account.label}`);
  remove.addEventListener("click", () => {
    if (!acBusy) void acRemove(account);
  });
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(remove);
  li.append(title, actions);
  return li;
}

async function acLoad({ quiet = false } = {}) {
  const result = await acApi.mxrouteList();
  if (result === null) {
    if (!quiet) {
      acSetMessage("error", "Could not load the accounts. Close and open this section to retry.");
    }
    acLoaded = false;
    return;
  }
  acLimits = result.addLimits;
  acEls.address.minLength = acLimits.address.min;
  acEls.password.minLength = acLimits.password.min;
  acEls.host.minLength = acLimits.host.min;
  acEls.host.pattern = "[A-Za-z0-9]([A-Za-z0-9.\\-]*[A-Za-z0-9])?";
  acEls.list.replaceChildren(...result.accounts.map(acRow));
  acEls.list.hidden = result.accounts.length === 0;
  // Main remembers it, so the button comes back after the window was closed.
  acEls.restart.hidden = result.restartPending !== true;
}

async function acAdd() {
  acSetBusy(true);
  const input = {
    address: acEls.address.value,
    host: acEls.host.value,
    password: acEls.password.value,
  };
  // The password leaves the page as soon as it is sent, whatever the answer.
  acEls.password.value = "";
  let saved = false;
  try {
    acSetMessage("working", "Checking the login. This can take up to 45 seconds…");
    const reply = await acApi.accountAdd(input);
    const [tone, text] = AC_REPLY[reply] ?? AC_REPLY.failed;
    acSetMessage(tone, text);
    saved = reply === "saved" || reply === "saved-own-entries";
  } catch {
    acSetMessage("error", "Could not add the account. See the log.");
  }
  // Outside the try: a list that cannot be redrawn must not turn "Added" into "Could not add".
  if (saved) {
    acEls.address.value = "";
    acEls.host.value = "";
    await acLoad({ quiet: true }).catch(() => undefined);
  }
  acSetBusy(false);
}

async function acRemove(account) {
  acSetBusy(true);
  try {
    acSetMessage("working", "Removing…");
    const reply = await acApi.accountRemove(account.accountId);
    const [tone, text] = AC_REMOVE_REPLY[reply] ?? AC_REMOVE_REPLY.failed;
    acSetMessage(tone, text);
  } catch {
    acSetMessage("error", "Could not remove the account. See the log.");
  }
  await acLoad({ quiet: true }).catch(() => undefined);
  acSetBusy(false);
}

for (const [key, input] of [
  ["address", acEls.address],
  ["password", acEls.password],
  ["host", acEls.host],
]) {
  input.addEventListener("input", () => {
    if (acLimits === null) return;
    (key === "password" ? acCheckOctets : acCheckLength)(input, acLimits[key].max);
  });
}

acEls.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (acBusy || !acEls.form.reportValidity()) return;
  void acAdd();
});

acEls.restart.addEventListener("click", () => {
  acEls.restart.disabled = true;
  void acApi.restart().then(
    (reply) => {
      // Main refuses while a step is still running: say so and let the person try again.
      if (reply === "restarting") return;
      acSetMessage(
        "warn",
        reply === "busy"
          ? "A step is still running. Wait for it to finish, then restart."
          : "Could not restart. See the log.",
      );
      acEls.restart.disabled = false;
    },
    () => {
      acSetMessage("error", "Could not restart. See the log.");
      acEls.restart.disabled = false;
    },
  );
});

let acLoaded = false;
acEls.details.addEventListener("toggle", () => {
  if (acEls.details.open && !acLoaded) {
    acLoaded = true;
    void acLoad();
  }
});
