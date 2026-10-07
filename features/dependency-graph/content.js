// content/content.js — finds the "Sub-issues" section on a GitHub issue
// page (or on the issue-preview side panel of a Projects board) and injects
// a left-to-right dependency graph right after it.

(function () {
  const ROOT_ID = "ghdg-root";

  // Reloading/updating the extension while this content script is still
  // running on an already-open tab orphans it: chrome.* calls start
  // throwing "Extension context invalidated" instead of doing anything.
  // There's nothing useful to do at that point except stop trying — the
  // tab needs a real reload to get a fresh, working instance.
  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // Approximating the actual pastel pill colors GitHub's own Projects board
  // renders for each single-select option color, not the punchier Primer
  // "text" scale (which reads fine as text but is too loud as a fill).
  // Colors come back as e.g. "BLUE"/"blue" depending on the API (GraphQL vs
  // REST) — always upper-cased before lookup.
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

  // Shared between internal and external cards so status reads identically
  // either way. Always trusts whatever the board's own Status field says —
  // no hardcoded override for "done" or any other state. If the actual
  // "done" column on the board is colored green, the card is green; there's
  // no assumption baked in here about what that column should look like.
  // Only falls back to a plain open/closed dot when there's no project
  // Status data at all (not in a project, or the field couldn't be read).
  function statusStyle(node, theme) {
    const closed = node.state === "closed";
    const statusName = node.status && node.status.name;
    const cls = [];
    let style = "";
    let dotStyle = "";

    if (statusName) {
      const p = paletteFor(node.status.color, theme);
      style = `background:${p.bg}; border-color:${p.fg};`;
      dotStyle = `background:${p.fg};`;
    } else {
      dotStyle = closed ? "background:var(--ghdg-closed);" : "background:var(--ghdg-open);";
    }

    return { cls, style, dotStyle, statusName, closed };
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // An issue can be identified two ways depending on where we are:
  //  - a plain issue page:        /{owner}/{repo}/issues/{number}
  //  - a Projects board's issue   /orgs/{org}/projects/{n}/views/{v}
  //    preview side panel:          ?pane=issue&issue={owner}|{repo}|{number}
  function parseIssueUrl() {
    const pathMatch = location.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (pathMatch) {
      return { owner: pathMatch[1], repo: pathMatch[2], issueNumber: Number(pathMatch[3]) };
    }
    const params = new URLSearchParams(location.search);
    if (params.get("pane") === "issue") {
      const raw = params.get("issue") || "";
      const [owner, repo, numStr] = raw.split("|");
      const issueNumber = Number(numStr);
      if (owner && repo && Number.isFinite(issueNumber)) {
        return { owner, repo, issueNumber };
      }
    }
    return null;
  }

  // GitHub's markup for this section changes across redesigns; anchoring on
  // the visible "Sub-issues" heading text is more likely to survive that
  // than a specific class or data-testid. Works the same way inside the
  // Projects issue-preview side panel, which reuses the same issue view.
  function findSubIssuesAnchor() {
    const candidates = document.querySelectorAll(
      'h1, h2, h3, h4, [role="heading"], summary'
    );
    for (const el of candidates) {
      const text = (el.textContent || "").trim();
      if (/^sub-issues\b/i.test(text)) {
        return el.closest("section, div[class]") || el.parentElement;
      }
    }
    return null;
  }

  function waitFor(fn, { timeout = 8000, interval = 250 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function githubTheme() {
    const html = document.documentElement;
    const mode = html.getAttribute("data-color-mode");
    if (mode === "dark") return "dark";
    if (mode === "light") return "light";
    // "auto" (or missing attribute) — fall back to the OS preference.
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  // A tiny "open in new tab" icon, kept separate from the rest of the card
  // so the card itself isn't one giant link (avoids stealing clicks meant
  // for future in-card interaction, and makes "navigate" an explicit,
  // deliberate action rather than an easy misclick).
  function linkIconHtml(url, label) {
    return `
      <a class="ghdg-node-link" href="${url}" target="_blank" rel="noopener"
         title="${escapeHtml(label)}" onclick="event.stopPropagation()">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.062-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"></path>
        </svg>
      </a>`;
  }

  // Header icon buttons. Primer-style glyphs, kept inline (no remotely
  // hosted assets): a refresh arrow, a diagonal "expand" for full-screen,
  // and an X for closing it.
  function refreshIconHtml() {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7 7 0 1 1 1.05 9.11a.75.75 0 1 1 1.49-.172A5.501 5.501 0 1 0 8 2.5Z"></path></svg>`;
  }
  function expandIconHtml() {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3.25 1h3a.75.75 0 0 1 0 1.5H4.56l2.22 2.22a.75.75 0 1 1-1.06 1.06L3.5 3.56v1.69a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 2.75 1Zm10 0a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V3.56l-2.22 2.22a.75.75 0 1 1-1.06-1.06l2.22-2.22H9.75a.75.75 0 0 1 0-1.5ZM2.75 9.75a.75.75 0 0 1 .75.75v1.69l2.22-2.22a.75.75 0 1 1 1.06 1.06L4.56 13.25h1.69a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75v-3.5a.75.75 0 0 1 .75-.75Zm10.5 0a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.69l-2.22-2.22a.75.75 0 1 1 1.06-1.06l2.22 2.22V10.5a.75.75 0 0 1 .75-.75Z"></path></svg>`;
  }
  function closeIconHtml() {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"></path></svg>`;
  }

  // A board Status, spelled out by name (not just encoded in the card's
  // fill), for the roomier full-screen cards. Colored with the field's own
  // configured color, same as the fill.
  function statusChipHtml(node, theme) {
    if (!node.status || !node.status.name) return "";
    const fg = paletteFor(node.status.color, theme).fg;
    return `<span class="ghdg-node-status" style="color:${fg}">${escapeHtml(node.status.name)}</span>`;
  }

  function internalNodeHtml(node, x, y, theme, dims, large) {
    const { NODE_W: w, NODE_H: h } = dims;
    const title = escapeHtml(node.title || "");
    const bv = node.businessValue; // { value, color } | null
    const s = statusStyle(node, theme);

    const cls = ["ghdg-node", "is-internal", s.closed ? "is-closed" : "is-open", ...s.cls];
    if (large) cls.push("is-large");
    if (node.critical) cls.push("is-critical");
    const style = `left:${x}px; top:${y}px; width:${w}px; height:${h}px; ${s.style}`;

    const bvHtml = bv
      ? `<span class="ghdg-node-bv" style="color:${paletteFor(bv.color, theme).fg}">${escapeHtml(bv.value)}</span>`
      : "";
    const effortHtml =
      node.effort != null ? `<span class="ghdg-node-effort" title="Effort: ${node.effort}">${escapeHtml(node.effort)} pts</span>` : "";
    // Full-screen cards have the room to spell out the Status and the
    // owning Team as well; the compact inline card leaves them implicit.
    const statusHtml = large ? statusChipHtml(node, theme) : "";
    const teamHtml =
      large && node.team ? `<span class="ghdg-node-team">${escapeHtml(node.team)}</span>` : "";

    const titleAttr = escapeHtml(
      `#${node.number} ${node.title || ""}${s.statusName ? ` — ${s.statusName}` : ""}${
        node.effort != null ? ` — Effort: ${node.effort}` : ""
      }${node.critical ? " — on critical path" : ""}`
    );

    return `
      <div class="${cls.join(" ")}" title="${titleAttr}" style="${style}">
        ${linkIconHtml(node.url, `Open #${node.number}`)}
        <span class="ghdg-node-top">
          <span class="ghdg-node-dot" style="${s.dotStyle}"></span>
          <span class="ghdg-node-num">#${node.number}</span>
          ${effortHtml}
        </span>
        <span class="ghdg-node-title">${title}</span>
        ${statusHtml}
        ${bvHtml}
        ${teamHtml}
      </div>`;
  }

  function externalNodeHtml(node, x, y, theme, dims, large) {
    const { NODE_W: w, NODE_H: h } = dims;
    const title = escapeHtml(node.title || "");
    const label = `${escapeHtml(node.owner)}/${escapeHtml(node.repo)}#${node.number}`;
    const statusHtml = large ? statusChipHtml(node, theme) : "";
    const teamHtml = node.team
      ? `<span class="ghdg-node-team">${escapeHtml(node.team)}</span>`
      : "";
    const s = statusStyle(node, theme);
    const cls = ["ghdg-node", "is-external", ...s.cls];
    if (large) cls.push("is-large");
    const style = `left:${x}px; top:${y}px; width:${w}px; height:${h}px; ${s.style}`;

    const titleAttr = escapeHtml(
      `${node.owner}/${node.repo}#${node.number} ${node.title || ""}${s.statusName ? ` — ${s.statusName}` : ""}`
    );

    return `
      <div class="${cls.join(" ")}" title="${titleAttr}" style="${style}">
        ${linkIconHtml(node.url, `Open ${node.owner}/${node.repo}#${node.number}`)}
        <span class="ghdg-node-top">
          <span class="ghdg-node-dot" style="${s.dotStyle}"></span>
          <span class="ghdg-node-num">${label}</span>
        </span>
        <span class="ghdg-node-title">${title}</span>
        ${statusHtml}
        ${teamHtml}
      </div>`;
  }

  function edgePathD(x1, y1, x2, y2) {
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  // A straight/S-curve between two adjacent columns is fine, but across 2+
  // columns it can cut right across an unrelated card sitting in one of
  // the columns in between. Route those as a "hump" over the top instead
  // — attaches to the top-center of both nodes and arcs up into the clear
  // band layout.js reserves above row 0, staying clear of every column.
  function arcOverPathD(x1, y1, x2, y2, clearY) {
    return `M ${x1} ${y1} C ${x1} ${clearY}, ${x2} ${clearY}, ${x2} ${y2}`;
  }

  function renderGraph(body, graph, theme, align, dims, large) {
    const { nodes, edges } = graph;
    body.innerHTML = "";

    if (!nodes.length) {
      body.innerHTML = '<div class="ghdg-status">No sub-issues found.</div>';
      return;
    }

    const { positions, width, height } = window.GHDG_LAYOUT.layout(nodes, edges, align, dims);
    const { NODE_W: nodeW, NODE_H: nodeH, COL_GAP: colGap, ARC_CLEAR_Y: clearY } = dims;
    const externalIds = new Set(nodes.filter((n) => n.external).map((n) => n.id));

    const scroll = document.createElement("div");
    scroll.className = "ghdg-graph-scroll";

    const stage = document.createElement("div");
    stage.className = "ghdg-graph-stage";
    stage.style.width = width + "px";
    stage.style.height = height + "px";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ghdg-edges");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.innerHTML = `
      <defs>
        <marker id="ghdg-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" class="ghdg-arrowhead"></path>
        </marker>
        <marker id="ghdg-arrow-critical" viewBox="0 0 10 10" refX="8" refY="5"
                markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" class="ghdg-arrowhead-critical"></path>
        </marker>
      </defs>`;

    for (const e of edges) {
      const from = positions.get(e.from);
      const to = positions.get(e.to);
      if (!from || !to) continue;
      const isExternal = externalIds.has(e.from) || externalIds.has(e.to);
      const colsApart = Math.round((to.x - from.x) / (nodeW + colGap));
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        colsApart >= 2
          ? arcOverPathD(from.x + nodeW / 2, from.y, to.x + nodeW / 2, to.y, clearY)
          : edgePathD(from.x + nodeW, from.y + nodeH / 2, to.x, to.y + nodeH / 2)
      );
      path.setAttribute(
        "class",
        "ghdg-edge" + (isExternal ? " is-external" : "") + (e.critical ? " is-critical" : "")
      );
      path.setAttribute("marker-end", e.critical ? "url(#ghdg-arrow-critical)" : "url(#ghdg-arrow)");
      svg.appendChild(path);
    }
    stage.appendChild(svg);

    const nodesLayer = document.createElement("div");
    nodesLayer.className = "ghdg-nodes";
    nodesLayer.innerHTML = nodes
      .map((n) => {
        const p = positions.get(n.id);
        return n.external
          ? externalNodeHtml(n, p.x, p.y, theme, dims, large)
          : internalNodeHtml(n, p.x, p.y, theme, dims, large);
      })
      .join("");
    stage.appendChild(nodesLayer);

    scroll.appendChild(stage);
    body.appendChild(scroll);
  }

  // "full": everything. "open": drop external nodes that aren't actually
  // active anymore (closed) — a resolved dependency isn't blocking (or
  // blocked) in any way that still matters. "off": internal sub-issues only.
  function applyDependencyMode(graph, mode) {
    if (mode === "full") return graph;
    const nodes = graph.nodes.filter((n) => {
      if (!n.external) return true;
      if (mode === "off") return false;
      return n.state !== "closed";
    });
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return { ...graph, nodes, edges };
  }

  function renderStatus(body, kind, text) {
    body.innerHTML = "";
    const p = document.createElement("div");
    p.className = "ghdg-status";
    p.textContent = text;
    if (kind === "locked") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghdg-btn";
      btn.textContent = "Set GitHub token";
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      p.appendChild(document.createElement("br"));
      p.appendChild(btn);
    }
    body.appendChild(p);
  }

  // Render state, keyed purely by "owner/repo#number" — deliberately NOT
  // tied to whether #ghdg-root is currently in the DOM. Two concurrent
  // init() calls for the same issue (e.g. a turbo:load event firing right
  // next to the URL-polling fallback) must not both decide to fetch+insert:
  // that produced two duplicate graphs in testing. Claiming the key
  // synchronously, before the first `await`, closes that race.
  let state = { key: null, phase: "idle" }; // phase: 'idle' | 'pending' | 'done'

  // Tears down the controller for the currently-injected graph: its
  // auto-refresh timer, its document-level listeners, and any open
  // full-screen overlay. A fresh init() installs a new one; calling this
  // first keeps a SPA navigation from leaking timers/listeners or stranding
  // an overlay from the previous issue.
  let teardown = null;

  // Each automatic refresh bypasses the shared cache and fans out to
  // several REST/GraphQL calls per node (sub-issues, both dependency
  // directions, Status and field values), so a fast cadence on a large
  // graph can burn through GitHub's hourly rate limit on its own. The
  // default is deliberately a minute rather than a few seconds: returning
  // to a tab refreshes immediately (see onVisibility), so steady-state
  // polling only needs to catch changes made while the tab is already in
  // front of you, and can afford to be gentle on the API.
  const AUTO_REFRESH_MS_DEFAULT = 60000;
  const AUTO_REFRESH_MS_MIN = 250; // floor, so a stray tiny override can't hammer the API
  // When an automatic refresh fails, back off instead of retrying at the
  // same cadence — hardest on a rate-limit response — and climb back down
  // to the base cadence once one succeeds, so a throttled or offline tab
  // stops adding to the problem rather than hammering through it.
  const AUTO_REFRESH_MS_MAX = 5 * 60 * 1000; // backoff ceiling
  const AUTO_BACKOFF_FACTOR = 2;
  const AUTO_BACKOFF_FACTOR_RATE_LIMITED = 4;

  // Remove the injected graph (and its full-screen overlay) and dispose of
  // its controller. Safe to call when nothing is injected.
  function removeRoot() {
    if (teardown) {
      try {
        teardown();
      } catch {
        /* best-effort cleanup */
      }
      teardown = null;
    }
    document.getElementById(ROOT_ID)?.remove();
  }

  function headerTitleText(graph) {
    if (!graph) return "Dependency graph";
    const { criticalPathEffort: eff, criticalPathLength: len } = graph;
    if (len > 1) {
      return eff > 0
        ? `Dependency graph · Critical path effort: ${eff} (${len} steps)`
        : `Dependency graph · Critical path: ${len} steps`;
    }
    return "Dependency graph";
  }

  // The control cluster (align, mode, refresh, and either an enter- or
  // exit-full-screen button) rendered into both the embedded header and
  // the full-screen header, so the two presentations share one set of
  // controls and can't drift apart.
  function controlsHtml({ fullscreen }) {
    return (
      '<select class="ghdg-align-select" title="Column alignment">' +
      '<option value="right">Align: near dependents</option>' +
      '<option value="left">Align: as early as possible</option>' +
      "</select>" +
      '<select class="ghdg-mode-select" title="External dependencies">' +
      '<option value="full">Full dependencies</option>' +
      '<option value="open">Open dependencies only</option>' +
      '<option value="off">Hide external dependencies</option>' +
      "</select>" +
      `<button type="button" class="ghdg-icon-btn ghdg-refresh-btn" title="Refresh graph" aria-label="Refresh graph">${refreshIconHtml()}</button>` +
      (fullscreen
        ? `<button type="button" class="ghdg-icon-btn ghdg-close-btn" title="Exit full screen (Esc)" aria-label="Exit full screen">${closeIconHtml()}</button>`
        : `<button type="button" class="ghdg-icon-btn ghdg-fs-btn" title="Open full screen" aria-label="Open full screen">${expandIconHtml()}</button>`)
    );
  }

  async function init() {
    if (!extensionAlive()) return;
    const { ghdgEnabled } = await chrome.storage.local.get("ghdgEnabled");
    if (ghdgEnabled === false) {
      removeRoot();
      state = { key: null, phase: "idle" };
      return;
    }
    const info = parseIssueUrl();
    const key = info ? `${info.owner}/${info.repo}#${info.issueNumber}` : null;

    if (!info) {
      removeRoot();
      state = { key: null, phase: "idle" };
      return;
    }

    const existing = document.getElementById(ROOT_ID);

    if (state.key === key) {
      if (state.phase === "pending") return; // already fetching for this issue
      if (state.phase === "done" && existing && document.contains(existing)) return; // already rendered
      // else: rendered before, but GitHub's SPA wiped our node from the DOM
      // (e.g. a Turbo re-render without a URL change) — fall through and redo.
    } else {
      removeRoot(); // navigated to a different issue — drop the stale graph now
    }

    state = { key, phase: "pending" }; // claim this key before any await

    const anchor = await waitFor(findSubIssuesAnchor);
    if (!anchor) {
      state = { key, phase: "idle" }; // no sub-issues (yet) — allow a later retry on this same key
      return;
    }

    // The URL may have changed again while we were waiting for the anchor.
    if (parseIssueUrl()?.issueNumber !== info.issueNumber) return;

    removeRoot(); // clear any leftover (and its controller) from a previous attempt

    const { ghdgDepMode, ghdgAlignMode, ghdgAutoRefreshMs } = await chrome.storage.local.get([
      "ghdgDepMode",
      "ghdgAlignMode",
      "ghdgAutoRefreshMs",
    ]);
    let depMode = ghdgDepMode || "full";
    let alignMode = ghdgAlignMode || "right";
    const autoRefreshMs = Math.max(
      AUTO_REFRESH_MS_MIN,
      Number(ghdgAutoRefreshMs) || AUTO_REFRESH_MS_DEFAULT
    );

    // The URL may have changed again while we were waiting on storage too.
    if (parseIssueUrl()?.issueNumber !== info.issueNumber) return;

    const theme = githubTheme();
    const { EMBEDDED_DIMS, FULLSCREEN_DIMS } = window.GHDG_LAYOUT;

    const container = document.createElement("div");
    container.id = ROOT_ID;
    container.className = "ghdg-root ghdg-scope";
    container.dataset.theme = theme;
    container.innerHTML =
      '<div class="ghdg-header">' +
      '<span class="ghdg-header-title">Dependency graph</span>' +
      `<span class="ghdg-header-controls">${controlsHtml({ fullscreen: false })}</span>` +
      "</div>" +
      '<div class="ghdg-notice" hidden></div>' +
      '<div class="ghdg-body"><div class="ghdg-status">Loading dependency graph…</div></div>';
    anchor.insertAdjacentElement("afterend", container);

    const embeddedBody = container.querySelector(".ghdg-body");
    state = { key, phase: "done" };

    // ---- controller: shared state for the embedded graph and its
    // optional full-screen twin, plus the refresh lifecycle ----
    let currentGraph = null; // last successfully fetched+laid-out graph
    let refreshing = false; // a background refresh is in flight
    let noticeText = null; // text of the retry banner when a refresh failed, else null
    let fsOverlay = null; // the full-screen overlay element, or null when closed
    let autoTimer = null;
    let autoDelay = autoRefreshMs; // current auto-refresh cadence; grows on failure, resets on success

    const isStale = () => state.key !== key || !document.contains(container);

    // DOM lookups that should span both the embedded header and the
    // full-screen overlay when one is open.
    function scopes() {
      return fsOverlay ? [container, fsOverlay] : [container];
    }
    function allOf(selector) {
      return scopes().flatMap((root) => [...root.querySelectorAll(selector)]);
    }

    function syncSelects() {
      for (const s of allOf(".ghdg-align-select")) s.value = alignMode;
      for (const s of allOf(".ghdg-mode-select")) s.value = depMode;
    }

    function renderInto(bodyEl, titleEl, dims, large) {
      const g = applyDependencyMode(currentGraph, depMode);
      renderGraph(bodyEl, g, theme, alignMode, dims, large);
      if (titleEl) titleEl.textContent = headerTitleText(currentGraph);
      return g;
    }

    function renderAll() {
      if (!currentGraph) return;
      const g = renderInto(
        embeddedBody,
        container.querySelector(".ghdg-header-title"),
        EMBEDDED_DIMS,
        false
      );
      // Full-screen only makes sense once there's actually a graph to blow up.
      for (const b of allOf(".ghdg-fs-btn")) b.disabled = g.nodes.length === 0;
      if (fsOverlay) {
        renderInto(
          fsOverlay.querySelector(".ghdg-fs-body"),
          fsOverlay.querySelector(".ghdg-fs-title"),
          FULLSCREEN_DIMS,
          true
        );
      }
    }

    function setRefreshing(on) {
      for (const b of allOf(".ghdg-refresh-btn")) {
        b.disabled = on;
        b.classList.toggle("is-spinning", on);
      }
    }

    function showNotice(text) {
      noticeText = text;
      for (const el of allOf(".ghdg-notice")) {
        el.textContent = text + " ";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "ghdg-btn ghdg-retry-btn";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => refresh());
        el.appendChild(retry);
        el.hidden = false;
      }
    }
    function clearNotice() {
      noticeText = null;
      for (const el of allOf(".ghdg-notice")) {
        el.hidden = true;
        el.textContent = "";
      }
    }

    function fetchGraph(fresh) {
      return new Promise((resolve) => {
        if (!extensionAlive()) return resolve({ ok: false, error: "extension context invalidated" });
        chrome.runtime.sendMessage({ type: "GHDG_FETCH_GRAPH", payload: { ...info, fresh } }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: "no response" });
          }
        });
      });
    }

    // Background refresh (manual button, auto timer, or retry). The current
    // graph stays visible and interactive throughout; it's replaced in one
    // step only once the new one is fetched and laid out. A failure leaves
    // the last good graph untouched and shows a retry affordance instead.
    async function refresh() {
      if (refreshing || !currentGraph) return null;
      refreshing = true;
      setRefreshing(true);
      const resp = await fetchGraph(true);
      refreshing = false;
      if (isStale()) return resp;
      setRefreshing(false);
      if (resp && resp.ok) {
        currentGraph = resp.graph;
        autoDelay = autoRefreshMs; // any success restores the base cadence
        clearNotice();
        renderAll();
      } else {
        showNotice("Couldn’t refresh the dependency graph — showing the last loaded version.");
      }
      return resp;
    }

    // A self-rescheduling timeout rather than a fixed-period interval, so
    // the cadence can stretch after a failure (adaptive backoff) and the
    // next tick never overlaps one that's still running.
    function startAuto() {
      if (autoTimer) return;
      autoDelay = autoRefreshMs;
      autoTimer = setTimeout(autoTick, autoDelay);
    }
    function stopAuto() {
      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
    }
    async function autoTick() {
      autoTimer = null;
      if (!extensionAlive()) return stopAuto();
      // Pause polling while the tab isn't visible — don't poll in the
      // background. onVisibility refreshes immediately on the way back.
      if (!document.hidden) {
        const resp = await refresh();
        if (isStale()) return;
        if (resp && !resp.ok) {
          // A successful refresh resets autoDelay inside refresh(); a
          // failure grows it, backing off hardest on a rate-limit reply.
          const rateLimited = resp.status === 403 || resp.status === 429;
          const factor = rateLimited ? AUTO_BACKOFF_FACTOR_RATE_LIMITED : AUTO_BACKOFF_FACTOR;
          autoDelay = Math.min(AUTO_REFRESH_MS_MAX, Math.max(autoDelay, autoRefreshMs) * factor);
        }
      }
      if (isStale()) return;
      autoTimer = setTimeout(autoTick, autoDelay);
    }
    function onVisibility() {
      // Coming back to a tab that was hidden: pick up anything added while away.
      if (!document.hidden && !isStale()) refresh();
    }

    function openFullscreen() {
      if (fsOverlay || !currentGraph) return;
      const overlay = document.createElement("div");
      overlay.id = "ghdg-fs";
      overlay.className = "ghdg-fs ghdg-scope";
      overlay.dataset.theme = theme;
      overlay.innerHTML =
        '<div class="ghdg-fs-header">' +
        '<span class="ghdg-header-title ghdg-fs-title">Dependency graph</span>' +
        `<span class="ghdg-header-controls">${controlsHtml({ fullscreen: true })}</span>` +
        "</div>" +
        '<div class="ghdg-notice" hidden></div>' +
        '<div class="ghdg-fs-body"></div>';
      document.body.appendChild(overlay);
      fsOverlay = overlay;
      wireControls(overlay);
      if (noticeText) showNotice(noticeText); // mirror an outstanding refresh error
      renderAll();
      overlay.querySelector(".ghdg-close-btn")?.focus();
    }
    function closeFullscreen() {
      if (!fsOverlay) return;
      fsOverlay.remove();
      fsOverlay = null;
    }

    function wireControls(root) {
      const alignSelect = root.querySelector(".ghdg-align-select");
      const modeSelect = root.querySelector(".ghdg-mode-select");
      alignSelect.value = alignMode;
      modeSelect.value = depMode;
      alignSelect.addEventListener("change", () => {
        alignMode = alignSelect.value;
        chrome.storage.local.set({ ghdgAlignMode: alignMode });
        syncSelects();
        renderAll();
      });
      modeSelect.addEventListener("change", () => {
        depMode = modeSelect.value;
        chrome.storage.local.set({ ghdgDepMode: depMode });
        syncSelects();
        renderAll();
      });
      root.querySelector(".ghdg-refresh-btn").addEventListener("click", () => refresh());
      root.querySelector(".ghdg-fs-btn")?.addEventListener("click", openFullscreen);
      root.querySelector(".ghdg-close-btn")?.addEventListener("click", closeFullscreen);
    }

    function onKeydown(e) {
      if (e.key === "Escape" && fsOverlay) {
        e.preventDefault();
        closeFullscreen();
      }
    }

    wireControls(container);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKeydown);
    teardown = () => {
      stopAuto();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKeydown);
      closeFullscreen();
    };

    // Initial load uses the shared cache (it dedupes the SPA-nav burst);
    // every refresh after this bypasses it so it actually sees new data.
    const resp = await fetchGraph(false);
    if (isStale()) return;
    if (!resp || !resp.ok) {
      const status = resp?.status;
      if (status === 401 || status === 403 || !resp?.hasToken) {
        renderStatus(
          embeddedBody,
          "locked",
          "Set a GitHub token in the extension options to load the dependency graph."
        );
      } else {
        renderStatus(embeddedBody, "error", `Could not load the graph: ${resp?.error || "unknown error"}`);
      }
      return;
    }
    currentGraph = resp.graph;
    renderAll();
    startAuto();
  }

  // --- Re-run on GitHub's SPA navigations. Belt-and-suspenders: Turbo
  // events are the primary signal, a URL-polling fallback covers the case
  // where GitHub renames/changes its navigation events again, or where
  // opening/closing the Projects issue-preview panel only changes the
  // query string via history.pushState without firing a Turbo event. ---
  const debouncedInit = debounce(init, 150);
  document.addEventListener("turbo:load", debouncedInit);
  document.addEventListener("turbo:render", debouncedInit);
  document.addEventListener("pjax:end", debouncedInit);

  chrome.storage.onChanged.addListener((changes) => {
    if (extensionAlive() && changes.ghdgEnabled) debouncedInit();
  });

  let lastUrl = location.href;
  const pollId = setInterval(() => {
    if (!extensionAlive()) {
      clearInterval(pollId);
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      debouncedInit();
    }
  }, 800);

  init();
})();
