// features/my-issues/content.js — on GitHub's own "My Issues" dashboard
// (github.com/issues), adds a "Group by project" control next to the native
// flat list. Switched on, it replaces the list with the same issues as a
// grid of Project tiles, each listing its issues by that Project's real
// Status; switched off, GitHub's own list is restored untouched. It also
// makes the dashboard's left sidebar collapsible to an icon rail.
//
// It never reads the grouped data off the page (the dashboard only renders
// a virtualized slice of the real result set) — it asks the background to
// run the dashboard's current search through the API and group the COMPLETE
// paginated set. The native search box, filters, and saved views stay in
// place and usable: changing any of them updates the dashboard's URL query,
// which this script notices and re-fetches against, so the groups always
// agree with the list. The view is read-only — it only links out to issues.

(function () {
  const ROOT_ID = "ghmi-root";
  const STORAGE_ENABLED = "ghmiEnabled";
  const STORAGE_VIEW = "ghmiView"; // "list" | "grouped"
  const STORAGE_SIDEBAR = "ghmiSidebar"; // "collapsed" (default) | "expanded"
  const MESSAGE_TYPE_GROUPS = "GHMI_FETCH_GROUPS"; // matches background/my-issues.js

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  const L = globalThis.GHMI_LAYOUT; // features/my-issues/layout.js, loaded first

  // Issues shown per Status before "Show N more". A constant, not a setting.
  const STATUS_CAP = 5;

  function isMyIssuesPage() {
    return /^\/issues(\/|$)/.test(location.pathname);
  }

  // The dashboard's result set is driven by TWO things: the `q` search box
  // and, when there's no `q`, the path-based tab. GitHub's My Issues tabs —
  // /issues or /issues/assigned (assigned to me), /issues/created (opened by
  // me), /issues/mentioned (mentioning me) — each carry their own implicit
  // query with no `q` in the URL. Deriving only from `q` would make every
  // tab fall back to the assigned default, so the grouped view would show
  // assigned issues while the native page shows, say, created ones. Map the
  // route to its query so the two agree. (State is left to the group fetch's
  // own default — the dashboard shows open issues by default.)
  const ROUTE_QUERY = {
    assigned: "assignee:@me is:open",
    created: "author:@me is:open",
    mentioned: "mentions:@me is:open",
  };

  function routeQuery() {
    const seg = /^\/issues(?:\/([^/?#]+))?/.exec(location.pathname)?.[1];
    return ROUTE_QUERY[seg] || ROUTE_QUERY.assigned;
  }

  // An explicit `q` (the search box, a filter, a saved view) wins over the
  // tab's implicit query, exactly as the native page resolves it.
  function currentQuery() {
    const q = new URLSearchParams(location.search).get("q");
    return q && q.trim() ? q : routeQuery();
  }

  // Same pastel Status pill colors the dependency-graph feature uses, so a
  // status reads identically wherever the extension shows it. Colors arrive
  // as e.g. "BLUE"/"blue" from the API — upper-cased before lookup.
  const STATUS_PALETTE = {
    light: {
      GRAY: { fg: "#6e7781", bg: "#eef0f2" },
      BLUE: { fg: "#1f6feb", bg: "#ddf4ff" },
      GREEN: { fg: "#2da44e", bg: "#dafbe1" },
      YELLOW: { fg: "#d4a72c", bg: "#fff8c5" },
      ORANGE: { fg: "#e16f24", bg: "#fff1e5" },
      RED: { fg: "#d1242f", bg: "#ffebe9" },
      PINK: { fg: "#c66eaf", bg: "#ffeff7" },
      PURPLE: { fg: "#8250df", bg: "#fbefff" },
    },
    dark: {
      GRAY: { fg: "#9198a1", bg: "rgba(145,152,161,.16)" },
      BLUE: { fg: "#4493f8", bg: "rgba(68,147,248,.16)" },
      GREEN: { fg: "#57ab5a", bg: "rgba(87,171,90,.16)" },
      YELLOW: { fg: "#daaa3f", bg: "rgba(218,170,63,.18)" },
      ORANGE: { fg: "#e0823d", bg: "rgba(224,130,61,.16)" },
      RED: { fg: "#e5534b", bg: "rgba(229,83,75,.16)" },
      PINK: { fg: "#e078b3", bg: "rgba(224,120,179,.16)" },
      PURPLE: { fg: "#a371f7", bg: "rgba(163,113,247,.16)" },
    },
  };

  function paletteFor(colorName, theme) {
    const t = STATUS_PALETTE[theme] || STATUS_PALETTE.light;
    return t[(colorName || "GRAY").toUpperCase()] || t.GRAY;
  }

  function githubTheme() {
    const mode = document.documentElement.getAttribute("data-color-mode");
    if (mode === "dark") return "dark";
    if (mode === "light") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const ISSUE_HREF_RE = /^\/[^/]+\/[^/]+\/issues\/\d+(?:[/?#]|$)/;
  const SEARCH_SELECTOR =
    'input[type="search"], [role="searchbox"], input[aria-label*="earch" i], input[placeholder*="earch" i]';

  function findSearchBox(main) {
    return main.querySelector(SEARCH_SELECTOR);
  }

  // Finds where to splice the grouped view in. The native results are the
  // block of the page that holds links to individual issues; anchoring on
  // that (visible content, per the project's "anchor on text, not
  // selectors" rule) is sturdier than any class name on this redesign-prone
  // page. The chosen block is the largest ancestor of the first results row
  // that does NOT also contain the search box, so mounting right before it
  // (and hiding only it while grouped) leaves the search/filter chrome above
  // visible and usable. Links inside the page's nav/header chrome
  // (breadcrumbs, tabs) are skipped so a stray issue link there can't be
  // mistaken for a results row. With no rows on the page (an empty result
  // set), there's nothing to anchor to — fall back to appending into <main>.
  function findMount() {
    const main = document.querySelector("main") || document.body;
    const searchEl = findSearchBox(main);
    let rowLink = null;
    for (const a of main.querySelectorAll("a[href]")) {
      if (a.closest("nav, header, [role='search'], [role='banner']")) continue;
      let path;
      try {
        path = new URL(a.href, location.origin).pathname;
      } catch {
        continue;
      }
      if (ISSUE_HREF_RE.test(path)) {
        rowLink = a;
        break;
      }
    }
    if (!rowLink) return { parent: main, before: null };
    let el = rowLink;
    while (
      el.parentElement &&
      el.parentElement !== main &&
      !(searchEl && el.parentElement.contains(searchEl))
    ) {
      el = el.parentElement;
    }
    return { parent: el.parentElement || main, before: el };
  }

  const ICON_OPEN =
    '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"></path>';
  const ICON_CLOSED =
    '<path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"></path><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"></path>';

  function toolbarHtml() {
    return `
      <div class="ghmi-toolbar" role="group" aria-label="My Issues view">
        <span class="ghmi-summary" aria-live="polite"></span>
        <span class="ghmi-actions">
          <span class="ghmi-bulk" hidden>
            <button type="button" class="ghmi-link-btn" data-bulk="expand">Expand all</button>
            <span aria-hidden="true">·</span>
            <button type="button" class="ghmi-link-btn" data-bulk="collapse">Collapse all</button>
          </span>
          <svg class="ghmi-glyph" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" role="img" aria-label="GH Reloaded">
            <title>GH Reloaded</title>
            <path d="M1.75 1h3.5A1.75 1.75 0 0 1 7 2.75v3.5A1.75 1.75 0 0 1 5.25 8h-3.5A1.75 1.75 0 0 1 0 6.25v-3.5C0 1.784.784 1 1.75 1Zm9 0h3.5A1.75 1.75 0 0 1 16 2.75v3.5A1.75 1.75 0 0 1 14.25 8h-3.5A1.75 1.75 0 0 1 9 6.25v-3.5C9 1.784 9.784 1 10.75 1ZM1.75 9h3.5A1.75 1.75 0 0 1 7 10.75v3.5A1.75 1.75 0 0 1 5.25 16h-3.5A1.75 1.75 0 0 1 0 14.25v-3.5C0 9.784.784 9 1.75 9Zm9 0h3.5A1.75 1.75 0 0 1 16 10.75v3.5A1.75 1.75 0 0 1 14.25 16h-3.5A1.75 1.75 0 0 1 9 14.25v-3.5C9 9.784 9.784 9 10.75 9Z"></path>
          </svg>
          <span class="ghmi-seg" role="tablist">
            <button type="button" class="ghmi-seg-btn" data-view="list" role="tab">List</button>
            <button type="button" class="ghmi-seg-btn" data-view="grouped" role="tab">Group by project</button>
          </span>
        </span>
      </div>
      <div class="ghmi-panel" hidden></div>`;
  }

  // Mounts (or re-mounts, if GitHub's SPA re-rendered the list and dropped
  // our node) the toolbar + grouped panel immediately before the native
  // results block. The parent is tagged so CSS can hide the results that
  // follow our root while grouped, leaving everything above (search,
  // filters, tabs) visible and working.
  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root && document.contains(root)) return root;

    const { parent, before } = findMount();
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "ghmi-root";
    root.dataset.theme = githubTheme();
    root.innerHTML = toolbarHtml();
    // Mounted on the fallback (no result rows rendered yet): remembered so
    // the poll can move it once the rows arrive.
    if (!before) root.dataset.fallback = "1";
    parent.insertBefore(root, before);

    root.querySelectorAll(".ghmi-seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        chrome.storage.local.set({ [STORAGE_VIEW]: btn.dataset.view });
      });
    });
    root.querySelectorAll("[data-bulk]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const open = btn.dataset.bulk === "expand";
        root.querySelectorAll(".ghmi-tile").forEach((d) => {
          d.open = open;
          if (open) collapsedTiles.delete(d.dataset.key);
          else collapsedTiles.add(d.dataset.key);
        });
      });
    });
    return root;
  }

  // The native results are whatever follows our root in the same container;
  // hide exactly those while grouped, but never the block holding the search
  // box (it may be a following sibling in some layouts) so filters stay
  // usable and keep driving the grouped view.
  function applyView(root, view) {
    const grouped = view === "grouped";
    root.querySelectorAll(".ghmi-seg-btn").forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    root.querySelector(".ghmi-panel").hidden = !grouped;
    root.dataset.view = view;
    updateToolbar(root);

    const main = document.querySelector("main") || document.body;
    const searchEl = findSearchBox(main);
    for (let sib = root.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const keep = searchEl && sib.contains(searchEl);
      if (grouped && !keep) sib.setAttribute("data-ghmi-hidden", "");
      else sib.removeAttribute("data-ghmi-hidden");
    }
  }

  // The summary and Expand/Collapse all belong to the grouped view with
  // results on screen; in List view, or while a message is showing, the
  // toolbar is just the switch.
  function updateToolbar(root) {
    const panel = root.querySelector(".ghmi-panel");
    const showing = root.dataset.view === "grouped" && panel.dataset.state === "done" && !!panel.querySelector(".ghmi-tile");
    root.querySelector(".ghmi-bulk").hidden = !showing;
    root.querySelector(".ghmi-summary").textContent = showing ? root.dataset.summary || "" : "";
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  // Tile and Status state kept in memory only: it survives our node being
  // re-mounted, never a page reload.
  const collapsedTiles = new Set();
  const expandedStatuses = new Set();

  function issueIconSvg(closed) {
    return `<svg class="ghmi-row-icon-svg ${closed ? "is-closed" : "is-open"}" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">${closed ? ICON_CLOSED : ICON_OPEN}</svg>`;
  }

  function absoluteDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
  }

  function rowHtml(issue, labels) {
    const full = issue.nameWithOwner || "";
    const label = labels.get(full) ?? full;
    const ago = L.relativeTime(issue.updatedAt);
    const title = escapeHtml(issue.title || "");
    const time = ago
      ? `<time class="ghmi-row-time" datetime="${escapeHtml(issue.updatedAt)}" title="${escapeHtml(absoluteDate(issue.updatedAt))}">${ago}</time>`
      : "";
    return `
      <li class="ghmi-row">
        <span class="ghmi-row-icon">${issueIconSvg(issue.state === "CLOSED")}</span>
        <a class="ghmi-row-title" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener" title="${title}">${title}</a>
        <span class="ghmi-row-ref" title="${escapeHtml(full)}#${issue.number}">${escapeHtml(label)}#${issue.number}</span>
        ${time}
      </li>`;
  }

  // One capped list of rows, with its "Show N more" button.
  function rowsHtml(issues, labels, key) {
    const { visible, hidden } = L.capStatus(issues, STATUS_CAP, expandedStatuses.has(key));
    const more = hidden
      ? `<button type="button" class="ghmi-more" data-key="${escapeHtml(key)}" aria-expanded="false">Show ${hidden} more</button>`
      : "";
    return `<ul class="ghmi-rows" data-rows-key="${escapeHtml(key)}">${visible.map((i) => rowHtml(i, labels)).join("")}</ul>${more}`;
  }

  function statusGroupHtml(status, projectKey, labels, theme) {
    const name = status.name || "No Status";
    const p = paletteFor(status.color, theme);
    const pill = status.name
      ? `style="color:${p.fg}; background:${p.bg}; border-color:${p.fg}"`
      : `class="is-none"`;
    return `
      <section class="ghmi-status">
        <div class="ghmi-gutter">
          <span class="ghmi-status-name" ${pill}>${escapeHtml(name)}</span>
          <span class="ghmi-status-count">${status.issues.length}</span>
        </div>
        <div class="ghmi-status-rows">${rowsHtml(status.issues, labels, `${projectKey}|${status.optionId || status.name || "none"}`)}</div>
      </section>`;
  }

  function legendText(segs) {
    return segs.map((s) => `${s.count} ${s.name || "No Status"}`).join(" · ");
  }

  function distHtml(segs, theme) {
    const text = legendText(segs);
    const bars = segs
      .map((s) => {
        const color = s.name ? paletteFor(s.color, theme).fg : paletteFor("GRAY", theme).fg;
        return `<span class="ghmi-dist-seg" style="width:${s.width}%; background:${color}"></span>`;
      })
      .join("");
    return `
      <div class="ghmi-dist" role="img" aria-label="${escapeHtml(text)}">${bars}</div>
      <div class="ghmi-legend">${escapeHtml(text)}</div>`;
  }

  function tileHtml({ key, titleHtml, count, url, segs, bodyHtml, theme }) {
    const open = collapsedTiles.has(key) ? "" : " open";
    const openLink = url
      ? `<a class="ghmi-open-project" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open project ↗</a>`
      : "";
    return `
      <details class="ghmi-tile" data-key="${escapeHtml(key)}"${open}>
        <summary>
          <span class="ghmi-tile-head">
            ${titleHtml}
            <span class="ghmi-count">${count}</span>
            ${openLink}
          </span>
          ${distHtml(segs, theme)}
        </summary>
        <div class="ghmi-tile-body">${bodyHtml}</div>
      </details>`;
  }

  function projectTileHtml(project, labels, theme) {
    const title = escapeHtml(project.title || "Untitled project");
    const titleHtml = project.url
      ? `<a class="ghmi-tile-title" href="${escapeHtml(project.url)}" target="_blank" rel="noopener">${title}</a>`
      : `<span class="ghmi-tile-title">${title}</span>`;
    const key = `p:${project.id || project.title}`;
    const segs = L.barSegments(
      project.statuses.map((s) => ({ name: s.name, color: s.color, count: s.issues.length }))
    );
    return tileHtml({
      key,
      titleHtml,
      count: project.count,
      url: project.url,
      segs,
      theme,
      bodyHtml: project.statuses.map((s) => statusGroupHtml(s, key, labels, theme)).join(""),
    });
  }

  function noProjectTileHtml(issues, labels, theme) {
    const key = "none";
    return tileHtml({
      key,
      titleHtml: `<span class="ghmi-tile-title">No Project</span>`,
      count: issues.length,
      segs: [{ name: "No Project", count: issues.length, color: "GRAY", width: 100 }],
      theme,
      bodyHtml: rowsHtml(issues, labels, key),
    });
  }

  function renderMessage(panel, text, kind) {
    panel.innerHTML = "";
    const box = document.createElement("div");
    box.className = "ghmi-message";
    box.textContent = text;
    if (kind === "locked") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghmi-btn";
      btn.textContent = "Open settings";
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      box.appendChild(document.createElement("br"));
      box.appendChild(btn);
    }
    panel.appendChild(box);
  }

  function renderGroups(root, data, theme) {
    const panel = root.querySelector(".ghmi-panel");
    const { projects = [], noProject = [], totalCount = 0, fetchedCount = 0, truncated } = data;
    if (!projects.length && !noProject.length) {
      renderMessage(panel, "No issues match this search.");
      return;
    }

    const all = projects.flatMap((p) => p.statuses.flatMap((s) => s.issues)).concat(noProject);
    const labels = L.repoLabels(all);
    panel.innerHTML =
      `<div class="ghmi-grid">` +
      projects.map((p) => projectTileHtml(p, labels, theme)).join("") +
      (noProject.length ? noProjectTileHtml(noProject, labels, theme) : "") +
      `</div>`;
    panel.dataset.state = "done";

    const distinct = L.distinctCount(projects, noProject);
    root.dataset.summary = truncated
      ? `Showing the first ${fetchedCount} of ${totalCount} issues. Narrow the search to see all.`
      : projects.length
        ? `${plural(distinct, "issue")} in ${plural(projects.length, "project")}`
        : plural(distinct, "issue");
    updateToolbar(root);
  }

  // In-memory UI state, wired once on the panel (a re-render replaces its
  // contents, not the panel itself).
  function wirePanel(panel) {
    if (panel.dataset.wired) return;
    panel.dataset.wired = "1";
    panel.addEventListener("toggle", (e) => {
      const d = e.target;
      if (!d.classList?.contains("ghmi-tile")) return;
      if (d.open) collapsedTiles.delete(d.dataset.key);
      else collapsedTiles.add(d.dataset.key);
    }, true);
    panel.addEventListener("click", (e) => {
      const more = e.target.closest?.(".ghmi-more");
      if (more) {
        expandedStatuses.add(more.dataset.key);
        // Re-render in place from the cached data; the expanded set and the
        // collapsed tiles are replayed by the render.
        const root = document.getElementById(ROOT_ID);
        if (root && lastResult) renderGroups(root, lastResult.data, root.dataset.theme || githubTheme());
        // The button is gone after the re-render: keep keyboard focus on the
        // first row it revealed instead of dropping it to <body>.
        const list = [...panel.querySelectorAll("[data-rows-key]")].find((u) => u.dataset.rowsKey === more.dataset.key);
        list?.querySelectorAll(".ghmi-row-title")[STATUS_CAP]?.focus();
        return;
      }
      // Links inside a <summary> must navigate, not toggle the tile.
      if (e.target.closest?.("summary a")) e.stopPropagation();
    });
  }

  // The last successful response, so a re-mounted panel (GitHub re-rendered
  // the page) for the SAME query repaints without another round of API
  // calls. It expires, so coming back to the dashboard later refetches.
  const RESULT_TTL_MS = 60_000;
  let lastResult = null; // { query, data, at }

  // Keyed by the query we last rendered for, so a repeated sync() (SPA
  // re-render, interval tick) doesn't re-fetch for a query already on
  // screen; a genuinely changed query (search/filter/saved-view edit)
  // clears it and re-fetches.
  let rendered = { query: null };

  function fetchAndRender(root) {
    const panel = root.querySelector(".ghmi-panel");
    wirePanel(panel);
    const query = currentQuery();
    // Already showing (or already fetching) this exact query on this panel —
    // don't stack a second request.
    if (rendered.query === query && (panel.dataset.state === "done" || panel.dataset.state === "loading")) {
      return;
    }
    const theme = root.dataset.theme || githubTheme();

    if (lastResult && lastResult.query === query && Date.now() - lastResult.at < RESULT_TTL_MS) {
      rendered = { query };
      renderGroups(root, lastResult.data, theme);
      panel.dataset.state = "done";
      updateToolbar(root);
      return;
    }

    rendered = { query };
    panel.dataset.state = "loading";
    renderMessage(panel, "Loading issues…");
    updateToolbar(root);

    chrome.runtime.sendMessage({ type: MESSAGE_TYPE_GROUPS, payload: { query } }, (resp) => {
      if (!document.contains(panel) || rendered.query !== query) return; // stale
      const fail = (text, kind) => {
        renderMessage(panel, text, kind);
        panel.dataset.state = "error";
        rendered = { query: null }; // allow a retry on the next sync
        updateToolbar(root);
      };
      if (chrome.runtime.lastError) {
        fail(`Couldn't load issues: ${chrome.runtime.lastError.message}. Switch to List for the native view.`);
        return;
      }
      if (!resp || !resp.ok) {
        const status = resp?.status;
        if (status === 401 || status === 403 || !resp?.hasToken) {
          fail("Add a GitHub token to group issues by project.", "locked");
        } else {
          fail(`Couldn't load issues: ${resp?.error || "unknown error"}. Switch to List for the native view.`);
        }
        return;
      }
      lastResult = { query, data: resp, at: Date.now() };
      panel.dataset.state = "done";
      renderGroups(root, resp, theme);
      // An empty set renders a message, not tiles.
      updateToolbar(root);
    });
  }

  // ---------------------------------------------------------------- sidebar
  //
  // The dashboard's left sidebar (Assigned to me / Created by me / Mentioning
  // me / Recently updated / Views) collapses to an icon rail. Nothing here
  // relies on GitHub's class names: the nav items are found by their visible
  // text, the sidebar is their lowest common ancestor climbed while it holds
  // neither the search box nor the result rows, and the pane is its parent.
  // If any step fails there is no toggle and the page is left untouched.

  const NAV_LABELS = ["Assigned to me", "Created by me", "Mentioning me", "Recently updated"];
  const RAIL_WIDTH = "48px";
  const TOGGLE_CLASS = "ghmi-sidebar-toggle";
  let sidebarFound = false;

  const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  function findNavLinks() {
    const anchors = [...document.querySelectorAll("a[href]")].filter((a) => !a.closest(`#${ROOT_ID}`));
    const links = [];
    for (const label of NAV_LABELS) {
      const a = anchors.find((el) => textOf(el) === label);
      if (!a) return null;
      links.push(a);
    }
    return links;
  }

  function holdsResults(node) {
    if (node.querySelector(SEARCH_SELECTOR)) return true;
    for (const a of node.querySelectorAll("a[href]")) {
      if (a.closest(`#${ROOT_ID}`)) continue;
      try {
        if (ISSUE_HREF_RE.test(new URL(a.href, location.origin).pathname)) return true;
      } catch {}
    }
    return false;
  }

  function findSidebar() {
    const links = findNavLinks();
    if (!links) return null;
    let el = links[0];
    while (el && !links.every((l) => el.contains(l))) el = el.parentElement;
    if (!el) return null;
    // The lowest common ancestor of the four items, climbed while its parent
    // still holds neither the search box nor any result row.
    while (el.parentElement && el.parentElement !== document.body && !holdsResults(el.parentElement)) {
      el = el.parentElement;
    }
    if (holdsResults(el) || !el.parentElement) return null;
    const pane = el.parentElement;
    const display = getComputedStyle(pane).display;
    const kind = /grid/.test(display) ? "grid" : /flex/.test(display) ? "flex" : null;
    if (!kind) return null;
    // A rail is a column: a stacked (column) flex pane or a single-track grid
    // would turn it into a 48px strip that clips the nav items.
    if (kind === "flex" && !/^row/.test(getComputedStyle(pane).flexDirection)) return null;
    if (kind === "grid" && getComputedStyle(pane).gridTemplateColumns.split(/\s+(?![^(]*\))/).filter(Boolean).length < 2) return null;
    // The sidebar must be the leading item of the pane to become a rail.
    if (pane.firstElementChild !== el) return null;
    return { sidebar: el, pane, kind, links };
  }

  // Wraps each link's visible text so CSS can clip it (visually hidden, not
  // display:none) while the link keeps its accessible name.
  function markNavLabels(link) {
    for (const child of [...link.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        const span = document.createElement("span");
        span.setAttribute("data-ghmi-label", "");
        span.setAttribute("data-ghmi-wrap", "");
        child.replaceWith(span);
        span.appendChild(child);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.localName !== "svg" && !child.querySelector("svg") && textOf(child)) {
        child.setAttribute("data-ghmi-label", "");
      }
    }
  }

  function markRailHidden(sidebar, links, toggle) {
    const keep = new Set([sidebar]);
    for (const l of links) for (let n = l; n && n !== sidebar; n = n.parentElement) keep.add(n);
    const walk = (el) => {
      for (const c of el.children) {
        if (c === toggle) continue;
        if (!keep.has(c)) c.setAttribute("data-ghmi-rail-hide", "");
        else if (!links.includes(c)) walk(c);
      }
    };
    walk(sidebar);
  }

  function ensureToggle(sidebar) {
    let btn = sidebar.querySelector(`:scope > .${TOGGLE_CLASS}`);
    if (btn) return btn;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = TOGGLE_CLASS;
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("aria-expanded") === "true" ? "collapsed" : "expanded";
      chrome.storage.local.set({ [STORAGE_SIDEBAR]: next });
    });
    sidebar.insertBefore(btn, sidebar.firstChild);
    return btn;
  }

  // A grid pane keeps GitHub's other tracks: the first track becomes the
  // rail, the second takes the freed space, any further track is carried
  // over from the live computed value (measured with our template removed).
  function measureRailColumns(pane) {
    pane.removeAttribute("data-ghmi-rail");
    pane.style.removeProperty("--ghmi-cols");
    const tracks = getComputedStyle(pane).gridTemplateColumns.split(/\s+(?![^(]*\))/).filter(Boolean);
    if (tracks.length < 2 || tracks[0] === "none") return false;
    pane.style.setProperty("--ghmi-cols", [RAIL_WIDTH, "minmax(0, 1fr)", ...tracks.slice(2)].join(" "));
    return true;
  }

  function applySidebar(state) {
    const found = findSidebar();
    sidebarFound = !!found;
    if (!found) {
      teardownSidebar();
      return;
    }
    const { sidebar, pane, kind, links } = found;
    const collapsed = state !== "expanded";

    sidebar.setAttribute("data-ghmi-sidebar", collapsed ? "collapsed" : "expanded");
    pane.setAttribute("data-ghmi-pane", kind);
    for (const c of pane.children) if (c !== sidebar) c.setAttribute("data-ghmi-content", "");

    const toggle = ensureToggle(sidebar);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    toggle.textContent = collapsed ? "»" : "«";

    for (const link of links) {
      link.setAttribute("data-ghmi-nav", "");
      if (!link.querySelector("[data-ghmi-label]")) markNavLabels(link);
      if (collapsed) {
        if (!link.hasAttribute("title")) {
          link.setAttribute("title", textOf(link));
          link.setAttribute("data-ghmi-titled", "");
        }
      } else if (link.hasAttribute("data-ghmi-titled")) {
        link.removeAttribute("title");
        link.removeAttribute("data-ghmi-titled");
      }
    }
    markRailHidden(sidebar, links, toggle);

    if (kind === "grid") {
      pane.removeAttribute("data-ghmi-rail");
      if (collapsed && measureRailColumns(pane)) pane.setAttribute("data-ghmi-rail", "");
      else pane.style.removeProperty("--ghmi-cols");
    }
  }

  function teardownSidebar() {
    document.querySelectorAll(`.${TOGGLE_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll("[data-ghmi-wrap]").forEach((span) => span.replaceWith(...span.childNodes));
    document.querySelectorAll("[data-ghmi-titled]").forEach((el) => {
      el.removeAttribute("title");
      el.removeAttribute("data-ghmi-titled");
    });
    document.querySelectorAll("[data-ghmi-pane]").forEach((el) => el.style.removeProperty("--ghmi-cols"));
    for (const attr of ["sidebar", "pane", "rail", "content", "rail-hide", "nav", "label"]) {
      document.querySelectorAll(`[data-ghmi-${attr}]`).forEach((el) => el.removeAttribute(`data-ghmi-${attr}`));
    }
  }

  async function sync() {
    if (!extensionAlive() || !isMyIssuesPage()) {
      teardown();
      return;
    }
    const stored = await chrome.storage.local.get([STORAGE_ENABLED, STORAGE_VIEW, STORAGE_SIDEBAR]);
    if (stored[STORAGE_ENABLED] === false) {
      teardown();
      return;
    }
    const root = ensureRoot();
    const view = stored[STORAGE_VIEW] === "grouped" ? "grouped" : "list";
    applyView(root, view);
    if (view === "grouped") fetchAndRender(root);
    applySidebar(stored[STORAGE_SIDEBAR]);
  }

  function teardown() {
    const root = document.getElementById(ROOT_ID);
    const parent = root?.parentElement;
    if (parent) {
      parent
        .querySelectorAll("[data-ghmi-hidden]")
        .forEach((el) => el.removeAttribute("data-ghmi-hidden"));
    }
    root?.remove();
    teardownSidebar();
    sidebarFound = false;
    rendered = { query: null };
    lastResult = null;
  }

  // A root mounted before the native rows existed sits at the end of <main>;
  // once a results block can be anchored on, it has to move in front of it.
  function needsRemount() {
    const root = document.getElementById(ROOT_ID);
    return !!root && root.dataset.fallback === "1" && !!findMount().before;
  }

  const debouncedSync = debounce(sync, 150);

  document.addEventListener("turbo:load", debouncedSync);
  document.addEventListener("turbo:render", debouncedSync);
  document.addEventListener("pjax:end", debouncedSync);
  window.addEventListener("resize", debounce(() => {
    // A responsive grid pane may change its track list at a breakpoint.
    if (document.querySelector('[data-ghmi-pane="grid"][data-ghmi-rail]')) debouncedSync();
  }, 200));

  chrome.storage.onChanged.addListener((changes) => {
    if (!extensionAlive()) return;
    if (changes[STORAGE_ENABLED] || changes[STORAGE_VIEW] || changes[STORAGE_SIDEBAR]) debouncedSync();
  });

  // Belt-and-suspenders SPA detection, as the other features do: Turbo
  // events plus a URL-polling fallback. The poll also re-asserts our nodes
  // when GitHub re-renders the page (same URL) and drops them.
  let lastUrl = location.href;
  const pollId = setInterval(() => {
    if (!extensionAlive()) {
      clearInterval(pollId);
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      debouncedSync();
    } else if (isMyIssuesPage() && !document.getElementById(ROOT_ID)) {
      debouncedSync();
    } else if (isMyIssuesPage() && needsRemount()) {
      document.getElementById(ROOT_ID)?.remove();
      debouncedSync();
    } else if (sidebarFound && !document.querySelector(`.${TOGGLE_CLASS}`)) {
      debouncedSync();
    }
  }, 800);

  sync();
})();
