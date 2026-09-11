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

load();
