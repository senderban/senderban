// Advanced section of the sandboxed manage page: one MXroute API key per account. The key is typed here,
// sent once to the main process and then forgotten: nothing here ever receives it back, and every value
// shown came from main as plain text (textContent only).
const mxApi = window.senderban;
const mxEls = {
  details: document.getElementById("advanced"),
  list: document.getElementById("mxroute-accounts"),
  empty: document.getElementById("mxroute-empty"),
};

// Replies of the main process, as sentences. The input is never echoed.
const MX_REPLY = {
  saved: ["ok", "Saved. Stored encrypted on this device."],
  "key-refused": ["error", "MXroute refused this key. Check the server, user name and key."],
  unreachable: ["error", "Could not reach MXroute. Try again."],
  "no-domain": [
    "error",
    "This account's login is not a mail address, so there is no domain to use.",
  ],
  "no-key": ["error", "Save a key first."],
  "unknown-account": ["error", "That account is no longer set up."],
  invalid: ["error", "Check the values and try again."],
  denied: ["error", "Could not save. See the log."],
  failed: ["error", "Could not save. See the log."],
};

let mxLimits = null;
let mxBusy = false;

function field(id, labelText, input) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  input.id = id;
  wrap.append(label, input);
  return wrap;
}

function textInput(limit, value) {
  const input = document.createElement("input");
  input.type = "text";
  input.required = true;
  input.minLength = limit.min;
  input.maxLength = limit.max;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = value ?? "";
  return input;
}

function setMessage(node, tone, text) {
  node.dataset.tone = tone;
  node.textContent = text;
}

// Whether this account's blocked single addresses also go onto the MXroute blacklist. Off until switched on.
function enableRow(account, index, message) {
  const wrap = document.createElement("div");
  wrap.className = "enable";
  const row = document.createElement("div");
  row.className = "row";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = `mx-enable-${index}`;
  box.checked = account.enabled;
  const label = document.createElement("label");
  label.htmlFor = box.id;
  label.textContent = "Offer “Block at server” for single addresses";
  row.append(box, label);
  const help = document.createElement("p");
  help.className = "muted";
  help.textContent =
    "New-mail notifications then offer “Block at server” for one sender: the server refuses their mail at the door, so the sender gets an error and the mail does not reach Junk or Trash. Junk and Trash stay available and never touch MXroute. The MXroute blacklist covers the whole mail domain, so a refused address is refused for every mailbox on it. An address already on your blacklist is treated as Senderban's own and taken off again when you unblock it. A whole domain is never refused at the server. Whether MXroute drops a sender also depends on the spam-score limit in your MXroute panel, so try one block and check. Takes effect when Senderban starts; switching it off takes back what Senderban added.";
  box.addEventListener("change", () => {
    if (mxBusy) {
      box.checked = !box.checked;
      return;
    }
    void switchBlacklist(account, box, message);
  });
  wrap.append(row, help);
  return wrap;
}

async function switchBlacklist(account, box, message) {
  mxBusy = true;
  const wanted = box.checked;
  try {
    const reply = await mxApi.mxrouteEnable({ accountId: account.accountId, enabled: wanted });
    if (reply === "saved") {
      setMessage(
        message,
        "ok",
        wanted
          ? "On. It starts the next time Senderban starts."
          : "Off. It stops the next time Senderban starts.",
      );
    } else {
      box.checked = !wanted;
      const [tone, text] = MX_REPLY[reply] ?? MX_REPLY.failed;
      setMessage(message, tone, text);
    }
  } catch {
    box.checked = !wanted;
    setMessage(message, "error", "Could not save. See the log.");
  } finally {
    mxBusy = false;
  }
}

function accountBlock(account, index) {
  const li = document.createElement("li");
  li.dataset.accountId = account.accountId;

  const title = document.createElement("div");
  title.className = "value";
  title.textContent = account.label;
  title.title = account.label;
  const state = document.createElement("div");
  state.className = "meta";
  state.textContent = account.hasKey
    ? `Key saved for ${account.username} on ${account.server}. Replacing it here does not revoke the old one: delete that at panel.mxroute.com/api-keys.php.`
    : "No key saved";

  const form = document.createElement("form");
  form.autocomplete = "off";
  const server = textInput(mxLimits.server, account.server);
  server.placeholder = "e.g. eagle.mxlogin.com";
  server.pattern = "[A-Za-z0-9]([A-Za-z0-9.\\-]*[A-Za-z0-9])?";
  const username = textInput(mxLimits.username, account.username);
  // The pattern attribute is compiled with the `v` flag: `|` and `-` inside a class must be escaped.
  username.pattern = "[A-Za-z0-9._\\|\\-]+";
  const key = textInput(mxLimits.apiKey, "");
  key.type = "password";
  key.pattern = "[!-~]+";
  key.placeholder = account.hasKey ? "Paste a new key to replace it" : "Paste the key";

  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = account.hasKey ? "Replace key" : "Save key";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove key";
  remove.hidden = !account.hasKey;
  const message = document.createElement("p");
  message.className = "status";
  message.setAttribute("role", "status");

  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(save, remove);
  form.append(
    field(`mx-server-${index}`, "Server", server),
    field(`mx-user-${index}`, "User name", username),
    field(`mx-key-${index}`, "API key", key),
    actions,
    message,
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (mxBusy) return;
    if (!form.reportValidity()) return;
    void saveKey(account, { server, username, key }, message);
  });
  remove.addEventListener("click", () => {
    if (!mxBusy) void removeKey(account, message);
  });

  li.append(title, state);
  if (account.hasKey) li.append(enableRow(account, index, message));
  li.append(form);
  return li;
}

async function saveKey(account, inputs, message) {
  mxBusy = true;
  try {
    setMessage(message, "working", "Saving…");
    const reply = await mxApi.mxrouteSave({
      accountId: account.accountId,
      server: inputs.server.value,
      username: inputs.username.value,
      apiKey: inputs.key.value,
    });
    // The key leaves the page as soon as it was sent, whatever the answer.
    inputs.key.value = "";
    const [tone, text] = MX_REPLY[reply] ?? MX_REPLY.failed;
    if (reply === "saved") await reloadAccount(account.accountId, tone, text);
    else setMessage(message, tone, text);
  } catch {
    inputs.key.value = "";
    setMessage(message, "error", "Could not save. See the log.");
  } finally {
    mxBusy = false;
  }
}

async function removeKey(account, message) {
  mxBusy = true;
  try {
    setMessage(message, "working", "Removing…");
    const reply = await mxApi.mxrouteRemove(account.accountId);
    if (reply === "saved") {
      await reloadAccount(
        account.accountId,
        "ok",
        "Removed from this device. Switch the blacklist off first if Senderban added addresses: they stay on your MXroute blacklist until removed there. To revoke the key, delete it at panel.mxroute.com/api-keys.php.",
      );
    } else {
      setMessage(message, "error", "Could not remove. See the log.");
    }
  } catch {
    setMessage(message, "error", "Could not remove. See the log.");
  } finally {
    mxBusy = false;
  }
}

async function fetchAccounts() {
  const result = await mxApi.mxrouteList();
  if (result === null) return null;
  mxLimits = result.limits;
  return result.accounts;
}

// Drawn once when the section is opened. Never on the list's refresh, and a save or remove redraws only
// its own account: a redraw would wipe a key the person is typing in another account's form.
async function loadMxroute() {
  const accounts = await fetchAccounts();
  if (accounts === null) {
    mxEls.empty.textContent = "Could not load the accounts. Close and open this section to retry.";
    mxEls.empty.hidden = false;
    mxLoaded = false;
    return;
  }
  mxEls.empty.textContent = "No account is set up yet.";
  mxEls.list.replaceChildren(...accounts.map(accountBlock));
  mxEls.empty.hidden = accounts.length > 0;
}

async function reloadAccount(accountId, tone, text) {
  const accounts = await fetchAccounts();
  const index = accounts === null ? -1 : accounts.findIndex((a) => a.accountId === accountId);
  if (accounts === null || index < 0) return;
  const block = accountBlock(accounts[index], index);
  const old = [...mxEls.list.children].find((li) => li.dataset.accountId === accountId);
  if (old) old.replaceWith(block);
  const note = block.querySelector(".status");
  if (note) setMessage(note, tone, text);
}

let mxLoaded = false;
mxEls.details.addEventListener("toggle", () => {
  if (mxEls.details.open && !mxLoaded) {
    mxLoaded = true;
    void loadMxroute();
  }
});
