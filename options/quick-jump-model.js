// Quick jump row of Settings: the copy and the state of the row as pure
// functions, so the page only has to put them on screen. No chrome.* here.

export const COMMAND_NAME = "open-quick-jump";
export const CHOICES = ["browser", "cmdk"];

export const DESC_REMEMBERS = "Remembers the issues, pull requests and repositories you open on GitHub, in this browser only.";
export const DESC_NO_TOKEN = "Needs a GitHub token. Add one in GitHub tokens.";

export const isMac = (platform) => /mac/i.test(String(platform || ""));

const MAC_MODIFIERS = { macctrl: "⌃", alt: "⌥", option: "⌥", shift: "⇧", command: "⌘", ctrl: "⌘", cmd: "⌘" };
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];

// Chrome reports a command's shortcut as "Alt+Shift+K" (words) on Windows and
// Linux and, on a Mac, either words or symbols already. An empty string means
// Chrome left it unassigned.
export function formatShortcut(raw, mac) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const text = raw.trim();
  if (!text.includes("+")) return text;
  const parts = text.split("+").filter(Boolean);
  const key = parts.pop();
  const shownKey = key.length === 1 ? key.toUpperCase() : key;
  if (!mac) return [...parts, shownKey].join("+");
  const mods = new Set(parts.map((p) => MAC_MODIFIERS[p.toLowerCase()] || p));
  const symbols = MAC_ORDER.filter((s) => mods.delete(s));
  return [...symbols, ...mods, shownKey].join("");
}

// The two values of the Shortcut select. `full` is the issue's label, `short`
// the form used only where the full one does not fit the select.
export function shortcutOptions({ mac, shortcut }) {
  const own = formatShortcut(shortcut, mac);
  const key = mac ? "⌘K" : "Ctrl+K";
  return [
    { value: "browser", full: own || "Browser shortcut (not set)", short: own || "Not set" },
    { value: "cmdk", full: `${key} — replaces GitHub's command palette`, short: key },
  ];
}

export function describingLine({ value, mac, shortcut }) {
  const key = mac ? "⌘K" : "Ctrl+K";
  if (value !== "cmdk") return `Works on every GitHub page, outside text fields. ${key} stays GitHub's.`;
  const palette = mac ? "⌘⌥K" : "Ctrl+Alt+K";
  const own = formatShortcut(shortcut, mac);
  return `Outside text fields, ${key} opens Quick jump instead of GitHub's command palette, which still opens with ${palette}. In comment boxes and editors ${key} stays GitHub's: it inserts a link.${own ? ` ${own} keeps working too.` : ""}`;
}

// stored: { ghqjEnabled, ghqjShortcut } as read from chrome.storage.local.
// Without a token the row is off whatever was stored (the stored value is not
// touched, so adding a token restores the last choice).
export function rowView({ hasToken, stored = {}, mac, shortcut }) {
  const choice = stored.ghqjShortcut === "cmdk" ? "cmdk" : "browser";
  const on = stored.ghqjEnabled === true;
  return {
    disabled: !hasToken,
    checked: hasToken && on,
    description: hasToken ? DESC_REMEMBERS : DESC_NO_TOKEN,
    showControls: hasToken && on,
    choice,
    options: shortcutOptions({ mac, shortcut }),
    line: describingLine({ value: choice, mac, shortcut }),
    unassigned: !formatShortcut(shortcut, mac),
  };
}
