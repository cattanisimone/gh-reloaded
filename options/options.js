import { getTokenRecords, getDefaultTokenId } from "../lib/github-api.js";
import { parseTargets, runDiagnostics, summarize, STATUS, STATUS_LABEL } from "./token-diagnostics.js";
import { runTokenTest, readTests, writeTest } from "./token-test.js";
import { requiredTypes, enabledFeatures, SWITCH_KEYS } from "./token-requirements.js";
import { tokenView, rowHtml, resultView, resultHtml, warningDetailsHtml, warningStepsHtml, whichLines, testHint, displayName, escapeHtml } from "./token-view.js";

const { version } = chrome.runtime.getManifest();
document.querySelectorAll("[data-version]").forEach((el) => {
  el.textContent = `v${version}`;
});

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.add("status");
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}

// --- GitHub tokens ---
// Stored as a flat list of {id, name, token, owner} plus `defaultTokenId`.
// The page presents it as one list: the default token first (the record
// `defaultTokenId` points at, owner always blank) and the owner tokens, each
// of which must name the owner login (an organization or a personal account)
// it is used for: a non-default token with no owner would never be picked by
// lib/github-api.js's resolveTokenRecord(). Editing happens in a side panel
// on a draft; nothing is written until Save. A saved secret is never put back
// into the page: the panel shows "Saved" and a Replace token button.

function genId() {
  return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const tokensRoot = document.getElementById("tokens");
const tokenListEl = document.getElementById("token-list");
const tokensStatus = document.getElementById("tokens-status");
const shell = document.querySelector(".shell");
const panelEl = document.getElementById("token-panel");
const $p = (id) => document.getElementById(`panel-${id}`);

let records = []; // saved {id, name, owner, token}
let defaultId = genId();
let tests = {}; // session outcome codes by token id
let switches = {}; // stored feature switches
const results = new Map(); // token id -> last result shown under its row
const runs = new Map(); // token id -> AbortController of a row test in flight
const rowDiags = new Map(); // token id -> diagnostics controller
const ui = { laterHidden: false, stepsKey: null }; // page state the view model reads
let warningView = null; // the warning of the last render
let panel = null; // draft of the token open in the side panel
let panelDiag = null;
let guideSet = false;

// Accepts "acme-org", "@acme-org" or a pasted "https://github.com/acme-org/…"
// — all mean the same owner, and a near-miss here would otherwise fail
// silently (the token just never gets picked).
function normalizeOwner(value) {
  return value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^@/, "").split("/")[0];
}

function entries() {
  const def = records.find((t) => t.id === defaultId);
  const owners = records.filter((t) => t.id !== defaultId);
  return [{ id: defaultId, isDefault: true, name: def?.name || "", owner: "", token: def?.token || "" }, ...owners.map((t) => ({ ...t, isDefault: false }))];
}
const entryById = (id) => entries().find((e) => e.id === id);
const required = () => requiredTypes(enabledFeatures(switches));
const timeLabel = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// --- Rendering ---
// tokenView() decides what to show; render() only puts it on the page.

// A button disabled while its test runs loses focus; the focus waits here and returns when it is enabled again.
let pendingFocus = null;
let pendingPanelTest = false;
const focusKey = (el) => ({ act: el.dataset.act, id: el.dataset.id, fk: el.dataset.fk || "" });
const atRest = () => !document.activeElement || document.activeElement === document.body;

function render() {
  const active = document.activeElement;
  let keep = active && tokensRoot.contains(active) && active.dataset?.act ? focusKey(active) : null;
  if (!keep && pendingFocus && atRest()) keep = pendingFocus;
  // An open repository check keeps its DOM (typed values, a run in flight).
  const oldHosts = new Map([...tokenListEl.querySelectorAll("[data-diag]")].map((h) => [h.dataset.diag, h]));
  const inDiag = active && [...oldHosts.values()].some((h) => h.contains(active)) ? active : null;
  const view = tokenView({
    entries: entries(), tests, results, runs: new Set(runs.keys()), required: required(), features: enabledFeatures(switches), version,
    ui: { laterHidden: ui.laterHidden, stepsKey: ui.stepsKey, editingId: panel ? panel.id : null, diags: new Set(rowDiags.keys()) },
  });
  tokenListEl.innerHTML = view.rows.map(rowHtml).join("");
  for (const [id, diag] of rowDiags) {
    const host = tokenListEl.querySelector(`[data-diag="${CSS.escape(id)}"]`);
    if (!host) continue;
    if (oldHosts.has(id)) host.replaceWith(oldHosts.get(id));
    else diag.attach(host);
  }
  if (inDiag && inDiag.isConnected && document.activeElement !== inDiag) inDiag.focus();
  if (keep) {
    const target = [...tokenListEl.querySelectorAll(`[data-act="${keep.act}"][data-id="${CSS.escape(keep.id)}"]`)].find((el) => (el.dataset.fk || "") === keep.fk);
    if (target && target.disabled) pendingFocus = keep;
    else {
      pendingFocus = null;
      target?.focus();
    }
  }
  renderWarning(view.warning);
  if (!guideSet) {
    document.getElementById("full-guide").open = !records.some((t) => t.token);
    guideSet = true;
  }
  if (panel) updatePanel();
}

function renderWarning(w) {
  warningView = w;
  const box = document.getElementById("token-warning");
  const ol = document.getElementById("warning-steps");
  box.hidden = !w;
  if (!w) {
    ui.stepsKey = null; // hiding the warning forgets the steps
    ol.hidden = true;
    return;
  }
  box.dataset.ids = w.ids.join(",");
  document.getElementById("warning-title").textContent = w.title;
  document.getElementById("warning-body").textContent = w.body;
  document.getElementById("warning-details").innerHTML = warningDetailsHtml(w);
  ol.innerHTML = warningStepsHtml(w.steps);
  ol.hidden = !w.steps.shown;
}

// --- Testing a saved token (a row) ---

async function testRow(id) {
  const e = entryById(id);
  if (!e || !e.token || runs.has(id)) return;
  const ctl = new AbortController();
  runs.set(id, ctl);
  render();
  try {
    const res = await runTokenTest({ token: e.token, owner: e.owner }, { signal: ctl.signal });
    if (ctl.signal.aborted) return;
    results.set(id, res);
    if (res.record && entryById(id)?.token === e.token && entryById(id)?.owner === e.owner) {
      tests[id] = res.record;
      await writeTest(id, res.record);
    }
  } catch (err) {
    if (ctl.signal.aborted) return;
    results.set(id, { outcome: "temporary", message: "The test could not run. Try again." });
  } finally {
    if (runs.get(id) === ctl) runs.delete(id);
    render();
  }
}

async function testAll(ids) {
  for (const id of ids) await testRow(id);
}

// --- Check a specific repository (today's diagnostics, on demand) ---

function createDiag({ getToken, getOwner }) {
  let host = null;
  let run = null;
  const q = (s) => host.querySelector(s);
  const html = `
    <div class="diag">
      <div class="diag-head"><strong>Check a specific repository</strong></div>
      <div class="diag-grid">
        ${[["repo", "Repository (required)", "owner/repo"], ["issue", "Issue # (optional)", "12"], ["project", "Project URL (optional)", "github.com/orgs/acme/projects/3"], ["file", "Private file (optional)", "docs/index.html"]]
          .map(([k, l, ph]) => `<label class="field"><span class="field-label">${l}</span><input type="text" class="diag-in diag-${k}" placeholder="${ph}" autocomplete="off" spellcheck="false" /><span class="field-error" hidden></span></label>`).join("")}
      </div>
      <div class="diag-actions"><button type="button" class="btn btn-secondary diag-run">Run checks</button><span class="diag-meta"></span></div>
      <p class="diag-note">Name a repository to check. The token is checked against the targets you name only: a resource it cannot see does not prove a missing permission. Results stay on this page.</p>
      <ul class="diag-results"></ul>
      <p class="status diag-summary" role="status"></p>
    </div>`;
  const values = { repo: "", issue: "", project: "", file: "" };
  const self = {
    attach(el) {
      host = el;
      host.innerHTML = html;
      for (const k of Object.keys(values)) q(`.diag-${k}`).value = values[k];
      if (!values.repo && getOwner()) q(".diag-repo").value = values.repo = `${getOwner()}/`;
      host.addEventListener("input", (ev) => {
        if (!ev.target.matches(".diag-in")) return;
        for (const k of Object.keys(values)) values[k] = q(`.diag-${k}`).value;
        self.reset("Targets changed: run the checks again.");
      });
      q(".diag-run").addEventListener("click", () => self.run());
      if (self.last) q(".diag-results").replaceChildren(...self.last.map(renderDiagResult)), (q(".diag-meta").textContent = self.meta || "");
    },
    focus() { q(".diag-repo")?.focus(); },
    reset(message = "") {
      run?.abort();
      run = null;
      self.last = null;
      if (!host) return;
      q(".diag-results").replaceChildren();
      q(".diag-meta").textContent = "";
      const btn = q(".diag-run");
      btn.disabled = false;
      btn.textContent = "Run checks";
      setStatus(q(".diag-summary"), message);
    },
    async run() {
      if (run) return;
      const els = { summary: q(".diag-summary"), btn: q(".diag-run") };
      const token = getToken();
      const parsed = parseTargets(values);
      for (const k of ["repo", "issue", "project", "file"]) {
        const input = q(`.diag-${k}`);
        const err = input.parentElement.querySelector(".field-error");
        err.textContent = parsed.errors[k] || "";
        err.hidden = !parsed.errors[k];
        if (parsed.errors[k]) {
          input.setAttribute("aria-invalid", "true");
          err.id = `diag-err-${k}`;
          input.setAttribute("aria-describedby", err.id);
        } else {
          input.removeAttribute("aria-invalid");
          input.removeAttribute("aria-describedby");
        }
      }
      q(".diag-results").replaceChildren();
      q(".diag-meta").textContent = "";
      if (!token) return setStatus(els.summary, "Paste a token first.", "error");
      if (!parsed.ok) return setStatus(els.summary, "Fix the highlighted fields.", "error");
      const ctl = new AbortController();
      run = ctl;
      els.btn.disabled = true;
      els.btn.textContent = "Checking…";
      setStatus(els.summary, "Checking…");
      try {
        const out = await runDiagnostics(token, values, { signal: ctl.signal });
        if (ctl.signal.aborted) return;
        self.last = out;
        self.meta = `Checked ${timeLabel()}`;
        q(".diag-results").replaceChildren(...out.map(renderDiagResult));
        q(".diag-meta").textContent = self.meta;
        setStatus(els.summary, summarize(out), "");
      } catch (err) {
        if (ctl.signal.aborted) return;
        setStatus(els.summary, "The checks could not run. Try again.", "error");
      } finally {
        if (run === ctl) {
          run = null;
          els.btn.disabled = false;
          els.btn.textContent = "Run checks";
        }
      }
    },
    last: null,
    meta: "",
  };
  return self;
}

function renderDiagResult(r) {
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

// --- Side panel (a draft of one token; nothing is written before Save) ---

// Replace token with nothing typed keeps the saved token, so a rename can still be saved.
const panelSecret = () => (panel.isNew || (panel.replacing && panel.secret.trim()) ? panel.secret.trim() : panel.saved.token);
const panelOwner = () => (panel.isDefault ? "" : normalizeOwner(panel.owner));
const tokenOrOwnerChanged = () => panel.isNew || (panel.replacing && panel.secret.trim() !== "") || panelOwner() !== (panel.saved.owner || "");

function changedFields() {
  const f = [];
  if (panel.removed) return ["Token removed"];
  if (panel.name.trim() !== (panel.saved.name === "Default" ? "" : panel.saved.name || "")) f.push("Name");
  if (!panel.isDefault && panelOwner() !== (panel.saved.owner || "")) f.push("GitHub owner");
  if (panel.replacing && panel.secret.trim()) f.push("Token");
  return f;
}

function openPanel(id) {
  if (panel) closePanel({ keepFocus: true });
  const isNew = id === null;
  const e = isNew ? { id: genId(), isDefault: false, name: "", owner: "", token: "" } : entryById(id);
  if (!e) return;
  panel = { id: e.id, isNew, isDefault: e.isDefault, saved: { name: e.name, owner: e.owner, token: e.token }, name: e.name === "Default" ? "" : e.name, owner: e.owner, secret: "", replacing: !e.token, removed: false, draftResult: null, testCtl: null };
  panelDiag = createDiag({ getToken: () => panelSecret(), getOwner: () => panelOwner() });
  $p("title").textContent = isNew ? "Add token" : e.isDefault ? "Edit default token" : "Edit token";
  $p("name").value = panel.name;
  $p("owner").value = panel.owner;
  $p("secret").value = "";
  $p("owner-field").hidden = panel.isDefault;
  $p("remove").hidden = isNew || !e.token;
  $p("status").textContent = "";
  $p("check").setAttribute("aria-expanded", "false");
  $p("diag").hidden = true;
  $p("result").hidden = true;
  clearErrors();
  syncSpace();
  updatePanel();
  render();
  $p("name").focus();
}

function closePanel({ keepFocus = false } = {}) {
  if (!panel) return;
  const id = panel.id;
  panel.testCtl?.abort();
  panel = null;
  panelDiag = null;
  syncSpace();
  render();
  if (!keepFocus) (tokenListEl.querySelector(`[data-act="edit"][data-id="${CSS.escape(id)}"]`) || document.getElementById("add-token")).focus();
}

// The panel sits beside the list from 1024px and is a full-page sheet below:
// the sheet is modal for the keyboard (aria-modal, the rest of the page inert),
// the side panel is not. The media query is the one the stylesheet uses.
const sheetQuery = window.matchMedia("(max-width: 1023px)");

function syncSpace() {
  const open = !!panel && !document.getElementById("tokens-section").hidden;
  shell.classList.toggle("panel-open", open);
  panelEl.hidden = !open;
  const modal = open && sheetQuery.matches;
  panelEl.setAttribute("aria-modal", String(modal));
  shell.toggleAttribute("inert", modal);
}
sheetQuery.addEventListener("change", syncSpace);

function clearErrors() {
  for (const k of ["owner", "secret"]) {
    $p(`${k}-error`).hidden = true;
    $p(k).removeAttribute("aria-invalid");
    $p(k).removeAttribute("aria-describedby");
  }
}

function fieldError(k, msg) {
  const el = $p(`${k}-error`);
  el.textContent = msg;
  el.hidden = false;
  $p(k).setAttribute("aria-invalid", "true");
  $p(k).setAttribute("aria-describedby", `panel-${k}-error`);
  $p(k).focus();
}

function updatePanel() {
  const hasSaved = !!panel.saved.token && !panel.isNew && !panel.removed;
  const saved = hasSaved && !panel.replacing;
  $p("saved").hidden = !saved;
  $p("replace").hidden = !saved;
  $p("secret").hidden = !panel.replacing;
  const def = entries().find((e) => e.isDefault);
  const lines = whichLines({ isDefault: panel.isDefault, owner: normalizeOwner(panel.owner), defaultName: displayName(def), hasDefault: !!def?.token });
  $p("which").innerHTML = `<strong>Which token is used</strong>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}`;
  const changes = changedFields();
  const tag = $p("changes");
  tag.hidden = !changes.length;
  const label = panel.removed ? "Token will be removed when you save" : `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}: ${changes.join(", ")}`;
  tag.innerHTML = changes.length ? `<span class="changes-tag">${escapeHtml(label)}</span><span class="changes-note">Discard changes goes back to the saved values.</span>` : "";
  const secret = panelSecret();
  const hint = !secret ? "Enter a token to test it" : !panel.isDefault && !panelOwner() ? "Enter the GitHub owner to test it" : "";
  const busy = !!panel.testCtl || runs.has(panel.id);
  const testBtn = $p("test");
  if (document.activeElement === testBtn && busy) pendingPanelTest = true;
  testBtn.disabled = !!hint || busy || panel.removed;
  if (pendingPanelTest && !testBtn.disabled && atRest()) testBtn.focus();
  if (!busy) pendingPanelTest = false;
  $p("test").textContent = busy ? "Testing…" : "Test";
  $p("test-hint").textContent = testHint(hint);
  const res = $p("result");
  const draft = tokenOrOwnerChanged();
  const shown = draft ? panel.draftResult : results.get(panel.id);
  res.hidden = !shown || panel.removed;
  res.innerHTML = shown && !panel.removed ? resultHtml(resultView({ ...entryById(panel.id), name: panel.name, isDefault: panel.isDefault }, shown, { required: required(), draft })) : "";
}

// Editing the token or the owner invalidates a test in flight and any result
// taken with other values.
function panelEdited(kind) {
  if (kind === "name") return;
  const running = panel.testCtl || runs.get(panel.id);
  panel.testCtl?.abort();
  runs.get(panel.id)?.abort();
  runs.delete(panel.id);
  panel.testCtl = null;
  panelDiag?.reset("Token or owner changed: run the checks again.");
  if (running) panel.draftResult = { outcome: "aborted", message: "The token or owner changed while testing. Test again." };
  else panel.draftResult = null;
  if (running && !tokenOrOwnerChanged()) results.set(panel.id, { outcome: "aborted", message: "The token or owner changed while testing. Test again." });
}

async function panelTest() {
  if (!panel || $p("test").disabled) return;
  if (!tokenOrOwnerChanged()) {
    await testRow(panel.id);
    return;
  }
  const ctl = new AbortController();
  const token = panelSecret();
  const owner = panelOwner();
  panel.testCtl = ctl;
  panel.draftResult = null;
  updatePanel();
  try {
    const res = await runTokenTest({ token, owner }, { signal: ctl.signal });
    if (ctl.signal.aborted || !panel) return;
    panel.draftResult = { ...res, token, owner };
  } catch (err) {
    if (ctl.signal.aborted || !panel) return;
    panel.draftResult = { outcome: "temporary", message: "The test could not run. Try again." };
  } finally {
    if (panel && panel.testCtl === ctl) panel.testCtl = null;
    if (panel) updatePanel();
  }
}

async function savePanel() {
  clearErrors();
  $p("status").textContent = "";
  const p = panel;
  const others = records.filter((t) => t.id !== p.id);
  let updated = null;
  if (!p.removed) {
    const owner = panelOwner();
    const token = panelSecret();
    if (!p.isDefault && !owner) return fieldError("owner", "Enter the GitHub owner this token is for.");
    if (!token) return fieldError("secret", "Paste a token to save.");
    if (!p.isDefault && others.some((t) => t.id !== defaultId && (t.owner || "").toLowerCase() === owner.toLowerCase())) {
      return fieldError("owner", `${owner} already has a token — keep one per owner.`);
    }
    updated = p.isDefault
      ? { id: p.id, name: p.name.trim() || "Default", owner: "", token }
      : { id: p.id, name: p.name.trim(), owner, token };
  }
  const defaultRec = p.isDefault ? updated : records.find((t) => t.id === defaultId);
  const ownerRecs = records.filter((t) => t.id !== defaultId);
  const owners = p.isDefault ? ownerRecs : p.isNew ? [...ownerRecs, ...(updated ? [updated] : [])] : ownerRecs.flatMap((t) => (t.id === p.id ? (updated ? [updated] : []) : [t]));
  const next = [...(defaultRec ? [defaultRec] : []), ...owners];
  try {
    await chrome.storage.local.set({ githubTokens: next, defaultTokenId: defaultRec ? defaultRec.id : null });
  } catch (err) {
    setStatus($p("status"), `Couldn't save the token: ${err?.message || "storage error"}. Your changes are kept.`, "error");
    return;
  }
  const changed = p.removed || tokenOrOwnerChanged();
  const adopt = !p.removed && p.draftResult && p.draftResult.record && p.draftResult.token === updated.token && p.draftResult.owner === updated.owner;
  p.testCtl?.abort();
  runs.get(p.id)?.abort();
  runs.delete(p.id);
  records = next;
  if (p.isDefault && !updated) defaultId = genId();
  if (adopt) {
    tests[p.id] = p.draftResult.record;
    results.set(p.id, p.draftResult);
    await writeTest(p.id, p.draftResult.record);
  } else if (changed) {
    delete tests[p.id];
    results.delete(p.id);
    await writeTest(p.id, null);
  }
  if (p.removed) rowDiags.delete(p.id);
  setStatus(tokensStatus, p.removed ? "Token removed." : `Saved ${displayName({ ...updated, isDefault: p.isDefault })}.`, "ok");
  closePanel();
}

panelEl.addEventListener("input", (e) => {
  if (!panel) return;
  if (e.target.id === "panel-name") panel.name = e.target.value;
  else if (e.target.id === "panel-owner" || e.target.id === "panel-secret") {
    if (e.target.id === "panel-owner") panel.owner = e.target.value;
    else panel.secret = e.target.value;
    panelEdited(e.target.id);
    $p(e.target.id === "panel-owner" ? "owner-error" : "secret-error").hidden = true;
    e.target.removeAttribute("aria-invalid");
    e.target.removeAttribute("aria-describedby");
    render();
    return;
  }
  updatePanel();
});
$p("replace").addEventListener("click", () => { panel.replacing = true; updatePanel(); $p("secret").focus(); });
$p("close").addEventListener("click", () => closePanel());
$p("discard").addEventListener("click", () => closePanel());
$p("save").addEventListener("click", savePanel);
$p("test").addEventListener("click", panelTest);
$p("remove").addEventListener("click", () => {
  panel.removed = true;
  panelEdited("secret");
  updatePanel();
});
$p("check").addEventListener("click", () => {
  const open = $p("diag").hidden;
  $p("diag").hidden = !open;
  $p("check").setAttribute("aria-expanded", String(open));
  if (open) {
    panelDiag.attach($p("diag"));
    panelDiag.focus();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panel && !panelEl.hidden && !document.getElementById("tokens-section").hidden) closePanel();
});

function openGuide() {
  const g = document.getElementById("full-guide");
  g.open = true;
  g.scrollIntoView({ block: "start" });
  g.querySelector("summary").focus();
}

tokensRoot.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === "test") testRow(id);
  else if (btn.dataset.act === "edit") openPanel(id);
  else if (btn.dataset.act === "advice") openGuide();
  else if (btn.dataset.act === "row-check") {
    if (rowDiags.has(id)) rowDiags.delete(id);
    else rowDiags.set(id, createDiag({ getToken: () => entryById(id)?.token || "", getOwner: () => entryById(id)?.owner || "" }));
    render();
    rowDiags.get(id)?.focus();
  }
});

document.getElementById("add-token").addEventListener("click", () => openPanel(null));
document.getElementById("warning-how").addEventListener("click", () => {
  if (!warningView) return;
  ui.stepsKey = warningView.steps.key;
  render();
  document.getElementById("warning-steps").focus();
});
document.getElementById("warning-later").addEventListener("click", () => { ui.laterHidden = true; render(); });
document.getElementById("warning-retest").addEventListener("click", () => testAll(warningView ? warningView.ids : []));

async function loadTokens() {
  records = await getTokenRecords();
  const savedDefault = await getDefaultTokenId();
  defaultId = records.some((t) => t.id === savedDefault) ? savedDefault : genId();
  tests = await readTests();
  switches = await chrome.storage.local.get(SWITCH_KEYS);
  render();
  tokensRoot.dataset.loaded = "true";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !SWITCH_KEYS.some((k) => changes[k])) return;
  for (const k of SWITCH_KEYS) if (changes[k]) switches[k] = changes[k].newValue;
  render();
});

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
  { key: "ghqaEnabled", id: "feature-ghqa", defaultOn: false },
  { key: "ghlpsEnabled", id: "feature-ghlps", defaultOn: true },
  { key: "ghgsEnabled", id: "feature-ghgs", defaultOn: true },
  { key: "ghgsNotice", id: "feature-ghgs-notice", defaultOn: true },
  { key: "ghigEnabled", id: "feature-ghig", defaultOn: true },
  { key: "ghigAutoOpen", id: "feature-ghig-auto", defaultOn: true },
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

// Notification reason tags live in the notifications engine's module map
// (ghntModules: { id: boolean }), shared with later modules of that engine:
// unset means on, and the object is merged, never replaced, so other modules
// and Native inbox keep their values.
const REASON_TAGS_SWITCH = document.getElementById("feature-ghnt-reason-tags");

async function loadReasonTags() {
  const { ghntModules } = await chrome.storage.local.get("ghntModules");
  REASON_TAGS_SWITCH.setAttribute("aria-checked", String(ghntModules?.reasonTags !== false));
}

REASON_TAGS_SWITCH.addEventListener("click", async (e) => {
  const next = e.currentTarget.getAttribute("aria-checked") !== "true";
  e.currentTarget.setAttribute("aria-checked", String(next));
  const { ghntModules } = await chrome.storage.local.get("ghntModules");
  await chrome.storage.local.set({ ghntModules: { ...(ghntModules && typeof ghntModules === "object" ? ghntModules : {}), reasonTags: next } });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.ghntModules) REASON_TAGS_SWITCH.setAttribute("aria-checked", String(changes.ghntModules.newValue?.reasonTags !== false));
});

loadReasonTags();

// Standup mode thresholds. An empty or invalid value clears the setting so
// the feature falls back to its defaults (3 days; review, qa, test, deploy,
// release) rather than storing something it would have to second-guess.
const staleDaysInput = document.getElementById("ghsm-stale-days");
const reviewKeywordsInput = document.getElementById("ghsm-review-keywords");

// The saved values arrive asynchronously; a field the user already edited
// keeps their input instead of being overwritten by the late read.
const editedFields = new WeakSet();
function trackEdits(...inputs) {
  for (const input of inputs) input.addEventListener("input", () => editedFields.add(input));
}
function fillUnlessEdited(input, value) {
  if (!editedFields.has(input)) input.value = value ?? "";
}
trackEdits(staleDaysInput, reviewKeywordsInput);

async function loadStandupSettings() {
  const { ghsmStaleDays, ghsmReviewKeywords } = await chrome.storage.local.get(["ghsmStaleDays", "ghsmReviewKeywords"]);
  fillUnlessEdited(staleDaysInput, ghsmStaleDays);
  fillUnlessEdited(reviewKeywordsInput, ghsmReviewKeywords);
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
trackEdits(tileMinInput, tileMaxInput);

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
  fillUnlessEdited(tileMinInput, ghmiTileMin);
  fillUnlessEdited(tileMaxInput, ghmiTileMax);
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
  syncSpace();
  const focusEl = target && target !== panel ? target.querySelector("h2, h1") || target : panel.querySelector("h1");
  focusEl.scrollIntoView({ block: "start" });
  focusEl.focus({ preventScroll: true });
}

window.addEventListener("hashchange", route);
route();
// The browser's own fragment handling can run after this module and take the
// focus back, so claim it again once the page has finished loading.
if (document.readyState !== "complete") window.addEventListener("load", route, { once: true });
