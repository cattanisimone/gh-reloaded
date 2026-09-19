// features/html-preview/content.js — renders HTML files instead of
// leaving them as plain source:
//
//  - On a pull request's "Files changed" page, a globe button next to
//    each HTML file's "..." (More options) menu opens the rendered file
//    in a new tab.
//  - On a single file's blob page, a "Preview" tab next to Code/Blame
//    renders the file inline, the same way GitHub already does for
//    Markdown.
//
// Both reuse the same background fetch (see background/html-preview.js)
// and render into a sandboxed iframe: `sandbox="allow-scripts"` with no
// `allow-same-origin` gives the frame a unique opaque origin per the
// HTML spec, so even a file that runs its own JS can't reach github.com's
// cookies or DOM — the same trick sites like htmlpreview.github.io use.

(function () {
  const STORAGE_KEY = "ghhpEnabled";

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function isHtmlPath(path) {
    return /\.html?$/i.test(path || "");
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  // Icon-only controls carry their real label as aria-label (screen
  // readers) or a tooltip title — either is a much better anchor than a
  // class name, which is the closest thing to "visible text" an
  // icon-only button has.
  function accessibleName(el) {
    return (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
  }

  function globeIconHtml() {
    return `
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25"></circle>
        <ellipse cx="8" cy="8" rx="2.6" ry="6.25"></ellipse>
        <line x1="1.9" y1="8" x2="14.1" y2="8"></line>
        <line x1="2.7" y1="4.6" x2="13.3" y2="4.6"></line>
        <line x1="2.7" y1="11.4" x2="13.3" y2="11.4"></line>
      </svg>`;
  }

  function previewUrl({ owner, repo, ref, path }) {
    const url = new URL(chrome.runtime.getURL("features/html-preview/preview.html"));
    url.searchParams.set("owner", owner);
    url.searchParams.set("repo", repo);
    url.searchParams.set("ref", ref);
    url.searchParams.set("path", path);
    return url.toString();
  }

  function parseRepoFromPath() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\//);
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  function withBaseHref(html, baseHref) {
    const tag = `<base href="${escapeAttr(baseHref)}">`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
    return `${tag}${html}`;
  }

  function rawBaseFor(owner, repo, ref, path) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${dir}`;
  }

  function loadPreviewInto(frame, info, onSettled) {
    chrome.runtime.sendMessage({ type: "GHHP_FETCH_FILE", payload: info }, (resp) => {
      if (!extensionAlive() || !document.contains(frame)) return; // stale by the time this returns
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        const msg = chrome.runtime.lastError?.message || resp?.error || "Could not load the file.";
        frame.srcdoc = `<p style="font:13px -apple-system,sans-serif;color:#cf222e;padding:16px">${escapeHtml(msg)}</p>`;
      } else {
        frame.srcdoc = withBaseHref(resp.html, rawBaseFor(info.owner, info.repo, info.ref, info.path));
      }
      frame.hidden = false;
      onSettled?.();
    });
  }

  // --- PR "Files changed" page ---------------------------------------

  function isFilesChangedPage() {
    return /\/pull\/\d+\/files/.test(location.pathname);
  }

  function findBlobLink(scope, owner, repo) {
    const re = new RegExp(`^/${owner}/${repo}/blob/([^/]+)/(.+)$`, "i");
    for (const a of scope.querySelectorAll("a[href]")) {
      const href = (a.getAttribute("href") || "").split("?")[0].split("#")[0];
      const m = re.exec(href);
      if (m) return { ref: m[1], path: decodeURIComponent(m[2]) };
    }
    return null;
  }

  function findKebabButtons() {
    return Array.from(document.querySelectorAll("summary, button")).filter((el) =>
      /^more options$/i.test(accessibleName(el))
    );
  }

  const processedKebabs = new WeakSet();

  function injectDiffPreviewButtons({ owner, repo }) {
    for (const kebab of findKebabButtons()) {
      if (processedKebabs.has(kebab)) continue;
      processedKebabs.add(kebab);

      const anchor = kebab.closest("details") || kebab;
      const row = anchor.parentElement;
      if (!row) continue;
      // The filename link (or a dedicated "View file" icon) that points
      // at this file's blob at the diff's head commit usually isn't in
      // the exact same row as the kebab, but it is a nearby ancestor —
      // climbing to the whole file header/card is enough to find it
      // without also picking up a sibling file's link.
      const scope =
        row.closest('[data-tagsearch-path], [id^="diff-"], .file, .file-header')?.parentElement ||
        row.closest('[data-tagsearch-path], [id^="diff-"], .file, .file-header') ||
        row;
      const blob = findBlobLink(scope, owner, repo);
      if (!blob || !isHtmlPath(blob.path)) continue;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghhp-preview-btn";
      btn.title = "Preview rendered HTML";
      btn.setAttribute("aria-label", "Preview rendered HTML");
      btn.innerHTML = globeIconHtml();
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(previewUrl({ owner, repo, ...blob }), "_blank", "noopener");
      });
      row.insertBefore(btn, anchor);
    }
  }

  // --- Single-file blob page ------------------------------------------

  function parseBlobUrl() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], ref: decodeURIComponent(m[3]), path: decodeURIComponent(m[4]) };
  }

  // GitHub's own "Code | Preview" toggle for Markdown files is exactly
  // the pattern this mirrors for HTML — found the same way, by the
  // visible name of the tabs rather than a class name that could easily
  // be specific to that toggle's own React component.
  function findCodeBlameTabs() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], a, button'));
    const code = tabs.find((el) => accessibleName(el).toLowerCase() === "code");
    const blame = tabs.find((el) => accessibleName(el).toLowerCase() === "blame");
    if (!code || !blame) return null;
    let container = code.parentElement;
    while (container && !container.contains(blame)) container = container.parentElement;
    return container ? { container, code, blame } : null;
  }

  let blobKey = null;

  function injectBlobPreviewTab() {
    const info = parseBlobUrl();
    const key = info ? `${info.owner}/${info.repo}/${info.ref}/${info.path}` : null;

    if (!info || !isHtmlPath(info.path)) {
      blobKey = null;
      return;
    }
    if (blobKey === key && document.getElementById("ghhp-blob-tab")) return; // already rendered
    blobKey = key;

    document.getElementById("ghhp-blob-tab")?.remove();
    document.getElementById("ghhp-blob-panel")?.remove();

    const tabs = findCodeBlameTabs();
    if (!tabs) return; // this redesign doesn't have the Code/Blame tabs this anchors on — no-op

    // Clone Blame's own tab so ours picks up GitHub's exact styling for
    // free, then strip it down to a plain toggle button.
    const tab = tabs.blame.cloneNode(true);
    tab.id = "ghhp-blob-tab";
    tab.removeAttribute("href");
    tab.classList.add("ghhp-tab");
    tab.setAttribute("aria-selected", "false");
    tab.textContent = "Preview";
    tabs.blame.insertAdjacentElement("afterend", tab);

    // A full ARIA tabs implementation ties a tab to its panel via
    // aria-controls — when present, this lets Preview swap the actual
    // code panel out instead of just stacking a second copy below it.
    const codePanelId = tabs.code.getAttribute("aria-controls");
    const codePanel = codePanelId ? document.getElementById(codePanelId) : null;

    const panel = document.createElement("div");
    panel.id = "ghhp-blob-panel";
    panel.className = "ghhp-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="ghhp-panel-status">Loading preview…</div>' +
      '<iframe class="ghhp-frame" sandbox="allow-scripts" title="HTML preview" hidden></iframe>';
    (codePanel || tabs.container).insertAdjacentElement("afterend", panel);

    const frame = panel.querySelector("iframe");
    const statusEl = panel.querySelector(".ghhp-panel-status");
    let loaded = false;

    function showPreview() {
      tab.setAttribute("aria-selected", "true");
      tabs.code.setAttribute("aria-selected", "false");
      if (codePanel) codePanel.hidden = true;
      panel.hidden = false;
      if (!loaded) {
        loaded = true;
        loadPreviewInto(frame, info, () => statusEl.remove());
      }
    }

    function showCode() {
      tab.setAttribute("aria-selected", "false");
      panel.hidden = true;
      if (codePanel) codePanel.hidden = false;
    }

    tab.addEventListener("click", (e) => {
      e.preventDefault();
      showPreview();
    });
    tabs.code.addEventListener("click", () => {
      if (!panel.hidden) showCode();
    });
  }

  async function sync() {
    if (!extensionAlive()) return;
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    if (enabled === false) return;

    if (isFilesChangedPage()) {
      const repoInfo = parseRepoFromPath();
      if (repoInfo) injectDiffPreviewButtons(repoInfo);
    }
    injectBlobPreviewTab();
  }

  // Re-run on GitHub's SPA navigations. Diffs and file lists on the
  // "Files changed" page can also load progressively without a URL
  // change (pagination, "Load diff"), so the polling fallback re-scans
  // on every tick, not just on a URL change, same as loadPreviewInto's
  // callers expect — cheap since injectDiffPreviewButtons/
  // injectBlobPreviewTab both skip work that's already done.
  const debouncedSync = debounce(sync, 200);
  document.addEventListener("turbo:load", debouncedSync);
  document.addEventListener("turbo:render", debouncedSync);
  document.addEventListener("pjax:end", debouncedSync);

  chrome.storage.onChanged.addListener((changes) => {
    if (extensionAlive() && changes[STORAGE_KEY]) debouncedSync();
  });

  let lastUrl = location.href;
  setInterval(() => {
    if (!extensionAlive()) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      debouncedSync();
    } else {
      sync();
    }
  }, 800);

  sync();
})();
