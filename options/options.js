import { getTokenRecords, getDefaultTokenId } from "../lib/github-api.js";

const { version } = chrome.runtime.getManifest();
document.querySelectorAll("[data-version]").forEach((el) => {
  el.textContent = `v${version}`;
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status " + (kind || "");
}

// --- GitHub tokens ---
// Stored as a flat list of {id, name, token, owner} plus `defaultTokenId`.
// The page presents it as one fixed "Default token" slot (the record
// `defaultTokenId` points at, owner always blank) and a list of owner
// tokens, each of which must name the owner login (an organization or a
// personal account) it's used for — a non-default token with no owner
// would never be picked by lib/github-api.js's resolveTokenRecord().
// Saved secrets are never written back into an input's value, only their
// last 4 characters are shown, so `existingTokenById` is how a card whose
// secret field was left blank on save keeps its previously-saved token.

function genId() {
  return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const tokensRoot = document.getElementById("tokens");
const defaultSlot = document.getElementById("token-default");
const ownerList = document.getElementById("token-list");
const tokensStatus = document.getElementById("tokens-status");
let existingTokenById = new Map();
let defaultId = null;

function tokenHint(token) {
  return token ? `Saved · ends in …${token.slice(-4)}` : "Not set";
}

function secretPlaceholder(token) {
  return token ? "Paste a new token to replace it" : "github_pat_…";
}

function secretFieldHtml(t) {
  const inputId = `secret-${t.id}`;
  return `
    <div class="field">
      <div class="field-label"><label for="${escapeHtml(inputId)}">Token</label><span class="field-hint tok-hint">${escapeHtml(tokenHint(t.token))}</span></div>
      <div class="input-row">
        <input id="${escapeHtml(inputId)}" type="password" class="tok-secret" placeholder="${escapeHtml(secretPlaceholder(t.token))}" autocomplete="off" spellcheck="false" />
        <button type="button" class="btn btn-secondary tok-test">Test</button>
      </div>
      <p class="status tok-test-status" role="status"></p>
    </div>`;
}

function defaultCardHtml(t) {
  return `
    <div class="card token-card is-default" data-id="${escapeHtml(t.id)}">
      <div class="card-head">
        <span class="card-kicker"><span class="dot"></span>Default token</span>
        <button type="button" class="link-btn danger tok-clear"${t.token ? "" : " hidden"}>Remove</button>
      </div>
      <p class="card-desc">Used for every repository owner without a token of its own below.</p>
      ${secretFieldHtml(t)}
    </div>`;
}

function ownerCardHtml(t) {
  return `
    <div class="card token-card" data-id="${escapeHtml(t.id)}">
      <div class="card-head">
        <span class="card-index">Owner token</span>
        <button type="button" class="link-btn danger tok-remove">Remove</button>
      </div>
      <div class="field-grid">
        <label class="field">
          <span class="field-label">Name</span>
          <input type="text" class="tok-name" placeholder="Work, Acme SSO…" value="${escapeHtml(t.name || "")}" />
        </label>
        <label class="field">
          <span class="field-label">Owner login</span>
          <input type="text" class="tok-owner" placeholder="acme-org" value="${escapeHtml(t.owner || "")}" spellcheck="false" />
        </label>
      </div>
      ${secretFieldHtml(t)}
    </div>`;
}

function renderTokens(list, savedDefaultId) {
  existingTokenById = new Map(list.map((t) => [t.id, t.token || ""]));
  const defaultRecord = list.find((t) => t.id === savedDefaultId);
  defaultId = defaultRecord ? defaultRecord.id : genId();
  defaultSlot.innerHTML = defaultCardHtml(defaultRecord || { id: defaultId });
  ownerList.innerHTML = list.filter((t) => t !== defaultRecord).map(ownerCardHtml).join("");
}

function readSecret(card) {
  return card.querySelector(".tok-secret").value.trim() || existingTokenById.get(card.dataset.id) || "";
}

// Accepts "acme-org", "@acme-org" or a pasted "https://github.com/acme-org/…"
// — all mean the same owner, and a near-miss here would otherwise fail
// silently (the token just never gets picked).
function normalizeOwner(value) {
  return value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^@/, "").split("/")[0];
}

async function testToken(card) {
  const statusEl = card.querySelector(".tok-test-status");
  const token = readSecret(card);
  if (!token) {
    setStatus(statusEl, "Paste a token first.", "error");
    return;
  }
  setStatus(statusEl, "Testing…");
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      setStatus(statusEl, `Rejected by GitHub (HTTP ${res.status}) — check it hasn't expired or been revoked.`, "error");
      return;
    }
    const user = await res.json();
    setStatus(statusEl, `Authenticated as ${user.login}.`, "ok");
  } catch (err) {
    setStatus(statusEl, `Network error: ${err.message}`, "error");
  }
}

tokensRoot.addEventListener("click", (e) => {
  const card = e.target.closest(".token-card");
  if (!card) return;
  if (e.target.closest(".tok-remove")) {
    card.remove();
  } else if (e.target.closest(".tok-clear")) {
    existingTokenById.delete(card.dataset.id);
    const input = card.querySelector(".tok-secret");
    input.value = "";
    input.placeholder = secretPlaceholder("");
    card.querySelector(".tok-hint").textContent = tokenHint("");
    card.querySelector(".tok-clear").hidden = true;
    setStatus(card.querySelector(".tok-test-status"), "Removed — save to apply.");
  } else if (e.target.closest(".tok-test")) {
    testToken(card);
  }
});

document.getElementById("add-token").addEventListener("click", () => {
  ownerList.insertAdjacentHTML("beforeend", ownerCardHtml({ id: genId() }));
  ownerList.lastElementChild.querySelector(".tok-name").focus();
});

document.getElementById("save-tokens").addEventListener("click", async () => {
  const defaultToken = readSecret(defaultSlot.querySelector(".token-card"));
  const owners = Array.from(ownerList.querySelectorAll(".token-card"))
    .map((card) => ({
      id: card.dataset.id,
      name: card.querySelector(".tok-name").value.trim(),
      owner: normalizeOwner(card.querySelector(".tok-owner").value),
      token: readSecret(card),
    }))
    .filter((t) => t.name || t.owner || t.token);

  const incomplete = owners.find((t) => !t.owner || !t.token);
  if (incomplete) {
    const label = incomplete.name || incomplete.owner || "An owner token";
    setStatus(tokensStatus, `${label} needs ${incomplete.owner ? "a token" : "an owner login"}.`, "error");
    return;
  }
  const seen = new Set();
  const duplicate = owners.find((t) => {
    const key = t.owner.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  if (duplicate) {
    setStatus(tokensStatus, `${duplicate.owner} has more than one token — keep one per owner.`, "error");
    return;
  }

  const list = defaultToken ? [{ id: defaultId, name: "Default", owner: "", token: defaultToken }, ...owners] : owners;
  const savedDefaultId = defaultToken ? defaultId : null;
  await chrome.storage.local.set({ githubTokens: list, defaultTokenId: savedDefaultId });
  renderTokens(list, savedDefaultId);
  setStatus(tokensStatus, `Saved ${list.length} token${list.length === 1 ? "" : "s"}.`, "ok");
});

async function loadTokens() {
  renderTokens(await getTokenRecords(), await getDefaultTokenId());
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

function swatchesHtml(selected) {
  const sel = (selected || SWATCHES[0]).toLowerCase();
  return (
    `<div class="sc-swatches" data-selected="${escapeHtml(sel)}">` +
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
    `<div class="sc-icons" data-selected="${escapeHtml(sel)}">` +
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
    <div class="card shortcut-row">
      <div class="card-head">
        <span class="card-index">Shortcut</span>
        <button type="button" class="link-btn danger sc-remove">Remove</button>
      </div>
      <div class="field-grid wide-second">
        <label class="field">
          <span class="field-label">Label</span>
          <input type="text" class="sc-label" placeholder="New bug" value="${escapeHtml(s.label || "")}" />
        </label>
        <label class="field">
          <span class="field-label">Link</span>
          <input type="url" class="sc-url" placeholder="https://github.com/owner/repo/issues/new/choose" value="${escapeHtml(s.url || "")}" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">Board<span class="field-hint">optional · blank = every board</span></span>
        <input type="text" class="sc-project" placeholder="owner/number or the board's URL" value="${escapeHtml(s.project || "")}" />
      </label>
      <div class="field-grid">
        <div class="field"><span class="field-label">Icon</span>${iconsHtml(s.icon)}</div>
        <div class="field"><span class="field-label">Color</span>${swatchesHtml(s.color)}</div>
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
  shortcutsContainer.lastElementChild.querySelector(".sc-label").focus();
});

document.getElementById("save-shortcuts").addEventListener("click", async () => {
  const list = readShortcutsFromForm();
  const invalidUrl = list.find((s) => !/^https?:\/\//i.test(s.url));
  if (invalidUrl) {
    setStatus(shortcutsStatus, `"${invalidUrl.label}" needs a full http(s) URL.`, "error");
    return;
  }
  await chrome.storage.local.set({ quickCreateShortcuts: list });
  renderShortcuts(list);
  setStatus(shortcutsStatus, `Saved ${list.length} shortcut${list.length === 1 ? "" : "s"}.`, "ok");
});

async function loadShortcuts() {
  const { quickCreateShortcuts } = await chrome.storage.local.get("quickCreateShortcuts");
  renderShortcuts(quickCreateShortcuts || []);
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
