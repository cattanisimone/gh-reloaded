// features/html-preview/preview.js — the tab opened by the globe button
// on a PR's "Files changed" page (see content.js). A plain extension
// page, not a content script, so it can talk to the background service
// worker the same way any other feature does, then render the file into
// a sandboxed iframe.

const params = new URLSearchParams(location.search);
const owner = params.get("owner");
const repo = params.get("repo");
const ref = params.get("ref");
const path = params.get("path");

const pathEl = document.getElementById("path");
const sourceLink = document.getElementById("source-link");
const statusEl = document.getElementById("status");
const frame = document.getElementById("frame");

function withBaseHref(html, baseHref) {
  const tag = `<base href="${baseHref.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `${tag}${html}`;
}

function showError(text) {
  statusEl.textContent = text;
  statusEl.className = "ghhp-status is-error";
}

if (!owner || !repo || !ref || !path) {
  showError("Missing file information.");
} else {
  document.title = `Preview — ${path}`;
  pathEl.textContent = `${owner}/${repo} — ${path}`;
  sourceLink.href = `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${path}`;

  chrome.runtime.sendMessage({ type: "GHHP_FETCH_FILE", payload: { owner, repo, ref, path } }, (resp) => {
    if (chrome.runtime.lastError) {
      showError(`Extension error: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (!resp || !resp.ok) {
      if (!resp?.hasToken && [401, 403, 404].includes(resp?.status)) {
        showError(
          "Could not load the file — set a GitHub token in the extension's Settings if this is a private repository."
        );
      } else {
        showError(resp?.error || "Could not load the file.");
      }
      return;
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${dir}`;
    frame.srcdoc = withBaseHref(resp.html, rawBase);
    frame.hidden = false;
    statusEl.remove();
  });
}
