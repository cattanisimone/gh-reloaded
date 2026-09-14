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
// A user-defined list of {label, url, color} — this feature doesn't know
// or assume anything about any specific repo or project.

const shortcutsContainer = document.getElementById("shortcuts");
const shortcutsStatus = document.getElementById("shortcuts-status");

function setShortcutsStatus(text, kind) {
  shortcutsStatus.textContent = text;
  shortcutsStatus.className = "status " + (kind || "");
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function shortcutRowHtml(s) {
  return `
    <div class="shortcut-row">
      <input type="text" class="sc-label" placeholder="New Request" value="${escapeAttr(s.label || "")}" />
      <input type="url" class="sc-url" placeholder="https://github.com/owner/repo/issues/new/choose" value="${escapeAttr(s.url || "")}" />
      <input type="color" class="sc-color" value="${escapeAttr(s.color || "#1f883d")}" />
      <button type="button" class="sc-remove" title="Remove">×</button>
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
      color: row.querySelector(".sc-color").value,
    }))
    .filter((s) => s.label && s.url);
}

// Event delegation on the container — covers rows added later too, no need
// to re-attach a listener per row.
shortcutsContainer.addEventListener("click", (e) => {
  if (e.target.classList.contains("sc-remove")) {
    e.target.closest(".shortcut-row").remove();
  }
});

document.getElementById("add-shortcut").addEventListener("click", () => {
  shortcutsContainer.insertAdjacentHTML("beforeend", shortcutRowHtml({ color: "#1f883d" }));
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
