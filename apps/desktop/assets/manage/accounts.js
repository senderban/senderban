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
  exists: ["error", "This mailbox is already set up."],
  limit: ["error", "Senderban cannot hold more accounts."],
  "login-refused": ["error", "The server refused this address or password."],
  "sieve-missing": [
    "error",
    "The login worked, but Senderban could not reach ManageSieve on port 4190, which it needs to write rules. Nothing was saved.",
  ],
  unreachable: ["error", "Could not reach this server securely. Check its name and try again."],
  busy: ["warn", "A check is still running."],
  invalid: [
    "error",
    "Check the address, the password and the server, which must be a public host name.",
  ],
  denied: ["error", "Could not add the account. See the log."],
  failed: ["error", "Could not add the account. See the log."],
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
  acEls.list.replaceChildren(
    ...result.accounts.map((account) => {
      const li = document.createElement("li");
      li.textContent = account.label;
      li.title = account.label;
      return li;
    }),
  );
  acEls.list.hidden = result.accounts.length === 0;
}

async function acAdd() {
  acBusy = true;
  acEls.save.disabled = true;
  acEls.restart.disabled = true;
  const input = {
    address: acEls.address.value,
    host: acEls.host.value,
    password: acEls.password.value,
  };
  // The password leaves the page as soon as it is sent, whatever the answer.
  acEls.password.value = "";
  try {
    acSetMessage("working", "Checking the login. This can take up to 45 seconds…");
    const reply = await acApi.accountAdd(input);
    const [tone, text] = AC_REPLY[reply] ?? AC_REPLY.failed;
    acSetMessage(tone, text);
    if (reply === "saved") {
      acEls.address.value = "";
      acEls.host.value = "";
      acEls.restart.hidden = false;
      await acLoad({ quiet: true });
    }
  } catch {
    acSetMessage("error", "Could not add the account. See the log.");
  } finally {
    acBusy = false;
    acEls.save.disabled = false;
    acEls.restart.disabled = false;
  }
}

for (const [key, input] of [
  ["address", acEls.address],
  ["password", acEls.password],
  ["host", acEls.host],
]) {
  input.addEventListener("input", () => {
    if (acLimits !== null) acCheckLength(input, acLimits[key].max);
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
