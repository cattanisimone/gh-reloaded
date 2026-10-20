import { getTokenRecords, getDefaultTokenId } from "../lib/github-api.js";
import { parseTargets, runDiagnostics, summarize, STATUS_LABEL } from "./token-diagnostics.js";

const { version } = chrome.runtime.getManifest();
document.querySelectorAll("[data-version]").forEach((el) => {
  el.textContent = `v${version}`;
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.add("status");
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
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
  return token ? "Paste a new token to replace it" : "github_pat_… or ghp_…";
}

function diagnosticsHtml(t) {
  const f = (cls, label, placeholder, extra = "") =>
    `<label class="field"><span class="field-label">${label}</span><input type="text" class="diag-in ${cls}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"${extra} /><span class="field-error" hidden></span></label>`;
  return `
      <div class="diag" id="diag-${escapeHtml(t.id)}" hidden>
        <div class="diag-head"><strong>Access diagnostics</strong><span class="diag-tag"></span></div>
        <div class="diag-grid">
          ${f("diag-repo", "Repository (required)", "owner/repo")}
          ${f("diag-issue", "Issue # (optional)", "12")}
          ${f("diag-project", "Project URL (optional)", "github.com/orgs/acme/projects/3")}
          ${f("diag-file", "Private file (optional)", "docs/index.html")}
        </div>
        <div class="diag-actions"><button type="button" class="btn btn-secondary diag-run">Run checks</button><span class="diag-meta"></span></div>
        <p class="diag-note">Name a repository to check. The token is checked against the targets you name only: a resource it cannot see does not prove a missing permission. Results stay on this page.</p>
        <ul class="diag-results"></ul>
        <p class="status diag-summary" role="status"></p>
      </div>`;
}

function secretFieldHtml(t) {
  const inputId = `secret-${t.id}`;
  return `
    <div class="field">
      <div class="field-label"><label for="${escapeHtml(inputId)}">Token</label><span class="field-hint tok-hint">${escapeHtml(tokenHint(t.token))}</span></div>
      <div class="input-row">
        <input id="${escapeHtml(inputId)}" type="password" class="tok-secret" placeholder="${escapeHtml(secretPlaceholder(t.token))}" autocomplete="off" spellcheck="false" />
        <button type="button" class="btn btn-secondary tok-test">Test</button>
        <button type="button" class="btn btn-secondary tok-verify" aria-expanded="false" aria-controls="diag-${escapeHtml(t.id)}">Verify access</button>
      </div>
      <p class="status tok-test-status" role="status"></p>
      ${diagnosticsHtml(t)}
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
  abortAllDiagnostics();
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
    setStatus(statusEl, `Authenticated as ${user.login}. Feature access not checked: use Verify access.`, "ok");
  } catch (err) {
    setStatus(statusEl, `Network error: ${err.message}`, "error");
  }
}

// --- Access diagnostics (per card, on request, in memory only) ---
const diagRuns = new WeakMap(); // card -> AbortController of the run in flight

function abortAllDiagnostics() {
  tokensRoot.querySelectorAll(".token-card").forEach((card) => diagRuns.get(card)?.abort());
}

function diagEls(card) {
  const q = (s) => card.querySelector(s);
  return { panel: q(".diag"), tag: q(".diag-tag"), results: q(".diag-results"), summary: q(".diag-summary"), meta: q(".diag-meta"), run: q(".diag-run"), verify: q(".tok-verify") };
}

function diagTag(card) {
  const { tag } = diagEls(card);
  const typed = card.querySelector(".tok-secret").value.trim();
  const saved = existingTokenById.get(card.dataset.id) || "";
  tag.classList.toggle("is-unsaved", !!typed);
  tag.textContent = typed ? "Unsaved token" : saved ? `Saved token …${saved.slice(-4)}` : "No token";
}

function clearDiagnostics(card, message = "") {
  diagRuns.get(card)?.abort();
  const { results, summary, meta, run } = diagEls(card);
  const had = results.childElementCount > 0 || diagRuns.has(card);
  results.replaceChildren();
  meta.textContent = "";
  run.disabled = false;
  run.textContent = "Run checks";
  setStatus(summary, had ? message : "");
  diagRuns.delete(card);
}

function renderResult(r) {
  const li = document.createElement("li");
  li.className = "diag-result";
  const text = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = r.label;
  const resource = document.createElement("span");
  resource.className = "diag-resource";
  resource.textContent = `${r.resource} · ${new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const reason = document.createElement("span");
  reason.className = "diag-reason";
  reason.textContent = r.reason;
  text.append(label, resource, reason);
  if (r.remedy && r.remedy.text) {
    const fix = document.createElement("span");
    fix.className = "diag-reason";
    fix.textContent = `${r.remedy.text} `;
    if (r.remedy.href && /^https:\/\//.test(r.remedy.href)) {
      const a = document.createElement("a");
      a.href = r.remedy.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Docs ↗";
      fix.append(a);
    }
    text.append(fix);
  }
  const pill = document.createElement("span");
  pill.className = `diag-pill is-${r.status}`;
  pill.textContent = STATUS_LABEL[r.status];
  li.append(text, pill);
  return li;
}

function readTargets(card) {
  const v = (s) => card.querySelector(s).value;
  return { repo: v(".diag-repo"), issue: v(".diag-issue"), project: v(".diag-project"), file: v(".diag-file") };
}

async function verifyAccess(card) {
  const els = diagEls(card);
  if (diagRuns.has(card)) return; // one run at a time
  const token = readSecret(card);
  const setFieldError = (cls, msg) => {
    const input = card.querySelector(cls);
    const err = input.parentElement.querySelector(".field-error");
    err.textContent = msg || "";
    err.hidden = !msg;
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };
  const parsed = parseTargets(readTargets(card));
  for (const k of ["repo", "issue", "project", "file"]) setFieldError(`.diag-${k}`, parsed.errors[k]);
  els.results.replaceChildren();
  els.meta.textContent = "";
  if (!token) {
    setStatus(els.summary, "Paste a token first.", "error");
    return;
  }
  if (!parsed.ok) {
    setStatus(els.summary, "Fix the highlighted fields.", "error");
    return;
  }
  const ctl = new AbortController();
  diagRuns.set(card, ctl);
  els.run.disabled = true;
  els.run.textContent = "Checking…";
  setStatus(els.summary, "Checking…");
  try {
    const results = await runDiagnostics(token, readTargets(card), { signal: ctl.signal });
    if (ctl.signal.aborted) return;
    els.results.replaceChildren(...results.map(renderResult));
    els.meta.textContent = `Checked ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    setStatus(els.summary, summarize(results), "");
  } catch (err) {
    if (ctl.signal.aborted) return;
    setStatus(els.summary, "The checks could not run. Try again.", "error");
  } finally {
    if (diagRuns.get(card) === ctl) {
      diagRuns.delete(card);
      els.run.disabled = false;
      els.run.textContent = "Run checks";
    }
  }
}

function toggleDiagnostics(card) {
  const { panel, verify } = diagEls(card);
  const open = panel.hidden;
  panel.hidden = !open;
  verify.setAttribute("aria-expanded", String(open));
  if (!open) return;
  diagTag(card);
  const repo = card.querySelector(".diag-repo");
  const owner = card.querySelector(".tok-owner");
  if (owner && !repo.value && normalizeOwner(owner.value)) repo.value = `${normalizeOwner(owner.value)}/`;
  repo.focus();
}

tokensRoot.addEventListener("input", (e) => {
  const card = e.target.closest(".token-card");
  if (!card) return;
  if (e.target.matches(".tok-secret")) {
    diagTag(card);
    clearDiagnostics(card, "Token changed: run the checks again.");
  } else if (e.target.matches(".diag-in")) {
    clearDiagnostics(card, "Targets changed: run the checks again.");
  }
});

tokensRoot.addEventListener("click", (e) => {
  const card = e.target.closest(".token-card");
  if (!card) return;
  if (e.target.closest(".tok-verify")) {
    toggleDiagnostics(card);
  } else if (e.target.closest(".diag-run")) {
    verifyAccess(card);
  } else if (e.target.closest(".tok-remove")) {
    diagRuns.get(card)?.abort();
    card.remove();
  } else if (e.target.closest(".tok-clear")) {
    existingTokenById.delete(card.dataset.id);
    const input = card.querySelector(".tok-secret");
    input.value = "";
    input.placeholder = secretPlaceholder("");
    card.querySelector(".tok-hint").textContent = tokenHint("");
    card.querySelector(".tok-clear").hidden = true;
    diagTag(card);
    clearDiagnostics(card, "Token removed: run the checks again.");
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
  tokensRoot.dataset.loaded = "true";
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
  { key: "ghsmEnabled", id: "feature-ghsm", defaultOn: true },
  { key: "ghhpEnabled", id: "feature-ghhp", defaultOn: true },
  { key: "ghmiEnabled", id: "feature-ghmi", defaultOn: true },
  { key: "ghprtEnabled", id: "feature-ghprt", defaultOn: true },
  { key: "ghgsEnabled", id: "feature-ghgs", defaultOn: true },
  { key: "ghgsNotice", id: "feature-ghgs-notice", defaultOn: true },
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

// Standup mode thresholds. An empty or invalid value clears the setting so
// the feature falls back to its defaults (3 days; review, qa, test, deploy,
// release) rather than storing something it would have to second-guess.
const staleDaysInput = document.getElementById("ghsm-stale-days");
const reviewKeywordsInput = document.getElementById("ghsm-review-keywords");

async function loadStandupSettings() {
  const { ghsmStaleDays, ghsmReviewKeywords } = await chrome.storage.local.get(["ghsmStaleDays", "ghsmReviewKeywords"]);
  staleDaysInput.value = ghsmStaleDays ?? "";
  reviewKeywordsInput.value = ghsmReviewKeywords ?? "";
}

staleDaysInput.addEventListener("change", async () => {
  const days = Math.floor(Number(staleDaysInput.value));
  if (Number.isFinite(days) && days >= 1) {
    staleDaysInput.value = String(days);
    await chrome.storage.local.set({ ghsmStaleDays: days });
  } else {
    staleDaysInput.value = "";
    await chrome.storage.local.remove("ghsmStaleDays");
  }
});

reviewKeywordsInput.addEventListener("change", async () => {
  const value = reviewKeywordsInput.value.trim();
  if (value) await chrome.storage.local.set({ ghsmReviewKeywords: value });
  else await chrome.storage.local.remove("ghsmReviewKeywords");
});

loadStandupSettings();

// My Issues tile width (Advanced). Same rule as the standup thresholds: an
// empty or invalid value clears the key. Values are whole pixels in 280-2000,
// and a maximum below the effective minimum (630 by default) is rejected.
const TILE_LIMITS = { min: 280, max: 2000, defaultMin: 630 };
const tileMinInput = document.getElementById("ghmi-tile-min");
const tileMaxInput = document.getElementById("ghmi-tile-max");

function tileWidthValue(input) {
  if (input.value.trim() === "") return null;
  const n = Math.floor(Number(input.value));
  return Number.isFinite(n) && n > 0 ? Math.min(TILE_LIMITS.max, Math.max(TILE_LIMITS.min, n)) : null;
}

async function saveTileWidth(input, key, floor) {
  const value = tileWidthValue(input);
  if (value !== null && value >= floor()) {
    input.value = String(value);
    await chrome.storage.local.set({ [key]: value });
  } else {
    input.value = "";
    await chrome.storage.local.remove(key);
  }
}

tileMinInput.addEventListener("change", async () => {
  await saveTileWidth(tileMinInput, "ghmiTileMin", () => 0);
  // A raised minimum can leave the saved maximum below it.
  const max = tileWidthValue(tileMaxInput);
  if (max !== null && max < (tileWidthValue(tileMinInput) ?? TILE_LIMITS.defaultMin)) {
    tileMaxInput.value = "";
    await chrome.storage.local.remove("ghmiTileMax");
  }
});
tileMaxInput.addEventListener("change", () =>
  saveTileWidth(tileMaxInput, "ghmiTileMax", () => tileWidthValue(tileMinInput) ?? TILE_LIMITS.defaultMin)
);
document.getElementById("ghmi-tile-reset").addEventListener("click", async () => {
  tileMinInput.value = "";
  tileMaxInput.value = "";
  await chrome.storage.local.remove(["ghmiTileMin", "ghmiTileMax"]);
});

async function loadTileWidths() {
  const { ghmiTileMin, ghmiTileMax } = await chrome.storage.local.get(["ghmiTileMin", "ghmiTileMax"]);
  tileMinInput.value = ghmiTileMin ?? "";
  tileMaxInput.value = ghmiTileMax ?? "";
}
loadTileWidths();

// --- Navigation ---
// One panel at a time, chosen by the URL hash so links, Configure shortcuts,
// back/forward and old bookmarks all work natively. Hidden panels are only
// hidden (never re-rendered), so unsaved token or shortcut edits survive a
// switch. A hash naming a group inside a panel shows that panel and moves
// focus to the group's heading.
const PANELS = Array.from(document.querySelectorAll(".panel-view"));
const NAV_LINKS = Array.from(document.querySelectorAll(".nav a[data-panel]"));

function route() {
  let id = location.hash.slice(1);
  try { id = decodeURIComponent(id); } catch { id = ""; }
  const target = id ? document.getElementById(id) : null;
  const panel = (target && target.closest(".panel-view")) || PANELS[0];
  PANELS.forEach((p) => { p.hidden = p !== panel; });
  NAV_LINKS.forEach((a) => {
    if (a.dataset.panel === panel.id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const active = NAV_LINKS.find((a) => a.dataset.panel === panel.id);
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  const focusEl = target && target !== panel ? target.querySelector("h2, h1") || target : panel.querySelector("h1");
  focusEl.scrollIntoView({ block: "start" });
  focusEl.focus({ preventScroll: true });
}

window.addEventListener("hashchange", route);
route();
// The browser's own fragment handling can run after this module and take the
// focus back, so claim it again once the page has finished loading.
if (document.readyState !== "complete") window.addEventListener("load", route, { once: true });
