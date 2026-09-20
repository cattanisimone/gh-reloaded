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
// A branch name can itself contain a slash ("feature/x"), which makes a
// GitHub blob URL genuinely ambiguous about where the ref ends and the
// path begins. The caller passes the raw, unsplit segments instead of a
// pre-split ref/path in that case, and the background worker resolves
// the real split against the Contents API (see background/html-preview.js).
const segments = params.get("segments");
// Embedded inline in a GitHub page (the blob-page Preview tab) instead
// of opened as its own tab — this page's own header bar would just
// duplicate GitHub's file header/tabs there, so hide it.
if (params.get("bare") === "1") document.body.classList.add("ghhp-bare");

const pathEl = document.getElementById("path");
const repoLink = document.getElementById("repo-link");
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

function updateChrome(ref, path) {
  document.title = `Preview — ${path}`;
  repoLink.textContent = `${owner}/${repo}`;
  repoLink.href = `https://github.com/${owner}/${repo}`;
  pathEl.textContent = path;
  pathEl.title = path;
  sourceLink.href = `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${path}`;
}

if (!owner || !repo || (!segments && (!ref || !path))) {
  showError("Missing file information.");
} else {
  if (!segments) updateChrome(ref, path);

  const payload = segments ? { owner, repo, segments: segments.split("/") } : { owner, repo, ref, path };
  chrome.runtime.sendMessage({ type: "GHHP_FETCH_FILE", payload }, (resp) => {
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
    // In segments mode, the ref/path used above for display were never
    // known until the background worker resolved them just now.
    const realRef = resp.ref ?? ref;
    const realPath = resp.path ?? path;
    if (segments) updateChrome(realRef, realPath);
    const dir = realPath.includes("/") ? realPath.slice(0, realPath.lastIndexOf("/") + 1) : "";
    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${realRef}/${dir}`;
    const html = withBaseHref(resp.html, rawBase);
    // Not frame.srcdoc: that would make this document — an ordinary
    // extension page, bound by MV3's fixed `script-src 'self'`
    // extension_pages CSP — the parent whose CSP the srcdoc document
    // inherits, blocking any inline <script> in the previewed file (and
    // the <base> tag above). Handing it to the sandbox page instead
    // (see sandbox.js) gets it a separate, permissive-by-default CSP.
    frame.addEventListener(
      "load",
      () => frame.contentWindow.postMessage({ html }, "*"),
      { once: true }
    );
    frame.src = chrome.runtime.getURL("features/html-preview/sandbox.html");
    frame.hidden = false;
    statusEl.remove();
  });
}
