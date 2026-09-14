const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status " + (kind || "");
}

async function load() {
  const { githubToken } = await chrome.storage.local.get("githubToken");
  if (githubToken) {
    tokenInput.value = githubToken;
    setStatus(`Token saved (ends in …${githubToken.slice(-4)}).`, "ok");
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const value = tokenInput.value.trim();
  if (!value) {
    setStatus("Enter a token first.", "error");
    return;
  }
  await chrome.storage.local.set({ githubToken: value });
  setStatus("Token saved.", "ok");
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.remove("githubToken");
  tokenInput.value = "";
  setStatus("Token removed.", "ok");
});

document.getElementById("test").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Enter a token first.", "error");
    return;
  }
  setStatus("Testing…", "");
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      setStatus(`Token rejected (HTTP ${res.status}).`, "error");
      return;
    }
    const user = await res.json();
    setStatus(`OK — authenticated as ${user.login}.`, "ok");
  } catch (e) {
    setStatus(`Network error: ${e.message}`, "error");
  }
});

// --- Quick-create shortcuts ---
// A user-defined list of {label, url, project, color} — this feature
// doesn't know or assume anything about any specific repo or project.
// `project` is optional: blank means "show on every board"; set means
// "only on this one" (owner/number, matching the board's own URL).

const SWATCHES = ["#1f883d", "#0969da", "#8250df", "#bf3989", "#cf222e", "#bc4c00", "#9a6700", "#57606a"];

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

function shortcutRowHtml(s) {
  return `
    <div class="shortcut-row">
      <div class="shortcut-row-main">
        <input type="text" class="sc-label" placeholder="New Request" value="${escapeAttr(s.label || "")}" />
        <input type="url" class="sc-url" placeholder="https://github.com/owner/repo/issues/new/choose" value="${escapeAttr(s.url || "")}" />
        <button type="button" class="sc-remove" title="Remove">×</button>
      </div>
      <div class="shortcut-row-sub">
        <input type="text" class="sc-project" placeholder="owner/number — optional, e.g. my-org/12 (blank = every board)" value="${escapeAttr(s.project || "")}" />
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
  }
});

document.getElementById("add-shortcut").addEventListener("click", () => {
  shortcutsContainer.insertAdjacentHTML("beforeend", shortcutRowHtml({ color: SWATCHES[0] }));
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

load();
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
