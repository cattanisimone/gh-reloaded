// content/content.js — finds the "Sub-issues" section on a GitHub issue
// page and injects a left-to-right dependency graph right after it.

(function () {
  const ROOT_ID = "ghdg-root";

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function parseIssueUrl() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], issueNumber: Number(m[3]) };
  }

  // GitHub's markup for this section changes across redesigns; anchoring on
  // the visible "Sub-issues" heading text is more likely to survive that
  // than a specific class or data-testid.
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

  function nodeHtml(node, x, y) {
    const { NODE_W: w, NODE_H: h } = window.GHDG_LAYOUT;
    const closed = node.state === "closed";
    const title = escapeHtml(node.title || "");
    return `
      <a class="ghdg-node ${closed ? "is-closed" : "is-open"}"
         href="${node.url}" title="#${node.number} ${title}"
         style="left:${x}px; top:${y}px; width:${w}px; height:${h}px;">
        <span class="ghdg-node-dot"></span>
        <span class="ghdg-node-body">
          <span class="ghdg-node-num">#${node.number}</span>
          <span class="ghdg-node-title">${title}</span>
        </span>
      </a>`;
  }

  function edgePathD(x1, y1, x2, y2) {
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function renderGraph(body, graph) {
    const { nodes, edges } = graph;
    body.innerHTML = "";

    if (!nodes.length) {
      body.innerHTML = '<div class="ghdg-status">No sub-issues found.</div>';
      return;
    }

    const { positions, width, height } = window.GHDG_LAYOUT.layout(nodes, edges);
    const { NODE_W: nodeW, NODE_H: nodeH } = window.GHDG_LAYOUT;

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
      </defs>`;

    for (const e of edges) {
      const from = positions.get(e.from);
      const to = positions.get(e.to);
      if (!from || !to) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        edgePathD(from.x + nodeW, from.y + nodeH / 2, to.x, to.y + nodeH / 2)
      );
      path.setAttribute("class", "ghdg-edge");
      path.setAttribute("marker-end", "url(#ghdg-arrow)");
      svg.appendChild(path);
    }
    stage.appendChild(svg);

    const nodesLayer = document.createElement("div");
    nodesLayer.className = "ghdg-nodes";
    nodesLayer.innerHTML = nodes
      .map((n) => {
        const p = positions.get(n.number);
        return nodeHtml(n, p.x, p.y);
      })
      .join("");
    stage.appendChild(nodesLayer);

    scroll.appendChild(stage);
    body.appendChild(scroll);
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

  let currentIssueKey = null;

  async function init() {
    const info = parseIssueUrl();
    const key = info ? `${info.owner}/${info.repo}#${info.issueNumber}` : null;

    if (!info) {
      document.getElementById(ROOT_ID)?.remove();
      currentIssueKey = null;
      return;
    }

    const existing = document.getElementById(ROOT_ID);
    if (key === currentIssueKey && existing && document.contains(existing)) {
      return; // same issue, already rendered/rendering — nothing to do
    }

    existing?.remove();

    const anchor = await waitFor(findSubIssuesAnchor);
    if (!anchor) return; // no sub-issues on this issue — nothing to inject

    // The URL (and therefore the target issue) may have changed again while
    // we were waiting for the anchor; bail out rather than render stale data.
    if (location.href.indexOf(`/issues/${info.issueNumber}`) === -1) return;

    currentIssueKey = key;

    const container = document.createElement("div");
    container.id = ROOT_ID;
    container.className = "ghdg-root";
    container.dataset.theme = githubTheme();
    container.innerHTML =
      '<div class="ghdg-header">Dependency graph</div>' +
      '<div class="ghdg-body"><div class="ghdg-status">Loading dependency graph…</div></div>';
    anchor.insertAdjacentElement("afterend", container);

    const body = container.querySelector(".ghdg-body");

    chrome.runtime.sendMessage({ type: "GHDG_FETCH_GRAPH", payload: info }, (resp) => {
      if (chrome.runtime.lastError) {
        if (document.contains(container)) {
          renderStatus(body, "error", "Extension error: " + chrome.runtime.lastError.message);
        }
        return;
      }
      if (!document.contains(container) || currentIssueKey !== key) return; // stale response

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

      renderGraph(body, resp.graph);
    });
  }

  // --- Re-run on GitHub's SPA navigations. Belt-and-suspenders: Turbo
  // events are the primary signal, a URL-polling fallback covers the case
  // where GitHub renames/changes its navigation events again. ---
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
