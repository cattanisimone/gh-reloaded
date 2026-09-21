import { getTokenRecords, getDefaultTokenId } from "../lib/github-api.js";

// --- GitHub tokens ---
// A user-defined list of {id, name, token, owner} — one optional owner
// login (an organization or a personal account — GitHub itself doesn't
// distinguish the two in a repo's `owner/repo` path, so neither does
// this mapping) per token maps that owner's requests to it; the token
// marked default in `defaultTokenId` covers every other owner. Saved
// secrets are never written back into an input's value (see
// renderTokens) — only their last 4 characters are shown — so
// `existingTokenById` is how a row whose secret field was left blank on
// save keeps its previously-saved token instead of being cleared.

function genId() {
  return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const tokensContainer = document.getElementById("tokens");
const tokensStatus = document.getElementById("tokens-status");
let existingTokenById = new Map();

function setTokensStatus(text, kind) {
  tokensStatus.textContent = text;
  tokensStatus.className = "status " + (kind || "");
}

function tokenHint(token) {
  return token ? `Saved — ends in …${token.slice(-4)}` : "Not saved yet";
}

function tokenRowHtml(t, isDefault) {
  const secretPlaceholder = t.token ? "Leave blank to keep the saved token" : "github_pat_...";
  return `
    <div class="token-row" data-id="${escapeAttr(t.id)}">
      <div class="token-row-main">
        <input type="text" class="tok-name" placeholder="Name (e.g. Personal, Acme Corp)" value="${escapeAttr(t.name || "")}" />
        <input type="text" class="tok-owner" placeholder="owner login — blank = default" value="${escapeAttr(t.owner || "")}" />
        <label class="tok-default-label">
          <input type="radio" name="tok-default" class="tok-default-radio" ${isDefault ? "checked" : ""} />
          Default
        </label>
        <button type="button" class="tok-remove" title="Remove">×</button>
      </div>
      <div class="token-row-sub">
        <input type="password" class="tok-secret" placeholder="${escapeAttr(secretPlaceholder)}" autocomplete="off" />
        <button type="button" class="tok-test secondary">Test</button>
        <span class="tok-hint">${tokenHint(t.token)}</span>
      </div>
      <p class="tok-test-status status"></p>
    </div>`;
}

function renderTokens(list, defaultId) {
  existingTokenById = new Map(list.map((t) => [t.id, t.token || ""]));
  tokensContainer.innerHTML = list.map((t) => tokenRowHtml(t, t.id === defaultId)).join("");
}

function ensureOneDefaultChecked() {
  const radios = Array.from(tokensContainer.querySelectorAll(".tok-default-radio"));
  if (radios.length && !radios.some((r) => r.checked)) radios[0].checked = true;
}

function readTokensFromForm() {
  return Array.from(tokensContainer.querySelectorAll(".token-row")).map((row) => {
    const id = row.dataset.id;
    const typed = row.querySelector(".tok-secret").value.trim();
    return {
      id,
      name: row.querySelector(".tok-name").value.trim(),
      owner: row.querySelector(".tok-owner").value.trim(),
      token: typed || existingTokenById.get(id) || "",
      isDefault: row.querySelector(".tok-default-radio").checked,
    };
  });
}

// Event delegation on the container — covers rows added later too, no need
// to re-attach a listener per row.
tokensContainer.addEventListener("click", async (e) => {
  if (e.target.classList.contains("tok-remove")) {
    e.target.closest(".token-row").remove();
    ensureOneDefaultChecked();
    return;
  }

  const testBtn = e.target.closest(".tok-test");
  if (!testBtn) return;
  const row = testBtn.closest(".token-row");
  const statusEl = row.querySelector(".tok-test-status");
  const typed = row.querySelector(".tok-secret").value.trim();
  const token = typed || existingTokenById.get(row.dataset.id) || "";
  if (!token) {
    statusEl.textContent = "Enter a token first.";
    statusEl.className = "status error";
    return;
  }
  statusEl.textContent = "Testing…";
  statusEl.className = "status";
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      statusEl.textContent = `Token rejected (HTTP ${res.status}).`;
      statusEl.className = "status error";
      return;
    }
    const user = await res.json();
    statusEl.textContent = `OK — authenticated as ${user.login}.`;
    statusEl.className = "status ok";
  } catch (e2) {
    statusEl.textContent = `Network error: ${e2.message}`;
    statusEl.className = "status error";
  }
});

document.getElementById("add-token").addEventListener("click", () => {
  const isFirst = !tokensContainer.querySelector(".token-row");
  tokensContainer.insertAdjacentHTML("beforeend", tokenRowHtml({ id: genId() }, isFirst));
});

document.getElementById("save-tokens").addEventListener("click", async () => {
  const entries = readTokensFromForm();
  const named = entries.filter((t) => t.name || t.owner || t.token);

  const missingToken = named.find((t) => !t.token);
  if (missingToken) {
    setTokensStatus(`"${missingToken.name || "That token"}" needs a token before it can be saved.`, "error");
    return;
  }

  const seenOwners = new Map();
  for (const t of named) {
    const owner = t.owner.toLowerCase();
    if (!owner) continue;
    if (seenOwners.has(owner)) {
      setTokensStatus(`"${t.owner}" is mapped to more than one token — each owner needs exactly one.`, "error");
      return;
    }
    seenOwners.set(owner, t.id);
  }

  const defaultEntry = named.find((t) => t.isDefault) || named[0];
  const list = named.map(({ id, name, owner, token }) => ({ id, name, owner, token }));

  await chrome.storage.local.set({
    githubTokens: list,
    defaultTokenId: defaultEntry ? defaultEntry.id : null,
  });
  renderTokens(list.length ? list : [{ id: genId() }], defaultEntry?.id);
  setTokensStatus(`Saved ${list.length} token${list.length === 1 ? "" : "s"}.`, "ok");
});

async function loadTokens() {
  const list = await getTokenRecords();
  const defaultId = await getDefaultTokenId();
  renderTokens(list.length ? list : [{ id: genId() }], defaultId);
}

// --- Quick-create shortcuts ---
// A user-defined list of {label, url, project, color, icon} — this
// feature doesn't know or assume anything about any specific repo or
// project. `project` is optional: blank means "show on every board";
// set means "only on this one" (owner/number, matching the board's own
// URL). `icon` mirrors the same key in features/quick-create/content.js
// — duplicated rather than shared, since content scripts and this page
// are separate scripts with no module system between them.

const SWATCHES = ["#1f883d", "#0969da", "#8250df", "#bf3989", "#cf222e", "#bc4c00", "#9a6700", "#57606a"];

const ICONS = {
  plus: "M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z",
  issue: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  check: "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z",
  search: "M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z",
  link: "M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.062-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z",
};
const DEFAULT_ICON = "plus";

const shortcutsContainer = document.getElementById("shortcuts");
const shortcutsStatus = document.getElementById("shortcuts-status");

function setShortcutsStatus(text, kind) {
  shortcutsStatus.textContent = text;
  shortcutsStatus.className = "status " + (kind || "");
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function swatchesHtml(selected) {
  const sel = (selected || SWATCHES[0]).toLowerCase();
  return (
    `<div class="sc-swatches" data-selected="${escapeAttr(sel)}">` +
    SWATCHES.map(
      (c) =>
        `<button type="button" class="sc-swatch${c.toLowerCase() === sel ? " is-selected" : ""}" data-color="${c}" style="background:${c};" title="${c}" aria-label="${c}"></button>`
    ).join("") +
    `</div>`
  );
}

function iconsHtml(selected) {
  const sel = ICONS[selected] ? selected : DEFAULT_ICON;
  return (
    `<div class="sc-icons" data-selected="${escapeAttr(sel)}">` +
    Object.keys(ICONS)
      .map(
        (name) =>
          `<button type="button" class="sc-icon${name === sel ? " is-selected" : ""}" data-icon="${name}" title="${name}" aria-label="${name}">` +
          `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="${ICONS[name]}"></path></svg>` +
          `</button>`
      )
      .join("") +
    `</div>`
  );
}

function shortcutRowHtml(s) {
  return `
    <div class="shortcut-row">
      <div class="shortcut-row-main">
        <input type="text" class="sc-label" placeholder="New Request" value="${escapeAttr(s.label || "")}" />
        <input type="url" class="sc-url" placeholder="https://github.com/owner/repo/issues/new/choose" value="${escapeAttr(s.url || "")}" />
        <button type="button" class="sc-remove" title="Remove">×</button>
      </div>
      <div class="shortcut-row-sub">
        <input type="text" class="sc-project" placeholder="owner/number or the board's URL — optional (blank = every board)" value="${escapeAttr(s.project || "")}" />
        ${iconsHtml(s.icon)}
        ${swatchesHtml(s.color)}
      </div>
    </div>`;
}

function renderShortcuts(list) {
  shortcutsContainer.innerHTML = list.map(shortcutRowHtml).join("");
}

function readShortcutsFromForm() {
  return Array.from(shortcutsContainer.querySelectorAll(".shortcut-row"))
    .map((row) => ({
      label: row.querySelector(".sc-label").value.trim(),
      url: row.querySelector(".sc-url").value.trim(),
      project: row.querySelector(".sc-project").value.trim(),
      color: row.querySelector(".sc-swatches").dataset.selected,
      icon: row.querySelector(".sc-icons").dataset.selected,
    }))
    .filter((s) => s.label && s.url);
}

// Event delegation on the container — covers rows added later too, no need
// to re-attach a listener per row.
shortcutsContainer.addEventListener("click", (e) => {
  if (e.target.classList.contains("sc-remove")) {
    e.target.closest(".shortcut-row").remove();
    return;
  }
  if (e.target.classList.contains("sc-swatch")) {
    const swatches = e.target.closest(".sc-swatches");
    swatches.dataset.selected = e.target.dataset.color;
    swatches.querySelectorAll(".sc-swatch").forEach((b) => b.classList.remove("is-selected"));
    e.target.classList.add("is-selected");
    return;
  }
  const iconBtn = e.target.closest(".sc-icon");
  if (iconBtn) {
    const icons = iconBtn.closest(".sc-icons");
    icons.dataset.selected = iconBtn.dataset.icon;
    icons.querySelectorAll(".sc-icon").forEach((b) => b.classList.remove("is-selected"));
    iconBtn.classList.add("is-selected");
  }
});

document.getElementById("add-shortcut").addEventListener("click", () => {
  shortcutsContainer.insertAdjacentHTML("beforeend", shortcutRowHtml({ color: SWATCHES[0], icon: DEFAULT_ICON }));
});

document.getElementById("save-shortcuts").addEventListener("click", async () => {
  const list = readShortcutsFromForm();
  const invalidUrl = list.find((s) => !/^https?:\/\//i.test(s.url));
  if (invalidUrl) {
    setShortcutsStatus(`"${invalidUrl.label}" needs a full http(s) URL.`, "error");
    return;
  }
  await chrome.storage.local.set({ quickCreateShortcuts: list });
  renderShortcuts(list.length ? list : [{}]);
  setShortcutsStatus(`Saved ${list.length} shortcut${list.length === 1 ? "" : "s"}.`, "ok");
});

async function loadShortcuts() {
  const { quickCreateShortcuts } = await chrome.storage.local.get("quickCreateShortcuts");
  renderShortcuts(quickCreateShortcuts && quickCreateShortcuts.length ? quickCreateShortcuts : [{}]);
}

loadTokens();
loadShortcuts();

// --- Features ---
// One on/off flag per feature, shared with (and toggleable from) whatever
// switch the feature itself adds on github.com — storage.onChanged is what
// keeps this panel and that in-page control in sync, in either direction.
// Dependency graph and Quick-create predate having a flag at all, so an
// unset value means "on" for those two; Board dependency arrows is new and
// opt-in, so unset means "off" for that one.

const FEATURE_TOGGLES = [
  { key: "ghdgEnabled", id: "feature-ghdg", defaultOn: true },
  { key: "quickCreateEnabled", id: "feature-quick-create", defaultOn: true },
  { key: "ghbdEnabled", id: "feature-ghbd", defaultOn: false },
  { key: "ghfwEnabled", id: "feature-ghfw", defaultOn: true },
  { key: "ghhpEnabled", id: "feature-ghhp", defaultOn: true },
];

const featuresStatus = document.getElementById("features-status");

async function loadFeatureToggles() {
  const stored = await chrome.storage.local.get(FEATURE_TOGGLES.map((f) => f.key));
  for (const f of FEATURE_TOGGLES) {
    const value = stored[f.key];
    const on = value === undefined ? f.defaultOn : !!value;
    document.getElementById(f.id).setAttribute("aria-checked", String(on));
  }
}

for (const f of FEATURE_TOGGLES) {
  document.getElementById(f.id).addEventListener("click", async (e) => {
    const next = e.currentTarget.getAttribute("aria-checked") !== "true";
    e.currentTarget.setAttribute("aria-checked", String(next));
    await chrome.storage.local.set({ [f.key]: next });
    featuresStatus.textContent = next ? "Enabled." : "Disabled.";
    featuresStatus.className = "status ok";
  });
}

chrome.storage.onChanged.addListener((changes) => {
  for (const f of FEATURE_TOGGLES) {
    if (changes[f.key]) {
      document.getElementById(f.id).setAttribute("aria-checked", String(!!changes[f.key].newValue));
    }
  }
});

loadFeatureToggles();
