// content/content.js — finds the "Sub-issues" section on a GitHub issue
// page (or on the issue-preview side panel of a Projects board) and injects
// a left-to-right dependency graph right after it.

(function () {
  const ROOT_ID = "ghdg-root";

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

  function isDoneStatus(status) {
    return !!status && /\bdone\b/i.test(status.name || "");
  }

  // Shared between internal and external cards so status reads identically
  // either way. "Done" is a deliberate exception — it's always rendered as
  // the purple entry regardless of the option's actual configured color —
  // but otherwise gets the exact same soft tint as any other status, not a
  // separate heavier treatment (that read as too saturated).
  function statusStyle(node, theme) {
    const done = isDoneStatus(node.status);
    const statusName = node.status && node.status.name;
    const closed = node.state === "closed";
    const cls = [];
    let style = "";
    let dotStyle = "";

    if (done) {
      cls.push("is-done");
      const p = paletteFor("PURPLE", theme);
      style = `background:${p.bg}; border-color:${p.fg};`;
      dotStyle = `background:${p.fg};`;
    } else if (statusName) {
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

  function internalNodeHtml(node, x, y, theme) {
    const { NODE_W: w, NODE_H: h } = window.GHDG_LAYOUT;
    const title = escapeHtml(node.title || "");
    const bv = node.businessValue; // { value, color } | null
    const s = statusStyle(node, theme);

    const cls = ["ghdg-node", "is-internal", s.closed ? "is-closed" : "is-open", ...s.cls];
    if (node.critical) cls.push("is-critical");
    const style = `left:${x}px; top:${y}px; width:${w}px; height:${h}px; ${s.style}`;

    const bvHtml = bv
      ? `<span class="ghdg-node-bv" style="color:${paletteFor(bv.color, theme).fg}">${escapeHtml(bv.value)}</span>`
      : "";
    const effortHtml =
      node.effort != null ? `<span class="ghdg-node-effort" title="Effort: ${node.effort}">${escapeHtml(node.effort)} pts</span>` : "";

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
        ${bvHtml}
      </div>`;
  }

  function externalNodeHtml(node, x, y, theme) {
    const { NODE_W: w, NODE_H: h } = window.GHDG_LAYOUT;
    const title = escapeHtml(node.title || "");
    const label = `${escapeHtml(node.owner)}/${escapeHtml(node.repo)}#${node.number}`;
    const teamHtml = node.team
      ? `<span class="ghdg-node-team">${escapeHtml(node.team)}</span>`
      : "";
    const s = statusStyle(node, theme);
    const cls = ["ghdg-node", "is-external", ...s.cls];
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

  function renderGraph(body, graph, theme) {
    const { nodes, edges } = graph;
    body.innerHTML = "";

    if (!nodes.length) {
      body.innerHTML = '<div class="ghdg-status">No sub-issues found.</div>';
      return;
    }

    const { positions, width, height } = window.GHDG_LAYOUT.layout(nodes, edges);
    const { NODE_W: nodeW, NODE_H: nodeH, COL_GAP: colGap, ARC_CLEAR_Y: clearY } = window.GHDG_LAYOUT;
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
        return n.external ? externalNodeHtml(n, p.x, p.y, theme) : internalNodeHtml(n, p.x, p.y, theme);
      })
      .join("");
    stage.appendChild(nodesLayer);

    scroll.appendChild(stage);
    body.appendChild(scroll);
  }

  // "full": everything. "open": drop external nodes that aren't actually
  // active anymore (closed, or status Done) — a resolved dependency isn't
  // blocking (or blocked) in any way that still matters. "off": internal
  // sub-issues only.
  function applyDependencyMode(graph, mode) {
    if (mode === "full") return graph;
    const nodes = graph.nodes.filter((n) => {
      if (!n.external) return true;
      if (mode === "off") return false;
      return n.state !== "closed" && !isDoneStatus(n.status);
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

  async function init() {
    const info = parseIssueUrl();
    const key = info ? `${info.owner}/${info.repo}#${info.issueNumber}` : null;

    if (!info) {
      document.getElementById(ROOT_ID)?.remove();
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
      existing?.remove(); // navigated to a different issue — drop the stale graph now
    }

    state = { key, phase: "pending" }; // claim this key before any await

    const anchor = await waitFor(findSubIssuesAnchor);
    if (!anchor) {
      state = { key, phase: "idle" }; // no sub-issues (yet) — allow a later retry on this same key
      return;
    }

    // The URL may have changed again while we were waiting for the anchor.
    if (parseIssueUrl()?.issueNumber !== info.issueNumber) return;

    document.getElementById(ROOT_ID)?.remove(); // clear any leftover from a previous attempt

    const { ghdgDepMode } = await chrome.storage.local.get("ghdgDepMode");
    const initialMode = ghdgDepMode || "full";

    // The URL may have changed again while we were waiting on storage too.
    if (parseIssueUrl()?.issueNumber !== info.issueNumber) return;

    const theme = githubTheme();
    const container = document.createElement("div");
    container.id = ROOT_ID;
    container.className = "ghdg-root";
    container.dataset.theme = theme;
    container.innerHTML =
      '<div class="ghdg-header">' +
      '<span class="ghdg-header-title">Dependency graph</span>' +
      '<select class="ghdg-mode-select" title="External dependencies">' +
      '<option value="full">Full dependencies</option>' +
      '<option value="open">Open dependencies only</option>' +
      '<option value="off">Hide external dependencies</option>' +
      "</select>" +
      "</div>" +
      '<div class="ghdg-body"><div class="ghdg-status">Loading dependency graph…</div></div>';
    anchor.insertAdjacentElement("afterend", container);

    const body = container.querySelector(".ghdg-body");
    const headerTitle = container.querySelector(".ghdg-header-title");
    const modeSelect = container.querySelector(".ghdg-mode-select");
    modeSelect.value = initialMode;
    state = { key, phase: "done" };

    let lastGraph = null;
    modeSelect.addEventListener("change", () => {
      chrome.storage.local.set({ ghdgDepMode: modeSelect.value });
      if (lastGraph) renderGraph(body, applyDependencyMode(lastGraph, modeSelect.value), theme);
    });

    chrome.runtime.sendMessage({ type: "GHDG_FETCH_GRAPH", payload: info }, (resp) => {
      if (chrome.runtime.lastError) {
        if (document.contains(container)) {
          renderStatus(body, "error", "Extension error: " + chrome.runtime.lastError.message);
        }
        return;
      }
      if (!document.contains(container) || state.key !== key) return; // stale response

      if (!resp || !resp.ok) {
        const status = resp?.status;
        if (status === 401 || status === 403 || !resp?.hasToken) {
          renderStatus(
            body,
            "locked",
            "Set a GitHub token in the extension options to load the dependency graph."
          );
        } else {
          renderStatus(body, "error", `Could not load the graph: ${resp?.error || "unknown error"}`);
        }
        return;
      }

      lastGraph = resp.graph;
      renderGraph(body, applyDependencyMode(lastGraph, modeSelect.value), theme);

      if (headerTitle) {
        const { criticalPathEffort: eff, criticalPathLength: len } = resp.graph;
        headerTitle.textContent =
          len > 1
            ? eff > 0
              ? `Dependency graph · Critical path effort: ${eff} (${len} steps)`
              : `Dependency graph · Critical path: ${len} steps`
            : "Dependency graph";
      }
    });
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

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      debouncedInit();
    }
  }, 800);

  init();
})();
