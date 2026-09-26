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
// Both reuse the same background fetch (see background/html-preview.js) and
// hand the result off to preview.html/preview.js to actually render — this
// file only ever embeds that page (as its own tab, or as a "bare" inline
// iframe here), it never touches the previewed file's HTML directly. See
// sandbox.js for where and why that content is actually isolated.

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

  // Icon-only controls carry their real label as aria-label (screen
  // readers), a tooltip title, or — increasingly, since GitHub moved
  // several icon buttons (like "More options") to Primer's TooltipV2 —
  // aria-labelledby pointing at a separate visually-hidden span that
  // holds the actual label text. Any of these is a much better anchor
  // than a class name, which is the closest thing to "visible text" an
  // icon-only button otherwise has.
  function accessibleName(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    return (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
  }

  // GitHub commonly keeps a hidden legacy/responsive-breakpoint copy of
  // a control alongside the one actually on screen — accessibleName()
  // alone can't tell them apart, so anything anchored on visible text
  // needs this to avoid also matching the hidden twin.
  function isVisible(el) {
    return !!el.offsetParent;
  }

  function globeIconHtml() {
    return `
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25"></circle>
        <ellipse cx="8" cy="8" rx="2.6" ry="6.25"></ellipse>
        <line x1="1.9" y1="8" x2="14.1" y2="8"></line>
        <line x1="2.7" y1="4.6" x2="13.3" y2="4.6"></line>
        <line x1="2.7" y1="11.4" x2="13.3" y2="11.4"></line>
      </svg>`;
  }

  // `segments` carries the raw, unsplit /blob/<rest> path when the ref
  // itself might contain a slash (branch names like "feature/x" make the
  // ref/path boundary ambiguous from the URL alone — see parseBlobUrl and
  // background/html-preview.js, which does the actual resolving).
  function previewUrl({ owner, repo, ref, path, segments, bare }) {
    const url = new URL(chrome.runtime.getURL("features/html-preview/preview.html"));
    url.searchParams.set("owner", owner);
    url.searchParams.set("repo", repo);
    if (segments) url.searchParams.set("segments", segments.join("/"));
    else {
      url.searchParams.set("ref", ref);
      url.searchParams.set("path", path);
    }
    if (bare) url.searchParams.set("bare", "1");
    return url.toString();
  }

  // --- PR "Files changed" page ---------------------------------------

  // GitHub renamed this tab's route from /files to /changes at some
  // point — accept both since old links/bookmarks can still land on the
  // former before GitHub's own client-side redirect kicks in.
  function isFilesChangedPage() {
    return /\/pull\/\d+\/(files|changes)/.test(location.pathname);
  }

  // Nothing on this page links to a blob anymore, so there's no ref to
  // read either — but the PR header's "<base> wants to merge ... from
  // <head>" line still links each side to its branch's /tree/ root, and
  // that owner/repo/branch is exactly what the Contents API needs as
  // `ref` (a branch name works as well as a commit sha). Reading it from
  // here rather than resolving it through the Pull Requests API also
  // gets forked PRs right for free: the head branch can live in a
  // different repo than the one this page's URL is for.
  function findHeadRepo() {
    const seen = [];
    for (const a of document.querySelectorAll('a[href*="/tree/"]')) {
      const href = a.getAttribute("href");
      if (!seen.includes(href)) seen.push(href);
      if (seen.length >= 2) break;
    }
    const m = seen[1] && /^\/([^/]+)\/([^/]+)\/tree\/(.+)$/.exec(seen[1]);
    return m ? { owner: m[1], repo: m[2], branch: decodeURIComponent(m[3]) } : null;
  }

  // GitHub's redesigned diff viewer no longer links each file's name to
  // its blob (only to an in-page #diff-<hash> anchor), so there's no
  // href left to read a path or ref from. The file's <h3> heading in the
  // header still carries the full path (wrapped in invisible bidi marks
  // GitHub adds around it) — and unlike the "Expand all lines" fallback
  // below, it's there even when the diff itself is collapsed behind a
  // "Large diffs are not rendered by default" placeholder.
  function findFilePath(scope) {
    const code = scope.querySelector('[class*="file-name"] code');
    if (code) {
      const path = code.textContent.replace(/[‎‏]/g, "").trim();
      if (path) return path;
    }
    const btn = Array.from(scope.querySelectorAll("button")).find((el) =>
      /^expand all lines:/i.test(accessibleName(el))
    );
    return btn ? accessibleName(btn).replace(/^expand all lines:\s*/i, "") : null;
  }

  function findCopyNameButton(scope) {
    return Array.from(scope.querySelectorAll("button")).find((el) =>
      /^copy file name to clipboard$/i.test(accessibleName(el))
    );
  }

  function findKebabButtons() {
    return Array.from(document.querySelectorAll("summary, button")).filter(
      (el) => isVisible(el) && /^more options$/i.test(accessibleName(el))
    );
  }

  function injectDiffPreviewButtons() {
    const head = findHeadRepo();

    for (const kebab of findKebabButtons()) {
      const anchor = kebab.closest("details") || kebab;
      const row = anchor.parentElement;
      if (!row) continue;

      // The "Expand all lines" button that carries this file's full path,
      // and the "Copy file name" button our own button anchors next to
      // (see below), usually aren't in the exact same row as the kebab,
      // but are a nearby ancestor — climbing to the whole file
      // header/card finds both without also picking up a sibling file's.
      const scope =
        row.closest('[data-tagsearch-path], [id^="diff-"], .file, .file-header')?.parentElement ||
        row.closest('[data-tagsearch-path], [id^="diff-"], .file, .file-header') ||
        row;

      // The processed marker lives on `scope` rather than on `row`
      // itself: our button gets inserted next to "Copy file name",
      // which — like the "Expand all lines" button above — isn't
      // always inside `row` either, only guaranteed to be somewhere
      // inside this wider `scope`. Marking `row` but then checking for
      // the button under `row` missed it whenever the two diverged,
      // and re-injected a fresh button on every single scan.
      //
      // "skip" means this scope was already confirmed not to be an HTML
      // file — permanent, since that can't change. "done" means a
      // button was already injected for it; still re-checked for the
      // button's actual presence (rather than trusting the marker
      // alone) so a GitHub re-render that wipes our button — without
      // also replacing this scope, which would clear the marker with it
      // — gets it re-injected instead of leaving it silently bare.
      // Anything else (unset, or "done" with the button missing) falls
      // through and gets (re)computed below; the marker itself is only
      // set once that computation actually succeeds, so a scan that
      // runs before the file path or head repo is resolvable leaves it
      // unmarked and retried on the next scan instead of skipped
      // forever.
      if (scope.dataset.ghhpChecked === "skip") continue;
      if (scope.dataset.ghhpChecked === "done" && scope.querySelector(".ghhp-preview-btn")) continue;

      const path = findFilePath(scope);
      if (!path) continue; // not resolvable yet — retry on the next scan
      if (!isHtmlPath(path)) {
        scope.dataset.ghhpChecked = "skip";
        continue;
      }
      if (!head) continue; // couldn't read the head branch yet — retry on the next scan

      const { owner, repo, branch } = head;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghhp-preview-btn";
      btn.title = "Preview rendered HTML";
      btn.setAttribute("aria-label", "Preview rendered HTML");
      btn.innerHTML = globeIconHtml();
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(previewUrl({ owner, repo, ref: branch, path }), "_blank", "noopener");
      });
      // Next to the filename itself, right after "Copy file name to
      // clipboard" — that section spaces its buttons with individual
      // margins rather than a flex gap, so ours carries the matching
      // margin in content.css instead of relying on the parent for it.
      const copyBtn = findCopyNameButton(scope);
      if (copyBtn) copyBtn.insertAdjacentElement("afterend", btn);
      else row.insertBefore(btn, row.firstChild); // fallback: previous spot, before "Viewed"
      scope.dataset.ghhpChecked = "done";
    }
  }

  // --- Single-file blob page ------------------------------------------

  // A branch name can itself contain a slash ("feature/x"), which makes
  // the exact ref/path split genuinely ambiguous from the URL alone —
  // `ref`/`path` below are only a naive first guess (first segment is
  // the ref), good enough for the isHtmlPath check and as a stable
  // per-URL dedup key, but `segments` (the untouched, unsplit list) is
  // what actually goes into the fetch — background/html-preview.js
  // resolves the real split against the Contents API.
  function parseBlobUrl() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (!m) return null;
    const segments = m[3].split("/").map(decodeURIComponent);
    return { owner: m[1], repo: m[2], ref: segments[0], path: segments.slice(1).join("/"), segments };
  }

  // GitHub's own "Code | Preview" toggle for Markdown files is exactly
  // the pattern this mirrors for HTML — found the same way, by the
  // visible name of the tabs rather than a class name that could easily
  // be specific to that toggle's own React component.
  function findCodeBlameTabs() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], a, button'));
    const codes = tabs.filter((el) => isVisible(el) && accessibleName(el).toLowerCase() === "code");
    const blames = tabs.filter((el) => isVisible(el) && accessibleName(el).toLowerCase() === "blame");
    // Anchor on "Blame" first: the repo's own top nav has a "Code" tab too
    // (Code | Issues | Pull requests | ...), so picking the first "Code"
    // match in document order can land on that instead of the blob
    // view's own toggle. "Blame" only exists on the blob view, so walking
    // up from it to the nearest ancestor that also contains a "Code"
    // reliably finds the real pair.
    for (const blame of blames) {
      let container = blame.parentElement;
      while (container) {
        const code = codes.find((el) => container.contains(el));
        if (code) return { container, code, blame };
        container = container.parentElement;
      }
    }
    return null;
  }

  // Our "Preview" list and GitHub's own Code|Blame list are deliberately
  // two separate <ul>s (see injectBlobPreviewTab for why), so the single
  // continuous pill is an illusion: content.css squares off the two
  // corners where they touch, which only reads as one shape if literally
  // nothing sits between them. The toolbar row they share can space its
  // children with a flex `gap` we neither set nor can predict, so measure
  // whatever is actually rendered between the two and pull ours right by
  // exactly that much. Re-measured on every tick rather than once, since
  // a zoom or font-size change moves it and the lists start out 0x0 while
  // the page is still laying out; the correction converges instead of
  // accumulating, because once the gap measures 0 the margin stops
  // changing.
  function joinTabLists(ourList) {
    const realList = ourList && ourList.nextElementSibling;
    if (!realList || realList.tagName !== "UL") return null;
    const gap = realList.getBoundingClientRect().left - ourList.getBoundingClientRect().right;
    if (Math.abs(gap) >= 0.5) {
      const current = parseFloat(ourList.style.marginRight) || 0;
      ourList.style.marginRight = `${current - gap}px`;
    }
    return gap;
  }

  let blobKey = null;

  function injectBlobPreviewTab() {
    const info = parseBlobUrl();
    const key = info ? `${info.owner}/${info.repo}/${info.ref}/${info.path}` : null;

    if (!info || !isHtmlPath(info.path)) {
      blobKey = null;
      // Not a blob route (e.g. the Blame page, or anywhere else) — clean
      // up deterministically instead of relying on whatever re-render
      // this other route happens to do to our injected nodes. Without
      // this, a tab/panel that survives that re-render intact keeps its
      // listeners bound to a now-stale `tabs`/`codeArea` closure from the
      // blob route, which is a worse state than just not being there.
      document.getElementById("ghhp-blob-tab")?.remove();
      document.getElementById("ghhp-blob-panel")?.remove();
      return;
    }

    if (blobKey === key && document.getElementById("ghhp-blob-tab")) {
      joinTabLists(document.getElementById("ghhp-blob-tab").closest("ul.ghhp-tab-list"));
      return; // already rendered
    }
    blobKey = key;

    document.getElementById("ghhp-blob-tab")?.remove();
    document.getElementById("ghhp-blob-panel")?.remove();

    const tabs = findCodeBlameTabs();
    if (!tabs) return; // this redesign doesn't have the Code/Blame tabs this anchors on — no-op

    // Clone Blame's own tab so ours picks up GitHub's exact styling for
    // free, then strip it down to a plain toggle button. Crucially,
    // don't splice it into GitHub's own <ul> as a third <li>: that list
    // is a live React component, and switching to Blame re-renders it —
    // React's reconciliation removes any child it didn't create, so our
    // <li> vanished on Blame and only came back once the poller noticed
    // and re-inserted it on the next tick (confirmed by testing this).
    // A MutationObserver could put it back faster, but only *after* the
    // removal, and the observed re-render replaces the whole <ul> rather
    // than diffing its children — so there'd still be a window with no
    // Preview tab, and we'd be racing React's commit forever. A separate
    // <ul> carrying the real one's own attributes is never part of
    // React's tree at all, and the seam between the two is closed purely
    // in CSS (see joinTabLists above and content.css), which keeps the
    // one-continuous-pill look self-healing: the styling is a sibling
    // selector, so it re-applies on its own even if React swaps the real
    // <ul> for a brand new element.
    const blameItem = tabs.blame.closest("li") || tabs.blame;
    const tabItem = blameItem.cloneNode(true);
    const tab = blameItem === tabs.blame ? tabItem : tabItem.querySelector("button, a, [role='tab']") || tabItem;
    tab.id = "ghhp-blob-tab";
    tab.removeAttribute("href");
    tab.classList.add("ghhp-tab");
    // Inherited from cloning the (unselected, non-first) Blame button —
    // GitHub's own selected-and-first segment uses transparent instead,
    // so this segment doesn't draw a divider against its own edge.
    tab.style.setProperty("--separator-color", "transparent");
    // The label text sits in a nested [data-text] span for GitHub's own
    // Markdown "Preview" tab (confirmed from its real markup) rather
    // than as the button's direct text — updating that node in place
    // instead of the whole button's textContent keeps that structure,
    // in case anything else reads the data-text attribute for styling.
    const textNode = tab.querySelector("[data-text]");
    if (textNode) {
      textNode.textContent = "Preview";
      textNode.setAttribute("data-text", "Preview");
    } else {
      tab.textContent = "Preview";
    }

    const ourList = document.createElement("ul");
    for (const attr of tabs.container.attributes) {
      if (attr.name === "aria-label") continue; // ours says "HTML preview" below, not "File view"
      ourList.setAttribute(attr.name, attr.value);
    }
    ourList.classList.add("ghhp-tab-list");
    ourList.setAttribute("aria-label", "HTML preview");
    ourList.appendChild(tabItem);
    // GitHub's own Markdown "Preview" tab always comes first, before
    // Code and Blame — match that instead of appending after Blame.
    // Being the *immediately* preceding sibling also matters beyond
    // ordering: content.css squares off the real list's left corners
    // through an adjacent-sibling selector.
    tabs.container.insertAdjacentElement("beforebegin", ourList);
    joinTabLists(ourList);

    // The actual code content lives in its own full-width section below
    // the header/toolbar row the tabs sit in (confirmed from GitHub's
    // own Markdown preview markup: a <section class="...BlobContent-
    // module__blobContentSection...">) — inserting our panel next to
    // the header instead put it inside that narrow toolbar's own layout
    // context, rendering as a small stray box instead of a proper
    // full-width pane. Anchoring on this section instead means our
    // panel takes over the same slot, at the same width, that the
    // Code/Blame view already renders in.
    const codeSection = document.querySelector('[class*="BlobContent-module__blobContentSection"]');
    // A full ARIA tabs implementation ties a tab to its panel via
    // aria-controls — kept as a fallback for older markup that doesn't
    // have the section above.
    const codePanelId = tabs.code.getAttribute("aria-controls");
    const codePanel = codePanelId ? document.getElementById(codePanelId) : null;
    const codeArea = codeSection || codePanel;

    // The panel is just a cross-origin iframe onto preview.html (the
    // same page the PR "Files changed" globe button opens as its own
    // tab, in "bare" mode to skip its header bar here) — not a directly
    // injected srcdoc. An <iframe srcdoc> document inherits the CSP of
    // *this* page (github.com's own, which blocks the <base> tag a
    // relative link needs and any inline <script> in the previewed
    // file); a same-extension-origin page has no such inherited CSP.
    // The untrusted file content itself never reaches this page at
    // all — preview.js hands it off again, to the manifest-declared
    // sandbox page in sandbox.js, which is where it's actually isolated.
    const panel = document.createElement("div");
    panel.id = "ghhp-blob-panel";
    panel.className = "ghhp-panel";
    panel.hidden = true;
    // The code section carries its own margin-top to clear the sticky
    // file-header bar above it (confirmed from GitHub's own markup) —
    // our panel takes its place in the same spot when Preview is active,
    // so it needs the same offset, or its top edge sits under that bar.
    if (codeArea) panel.style.marginTop = getComputedStyle(codeArea).marginTop;
    panel.innerHTML = '<iframe class="ghhp-frame" title="HTML preview"></iframe>';
    (codeArea || tabs.container).insertAdjacentElement("afterend", panel);

    const frame = panel.querySelector("iframe");
    let loaded = false;

    // This component marks the active tab with aria-pressed on the
    // button and data-selected on its <li> (confirmed from GitHub's own
    // Markdown "Preview" tab markup) — not aria-selected. Real Code and
    // Blame stay under GitHub's own control (see above); here we also
    // flip their attributes for the visual "selected" state only, since
    // we're the one hiding them — clicking either directly re-selects
    // itself through GitHub's own handler regardless.
    function showPreview() {
      tab.setAttribute("aria-pressed", "true");
      tabItem.setAttribute("data-selected", "");
      tabs.code.setAttribute("aria-pressed", "false");
      tabs.code.closest("li")?.removeAttribute("data-selected");
      tabs.blame.setAttribute("aria-pressed", "false");
      tabs.blame.closest("li")?.removeAttribute("data-selected");
      if (codeArea) codeArea.hidden = true;
      panel.hidden = false;
      if (!loaded) {
        loaded = true;
        frame.src = previewUrl({ owner: info.owner, repo: info.repo, segments: info.segments, bare: true });
      }
    }

    // Takes the tab the user actually clicked (Code or Blame) so it's the
    // one that gets marked selected — showPreview() above always turns
    // both off, so whichever this leaves untouched would otherwise stay
    // stuck looking unselected forever after the first switch back.
    function showNative(activeTab) {
      tab.setAttribute("aria-pressed", "false");
      tabItem.removeAttribute("data-selected");
      activeTab.setAttribute("aria-pressed", "true");
      activeTab.closest("li")?.setAttribute("data-selected", "");
      panel.hidden = true;
      if (codeArea) codeArea.hidden = false;
    }

    tab.addEventListener("click", (e) => {
      e.preventDefault();
      showPreview();
    });
    tabs.code.addEventListener("click", () => {
      if (!panel.hidden) showNative(tabs.code);
    });
    tabs.blame.addEventListener("click", () => {
      if (!panel.hidden) showNative(tabs.blame);
    });

    // Preview is the default landing tab for this file type, same as
    // it is for Markdown — no reason to make the user click through to
    // it every time.
    showPreview();
  }

  // Undoes injectDiffPreviewButtons/injectBlobPreviewTab's DOM changes —
  // called when the feature is switched off from Settings while a
  // matching page is already open, so the injected controls (and their
  // still-live click handlers) don't linger until the next reload.
  function teardown() {
    document.querySelectorAll(".ghhp-preview-btn").forEach((btn) => {
      delete btn.closest('[data-ghhp-checked="done"]')?.dataset.ghhpChecked;
      btn.remove();
    });
    document.getElementById("ghhp-blob-tab")?.remove();
    document.getElementById("ghhp-blob-panel")?.remove();
    blobKey = null;
  }

  async function sync() {
    if (!extensionAlive()) return;
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    if (enabled === false) {
      teardown();
      return;
    }

    if (isFilesChangedPage()) {
      injectDiffPreviewButtons();
    }
    injectBlobPreviewTab();
  }

  // Re-run on GitHub's SPA navigations. Diffs and file lists on the
  // "Files changed" page can also load progressively without a URL
  // change (pagination, "Load diff"), so the polling fallback re-scans
  // on every tick, not just on a URL change — cheap since
  // injectDiffPreviewButtons/injectBlobPreviewTab both skip work that's
  // already done.
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
