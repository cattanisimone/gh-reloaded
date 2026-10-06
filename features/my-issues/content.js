// features/my-issues/content.js — on GitHub's own "My Issues" dashboard
// (github.com/issues), adds a "Group by project" control next to the native
// flat list. Switched on, it replaces the list with the same issues
// organized as Project → Status → issues, each a collapsible group with a
// count; switched off, GitHub's own list is restored untouched.
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
  const MESSAGE_TYPE_GROUPS = "GHMI_FETCH_GROUPS"; // matches background/my-issues.js

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function isMyIssuesPage() {
    return /^\/issues(\/|$)/.test(location.pathname);
  }

  function currentQuery() {
    return new URLSearchParams(location.search).get("q") || "";
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

  function controlHtml() {
    return `
      <div class="ghmi-bar" role="group" aria-label="My Issues view">
        <span class="ghmi-bar-label">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M1.75 1h3.5A1.75 1.75 0 0 1 7 2.75v3.5A1.75 1.75 0 0 1 5.25 8h-3.5A1.75 1.75 0 0 1 0 6.25v-3.5C0 1.784.784 1 1.75 1Zm9 0h3.5A1.75 1.75 0 0 1 16 2.75v3.5A1.75 1.75 0 0 1 14.25 8h-3.5A1.75 1.75 0 0 1 9 6.25v-3.5C9 1.784 9.784 1 10.75 1ZM1.75 9h3.5A1.75 1.75 0 0 1 7 10.75v3.5A1.75 1.75 0 0 1 5.25 16h-3.5A1.75 1.75 0 0 1 0 14.25v-3.5C0 9.784.784 9 1.75 9Zm9 0h3.5A1.75 1.75 0 0 1 16 10.75v3.5A1.75 1.75 0 0 1 14.25 16h-3.5A1.75 1.75 0 0 1 9 14.25v-3.5C9 9.784 9.784 9 10.75 9Z"></path>
          </svg>
          GH Reloaded
        </span>
        <span class="ghmi-seg" role="tablist">
          <button type="button" class="ghmi-seg-btn" data-view="list" role="tab">List</button>
          <button type="button" class="ghmi-seg-btn" data-view="grouped" role="tab">Group by project</button>
        </span>
      </div>
      <div class="ghmi-panel" hidden></div>`;
  }

  // Mounts (or re-mounts, if GitHub's SPA re-rendered the list and dropped
  // our node) the control + grouped panel immediately before the native
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
    root.innerHTML = controlHtml();
    parent.insertBefore(root, before);

    root.querySelectorAll(".ghmi-seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        chrome.storage.local.set({ [STORAGE_VIEW]: btn.dataset.view });
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

    const main = document.querySelector("main") || document.body;
    const searchEl = findSearchBox(main);
    for (let sib = root.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const keep = searchEl && sib.contains(searchEl);
      if (grouped && !keep) sib.setAttribute("data-ghmi-hidden", "");
      else sib.removeAttribute("data-ghmi-hidden");
    }
  }

  function issueRowHtml(issue) {
    const repo = escapeHtml(issue.nameWithOwner || "");
    const closed = issue.state === "CLOSED";
    return `
      <li class="ghmi-issue ${closed ? "is-closed" : "is-open"}">
        <span class="ghmi-issue-dot" aria-hidden="true"></span>
        <a class="ghmi-issue-link" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">
          <span class="ghmi-issue-title">${escapeHtml(issue.title || "")}</span>
          <span class="ghmi-issue-ref">${repo}#${issue.number}</span>
        </a>
      </li>`;
  }

  function statusGroupHtml(status, theme) {
    const name = status.name || "No Status";
    const p = paletteFor(status.color, theme);
    const pill = status.name
      ? `style="color:${p.fg}; background:${p.bg}; border-color:${p.fg}"`
      : `class="is-none"`;
    return `
      <details class="ghmi-status" open>
        <summary>
          <span class="ghmi-status-name" ${pill}>${escapeHtml(name)}</span>
          <span class="ghmi-count">${status.issues.length}</span>
        </summary>
        <ul class="ghmi-issues">${status.issues.map(issueRowHtml).join("")}</ul>
      </details>`;
  }

  function projectGroupHtml(project, theme) {
    const title = escapeHtml(project.title || "Untitled project");
    const header = project.url
      ? `<a class="ghmi-project-title" href="${escapeHtml(project.url)}" target="_blank" rel="noopener">${title}</a>`
      : `<span class="ghmi-project-title">${title}</span>`;
    return `
      <details class="ghmi-project" open>
        <summary>
          ${header}
          <span class="ghmi-count">${project.count}</span>
        </summary>
        <div class="ghmi-statuses">${project.statuses.map((s) => statusGroupHtml(s, theme)).join("")}</div>
      </details>`;
  }

  function noProjectGroupHtml(issues) {
    return `
      <details class="ghmi-project is-no-project" open>
        <summary>
          <span class="ghmi-project-title">No Project</span>
          <span class="ghmi-count">${issues.length}</span>
        </summary>
        <ul class="ghmi-issues">${issues.map(issueRowHtml).join("")}</ul>
      </details>`;
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
      btn.textContent = "Set GitHub token";
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      box.appendChild(document.createElement("br"));
      box.appendChild(btn);
    }
    panel.appendChild(box);
  }

  function renderGroups(panel, data, theme) {
    const { projects = [], noProject = [], totalCount = 0, fetchedCount = 0, truncated } = data;
    if (!projects.length && !noProject.length) {
      renderMessage(panel, "No issues match the current filters.");
      return;
    }

    let html = "";
    if (truncated) {
      html += `<div class="ghmi-note">Showing the first ${fetchedCount} of ${totalCount} issues — refine the filters above to narrow the set.</div>`;
    }
    html += projects.map((p) => projectGroupHtml(p, theme)).join("");
    if (noProject.length) html += noProjectGroupHtml(noProject);
    panel.innerHTML = html;
  }

  // Keyed by the query we last rendered for, so a repeated sync() (SPA
  // re-render, interval tick) doesn't re-fetch for a query already on
  // screen; a genuinely changed query (search/filter/saved-view edit)
  // clears it and re-fetches.
  let rendered = { query: null };

  function fetchAndRender(root) {
    const panel = root.querySelector(".ghmi-panel");
    const query = currentQuery();
    // Already showing (or already fetching) this exact query on this panel —
    // don't stack a second request. A re-mounted panel has no state yet, so
    // this never wrongly skips a genuinely fresh panel.
    if (rendered.query === query && (panel.dataset.state === "done" || panel.dataset.state === "loading")) {
      return;
    }
    rendered = { query };
    panel.dataset.state = "loading";
    renderMessage(panel, "Loading issues…");
    const theme = root.dataset.theme || githubTheme();

    chrome.runtime.sendMessage({ type: MESSAGE_TYPE_GROUPS, payload: { query } }, (resp) => {
      if (!document.contains(panel) || rendered.query !== query) return; // stale
      if (chrome.runtime.lastError) {
        renderMessage(panel, "Extension error: " + chrome.runtime.lastError.message);
        return;
      }
      if (!resp || !resp.ok) {
        const status = resp?.status;
        if (status === 401 || status === 403 || !resp?.hasToken) {
          renderMessage(
            panel,
            "Set a GitHub token in the extension options to group your issues by project.",
            "locked"
          );
        } else {
          renderMessage(panel, `Could not load issues: ${resp?.error || "unknown error"}`);
        }
        panel.dataset.state = "error";
        rendered = { query: null }; // allow a retry on the next sync
        return;
      }
      renderGroups(panel, resp, theme);
      panel.dataset.state = "done";
    });
  }

  async function sync() {
    if (!extensionAlive() || !isMyIssuesPage()) {
      teardown();
      return;
    }
    const stored = await chrome.storage.local.get([STORAGE_ENABLED, STORAGE_VIEW]);
    if (stored[STORAGE_ENABLED] === false) {
      teardown();
      return;
    }
    const root = ensureRoot();
    const view = stored[STORAGE_VIEW] === "grouped" ? "grouped" : "list";
    applyView(root, view);
    if (view === "grouped") fetchAndRender(root);
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
    rendered = { query: null };
  }

  const debouncedSync = debounce(sync, 150);

  document.addEventListener("turbo:load", debouncedSync);
  document.addEventListener("turbo:render", debouncedSync);
  document.addEventListener("pjax:end", debouncedSync);

  chrome.storage.onChanged.addListener((changes) => {
    if (!extensionAlive()) return;
    if (changes[STORAGE_ENABLED] || changes[STORAGE_VIEW]) debouncedSync();
  });

  // Belt-and-suspenders SPA detection, as the other features do: Turbo
  // events plus a URL-polling fallback. The poll also re-asserts our node
  // when GitHub re-renders the list region (same URL) and drops it.
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
    }
  }, 800);

  sync();
})();
