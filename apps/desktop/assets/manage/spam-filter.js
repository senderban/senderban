/* global setNotice */
/* exported spamFilterRow */
// The spam filter of a mailbox on its row of the Accounts view. Both controls are closed lists, and main checks the choice against the
// core schema again. A choice shows as made only once it is on disk: a failed save puts the row back.
const sfApi = window.senderban;

const SF_LEVELS = [
  {
    limit: 15,
    label: "Low: score 15 or more",
    help: "Catches clear spam only. Real mail almost never scores this high.",
  },
  {
    limit: 10,
    label: "Medium: score 10 or more",
    help: "Catches most spam. Real mail rarely scores this high.",
  },
  {
    limit: 5,
    label: "High: score 5 or more",
    help: "Catches the most spam. Real mail can score this high too.",
  },
];
const SF_ACTIONS = [
  {
    action: "junk",
    label: "Move to Junk",
    help: "Moved mail shows no notification, so look in Junk now and then.",
  },
  {
    action: "trash",
    label: "Move to Trash",
    help: "Moved mail shows no notification, and your server may empty Trash by itself.",
  },
  {
    action: "ask",
    label: "Ask in the notification",
    help: "The mail stays in the inbox, and its notification starts on Block at server where this mailbox offers it. Mail refused there leaves no copy, and the sender can be forged, so check it before you click.",
  },
];
const SF_DEFAULT_ACTION = "junk";

function sfSelect(name, options) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", name);
  select.append(
    ...options.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }),
  );
  return select;
}

/** The controls of one mailbox. `account.label` is the person's own address, and it only ever reaches `textContent` and attributes. */
function spamFilterRow(account) {
  const box = document.createElement("div");
  box.className = "spam-filter";
  const line = document.createElement("div");
  line.className = "row";
  const title = document.createElement("span");
  title.textContent = "Spam filter";
  const limit = sfSelect(`Spam filter for ${account.label}`, [
    ["off", "Off"],
    ...SF_LEVELS.map((level) => [String(level.limit), level.label]),
  ]);
  const action = sfSelect(
    `What happens to spam in ${account.label}`,
    SF_ACTIONS.map((a) => [a.action, a.label]),
  );
  const help = document.createElement("p");
  help.className = "meta";
  line.append(title, limit, action);
  box.append(line, help);

  let saved = account.spamFilter;

  const draw = (filter) => {
    limit.value = filter === null ? "off" : String(filter.limit);
    action.value = filter === null ? SF_DEFAULT_ACTION : filter.action;
    action.hidden = filter === null;
    const level = SF_LEVELS.find((l) => l.limit === filter?.limit);
    const what = SF_ACTIONS.find((a) => a.action === filter?.action);
    help.hidden = filter === null;
    help.textContent =
      filter === null
        ? ""
        : `${level.help} ${what.help} This works only if your mail server adds a spam score.`;
  };

  const save = async () => {
    const filter =
      limit.value === "off" ? null : { limit: Number(limit.value), action: action.value };
    limit.disabled = true;
    action.disabled = true;
    draw(filter);
    const reply = await sfApi
      .saveSpamFilter({ accountId: account.accountId, filter })
      .catch(() => "failed");
    limit.disabled = false;
    action.disabled = false;
    if (reply === "saved") {
      saved = filter;
      return;
    }
    draw(saved);
    setNotice("error", "Could not save the spam filter. See the log.");
  };

  limit.addEventListener("change", () => void save());
  action.addEventListener("change", () => void save());
  draw(saved);
  return box;
}
