// features/github-status/content.js — a small status badge on the corner of
// the GitHub logo on every github.com page, a native popover panel with what
// githubstatus.com reports, and an incident pill in the header bar when an
// open incident concerns the page the user is on.
//
// The data comes from the background (one shared fetch of the official
// summary.json); this script only draws it. The dot is the logo's next
// sibling, overlaid on its corner by CSS anchor positioning (the logo is marked
// data-ghgs-logo), with a ring in the header's own background colour. It is
// anchored on the logo link (found by its aria-label or its octicon, never by a CSS-module class)
// and the pill on the header's search control. If an anchor is missing
// nothing is inserted and the next scan tries again: there is no other
// container to fall back to. The rules live in relevance.js (loaded first).

(function () {
  const R = globalThis.GHGS_RELEVANCE;
  const DOT_ID = "ghgs-dot";
  const PILL_ID = "ghgs-pill";
  const LINE_ID = "ghgs-line"; // drawn by older versions: only removed now
  const PANEL_ID = "ghgs-panel";
  const MESSAGE_TYPE = "GITHUB_STATUS_GET"; // matches background/github-status.js
  const REFRESH_MS = 5 * 60_000;
  const TICK_MS = 30_000;
  const SVG = "http://www.w3.org/2000/svg";

  const state = {
    enabled: true,
    notice: true,
    dismissed: {},
    view: { snapshot: null, fetchedAt: 0, error: false },
    loaded: false,
    path: "",
    lastAsk: 0,
  };

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // --- DOM helpers ----------------------------------------------------------

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k) n.append(k);
    return n;
  }

  function icon(kind) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    // minor: triangle; major / critical: hexagon; so the signal is not colour alone.
    path.setAttribute("d", kind === "major" ? "M8 1.2l5.9 3.4v6.8L8 14.8l-5.9-3.4V4.6z" : "M8 2L14.5 13.5h-13z");
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }

  function closeIcon() {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "M3.5 3.5l9 9m0-9l-9 9");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("fill", "none");
    svg.append(path);
    return svg;
  }

  // --- anchors ----------------------------------------------------------------

  const LOGO = 'a[href="/"]:has(svg.octicon-mark-github), a[href="https://github.com/"]:has(svg.octicon-mark-github)';

  // The header is found by structure: the one that holds the GitHub mark link. Class names and the banner role are
  // only a second case (the hashed GlobalNav / appHeader classes and the role have both come and gone).
  function findHeader() {
    const headers = [...document.querySelectorAll("header")];
    return (
      headers.find((h) => h.querySelector(LOGO)) ||
      headers.find((h) => h.matches('[role="banner"], .AppHeader, [class*="appHeader"]') && h.querySelector("a:has(svg.octicon-mark-github)")) ||
      null
    );
  }

  function findLogo(header) {
    if (!header) return null;
    return (
      header.querySelector(LOGO) ||
      header.querySelector('a[aria-label="Homepage"]') ||
      header.querySelector("a:has(svg.octicon-mark-github)") ||
      null
    );
  }

  // Climbs from the search control to the wrapper that sits in the header's row: past parents whose other
  // children are not rendered (a hidden or joined sibling), and past a gap-less group when the row above
  // spaces its children with a gap. Layout facts only, never a class name. A gap-less row with no gapped row
  // above it is left alone: the pill stays next to the control and ensurePill adds the missing space.
  // True when the rendered children of a row touch each other (a joined group, not controls spaced by margins).
  function joined(parent) {
    const rects = [...parent.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).sort((a, b) => a.left - b.left);
    return rects.every((r, i) => i === 0 || r.left - rects[i - 1].right <= 1);
  }

  function outermostSearchWrapper(node, header, rendered) {
    const gapOf = (n) => parseFloat(getComputedStyle(n).columnGap) || 0;
    const isRow = (n) => /flex|grid/.test(getComputedStyle(n).display);
    for (let parent = node.parentElement; parent && parent !== header; parent = node.parentElement) {
      if ([...parent.children].filter(rendered).length === 1) {
        node = parent;
        continue;
      }
      const above = parent.parentElement;
      if (isRow(parent) && gapOf(parent) === 0 && joined(parent) && above && above !== header && isRow(above) && gapOf(above) > 0) {
        node = parent;
        continue;
      }
      break;
    }
    return node;
  }

  // The header's search control: a search landmark, the search element or a
  // control whose accessible name or text says "search".
  function findSearch(header) {
    if (!header) return null;
    const own = "#" + PILL_ID + ", #" + PANEL_ID;
    // GitHub hides whole groups at narrow widths (display: none), so a match with no layout box is skipped:
    // the pill goes next to a rendered search control or nowhere.
    const rendered = (n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // Landmarks first, then controls whose accessible name says "search". Link text is never read:
    // a repository called "research" must not become the anchor.
    const landmarks = [...header.querySelectorAll("qbsearch-input, [role='search'], input[type='search'], [role='searchbox']")];
    const named = [...header.querySelectorAll("button, input")].filter((n) => !n.closest(own) && /search/i.test(n.getAttribute("aria-label") || n.getAttribute("placeholder") || ""));
    for (let node of [...landmarks, ...named]) {
      if (!rendered(node)) continue;
      node = outermostSearchWrapper(node, header, rendered);
      if (node.parentElement) return node;
    }
    return null;
  }

  // --- model ----------------------------------------------------------------

  function dotState() {
    return R.dotState(state.view, Date.now());
  }

  const STATE_TEXT = {
    ok: "No incident reported",
    minor: "Minor incident",
    major: "Major incident",
    critical: "Critical incident",
    maintenance: "Maintenance in progress",
    unknown: "Unverified",
  };

  // A dot raised only by a component status (no incident, indicator calm) must not claim an incident.
  function stateText(s) {
    const snap = state.view.snapshot;
    const rank = { none: 0, minor: 1, major: 2, critical: 3 };
    if ((s === "minor" || s === "major") && snap) {
      const fromIncident = Math.max(rank[snap.indicator] || 0, ...(snap.incidents || []).map((i) => rank[i.impact] || 0));
      if (fromIncident < rank[s]) return s === "major" ? "Service outage" : "Degraded service";
    }
    return STATE_TEXT[s];
  }

  function agoText(at) {
    const min = Math.floor((Date.now() - at) / 60_000);
    if (!at) return "never";
    if (min < 1) return "just now";
    if (min === 1) return "1 min ago";
    return `${min} min ago`;
  }

  function clock(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  }

  const COMPONENT_WORDS = { degraded_performance: "Degraded performance", partial_outage: "Partial outage", major_outage: "Major outage", under_maintenance: "Maintenance" };

  // --- dot ------------------------------------------------------------------

  function buildDot() {
    const b = el("button", { id: DOT_ID, type: "button", class: "ghgs-dot", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": PANEL_ID, popovertarget: PANEL_ID });
    b.append(el("span", { class: "ghgs-dot-mark", "aria-hidden": "true" }));
    return b;
  }

  function paintDot(dot) {
    const s = dotState();
    dot.dataset.state = s;
    dot.setAttribute("aria-label", `GitHub Status: ${stateText(s)}. Open details`);
  }

  function ensureDot(header) {
    const logo = findLogo(header);
    let dot = document.getElementById(DOT_ID);
    if (!logo || !logo.parentElement) return; // no anchor: nothing inserted, retried on the next scan
    if (!dot) dot = buildDot();
    if (logo.nextElementSibling !== dot) logo.after(dot);
    // One anchor name, one logo: a replaced logo hands the mark over on the next scan.
    for (const old of document.querySelectorAll("[data-ghgs-logo]")) if (old !== logo) old.removeAttribute("data-ghgs-logo");
    logo.setAttribute("data-ghgs-logo", "");
    paintDot(dot);
    paintRing(dot, logo, header);
  }

  // The ring is the colour behind the logo: the first opaque background from the logo up to the header.
  function paintRing(dot, logo, header) {
    for (let n = logo; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const m = c.match(/[\d.]+/g);
      if (m && m.length >= 3 && (m.length < 4 || Number(m[3]) === 1)) return dot.style.setProperty("--ghgs-ring", c);
      if (n === header) break;
    }
    dot.style.removeProperty("--ghgs-ring"); // transparent all the way (a hero shows behind the header): no ring rather than a wrong colour
  }

  // --- pill ---------------------------------------------------------------------

  function currentNotice() {
    if (!state.notice || !state.view.snapshot) return null;
    if (dotState() === "unknown") return null;
    return R.noticeFor(state.view.snapshot, location.pathname, state.dismissed);
  }

  // A deep copy of the pill keeps its data attributes but not its listeners: only nodes built here are live.
  const livePills = new WeakSet();

  function buildPill(incident) {
    const { name, detail } = R.pillText(incident, state.view.snapshot, location.pathname);
    const sev = incident.impact === "minor" ? "minor" : "major";
    const full = `GitHub Status: ${name}, ${detail}`;
    const open = el("button", { type: "button", class: "ghgs-pill-main", "aria-label": `${full}. Open details`, popovertarget: PANEL_ID });
    open.append(icon(sev), el("span", { class: "ghgs-pill-name", text: name }), el("span", { class: "ghgs-pill-detail", text: detail }), el("span", { class: "ghgs-pill-link", text: "Details" }));
    const close = el("button", { type: "button", class: "ghgs-pill-close", "aria-label": `Dismiss notice: ${name}, ${detail}` });
    close.append(closeIcon());
    close.addEventListener("click", () => dismiss(incident));
    const pill = el("div", { id: PILL_ID, class: `ghgs-pill ghgs-${sev}`, role: "group", "aria-label": "GitHub Status notice" }, open, close);
    pill.dataset.incident = incident.id;
    pill.dataset.at = incident.updatedAt;
    pill.dataset.path = location.pathname;
    livePills.add(pill);
    return pill;
  }

  function ensurePill(header) {
    const notice = currentNotice();
    const search = notice ? findSearch(header) : null;
    const old = document.getElementById(PILL_ID);
    if (!notice || !search) {
      old?.remove();
      return;
    }
    const fresh = !old || old.dataset.incident !== notice.id || old.dataset.at !== notice.updatedAt || old.dataset.path !== location.pathname;
    let pill = old;
    if (fresh || !livePills.has(old)) {
      old?.remove();
      pill = buildPill(notice);
    }
    if (search.previousElementSibling !== pill) search.before(pill);
    fitPill(pill, search);
  }

  // Shows as much of the pill as its row has room for. The pill is measured at its natural width (shrinking
  // off): it fits when that adds no overflow to the row and does not crush a neighbour's content. The room is
  // the row's, never the width the pill was shrunk to. A neighbour that only gives up spare room (a growing
  // spacer or a flexible group) is not crushed: only one whose content starts to overflow its box is.
  function fitPill(pill, search) {
    const row = pill.parentElement;
    const TOL = 2; // scrollWidth and clientWidth are rounded separately, so 1px of "overflow" can be rounding alone
    const clip = (n) => Math.max(0, n.scrollWidth - n.clientWidth);
    const fits = () => {
      // The row's siblings count too: the header's start region (logo, breadcrumb) shrinks when the actions grow.
      const regions = [...(row.parentElement?.children || [])].filter((n) => n !== row);
      // Their children count as well: the breadcrumb is a child of the start region and is what gets emptied.
      const others = [...[...row.children].filter((n) => n !== pill), ...regions, ...regions.flatMap((n) => [...n.children])];
      // The baseline is taken with the pill out of the layout, or a neighbour it already squeezed would count as clipped.
      pill.style.display = "none";
      const before = others.map((n) => ({ clip: clip(n), w: n.getBoundingClientRect().width }));
      const base = row.scrollWidth - row.clientWidth; // a row can overflow without us (a hidden or positioned child)
      pill.style.display = "";
      pill.classList.add("ghgs-measure");
      // The gap-less fallback margin is part of what the pill needs, so it is measured with the pill, not added after.
      keepGap(pill, search);
      const overflow = row.scrollWidth - row.clientWidth - Math.max(0, base);
      // Crushed: the pill made the neighbour both narrower and more clipped. A neighbour whose width did not
      // change is not squeezed by us, whatever its scrollWidth does (positioned or hidden children).
      // A neighbour that collapses to nothing is crushed too, even when it hides its content without clipping it.
      const crushed = others.findIndex((n, i) => {
        const w = n.getBoundingClientRect().width;
        return w < before[i].w - TOL && (clip(n) > before[i].clip + TOL || (w < 8 && before[i].w >= 8 + TOL));
      });
      if (overflow > TOL) return `overflow ${overflow}`;
      if (crushed >= 0) return `crushed ${others[crushed].className || others[crushed].tagName}`;
      // Overflowing to the left does not show in the row's scrollWidth: the pill must not sit over the logo or breadcrumb.
      const pr = pill.getBoundingClientRect();
      const over = regions.flatMap((n) => [...n.children]).find((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left < pr.right - TOL && r.right > pr.left + TOL && r.top < pr.bottom - TOL && r.bottom > pr.top + TOL;
      });
      if (over) return `over ${over.className || over.tagName}`;
      // The row may still squeeze the pill itself (live: the name collapsed to 0px and "Details" painted over the close button), so
      // the pill as laid out must show the whole name and have nothing clipped in its main button.
      // Checked at the natural width (ghgs-measure still on): the shrinkable pill would be sized by the neighbours' spare room.
      if (pill.classList.contains("ghgs-noname")) return ""; // icon and close only: nothing left to drop inside the pill
      const main = pill.querySelector(".ghgs-pill-main");
      const name = pill.querySelector(".ghgs-pill-name");
      if (name && !(name.clientWidth > 0 && clip(name) <= TOL)) return `name ${name.clientWidth}/${name.scrollWidth}`;
      if (main && clip(main) > TOL) return `main ${main.clientWidth}/${main.scrollWidth}`;
      if (clip(pill) > TOL) return `pill ${pill.clientWidth}/${pill.scrollWidth}`;
      return "";
    };
    pill.classList.remove("ghgs-nolink", "ghgs-nodetail", "ghgs-noname", "ghgs-hidden", "ghgs-measure");
    if (!row) return;
    // Parts go in order: the "Details" link, the detail word, the name (icon and close stay, the aria-labels keep the text).
    // A row where even that overflows or crushes a native control gets no pill at all; the
    // next scan tries again. The first check that failed at each step is kept in data-fit, to read what a real header does.
    const why = [];
    for (const step of ["", "ghgs-nolink", "ghgs-nodetail", "ghgs-noname"]) {
      if (step) pill.classList.add(step);
      const reason = fits();
      why.push(reason || "ok");
      if (!reason) {
        // A pill that fits at its natural width keeps it: ghgs-measure stays on so the row cannot shrink it later.
        pill.dataset.fit = why.join(" | ");
        return;
      }
    }
    pill.dataset.fit = why.join(" | ");
    pill.classList.remove("ghgs-measure");
    pill.classList.add("ghgs-hidden");
    pill.style.marginInlineEnd = "";
  }

  // The row's own gap spaces the pill from the search control. Only when the row has none (the pill sits
  // in a gap-less group) is the shortfall to the header's 8px added as a margin on the pill.
  const WANTED_GAP = 8;
  function keepGap(pill, search) {
    pill.style.marginInlineEnd = "";
    const p = pill.getBoundingClientRect();
    const q = search.getBoundingClientRect();
    if (!p.width || !q.width) return;
    const rtl = getComputedStyle(pill).direction === "rtl";
    const space = rtl ? p.left - q.right : q.left - p.right;
    if (space < WANTED_GAP - 0.5) pill.style.marginInlineEnd = `${Math.round((WANTED_GAP - space) * 100) / 100}px`;
  }

  // Older versions drew a 2px rule across the header and made it position: relative.
  function removeLegacyLine(header) {
    document.getElementById(LINE_ID)?.remove();
    if (header && header.dataset.ghgsPositioned) {
      header.style.position = "";
      delete header.dataset.ghgsPositioned;
    }
  }

  async function dismiss(incident) {
    state.dismissed = { ...state.dismissed, [incident.id]: incident.updatedAt };
    try {
      await chrome.storage.local.set({ ghgsDismissed: R.pruneDismissed(state.dismissed, state.view.snapshot) });
    } catch {}
    scan();
    document.getElementById(DOT_ID)?.focus();
  }

  // --- panel -------------------------------------------------------------------

  function section(title) {
    return el("h3", { class: "ghgs-h", text: title });
  }

  function renderPanel(panel) {
    const s = dotState();
    const snap = state.view.snapshot;
    panel.dataset.sig = panelSig();
    panel.replaceChildren();
    const head = el("div", { class: "ghgs-head" }, el("span", { class: "ghgs-dot-mark", "data-state": s, "aria-hidden": "true" }), el("strong", { text: "GitHub Status" }), el("span", { class: "ghgs-state", text: stateText(s) }));
    const meta = el("p", { class: "ghgs-meta" });
    // The ages are rewritten in place by refreshPanel, so the text comes from a function.
    meta.ageText = () => (snap && s !== "unknown" ? `Checked ${agoText(state.view.fetchedAt)}${snap.updatedAt && clock(snap.updatedAt) ? ` · Updated by GitHub ${clock(snap.updatedAt)}` : ""}` : "");
    meta.textContent = meta.ageText();
    panel.append(head);

    if (s === "unknown" && !state.loaded) {
      panel.append(el("p", { class: "ghgs-meta", text: "Checking githubstatus.com…" }));
    } else if (s === "unknown") {
      const lost = el("p", { class: "ghgs-meta" });
      lost.ageText = () => (state.view.fetchedAt ? `Last verified ${agoText(state.view.fetchedAt)}. githubstatus.com could not be reached.` : "githubstatus.com could not be reached.");
      lost.textContent = lost.ageText();
      panel.append(lost);
      const retry = el("button", { type: "button", class: "ghgs-retry", text: "Retry" });
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        await refresh(true);
        retry.disabled = false;
      });
      panel.append(retry);
      if (snap) panel.append(el("p", { class: "ghgs-note", text: "Showing nothing rather than an outdated “all good”." }));
    } else {
      panel.append(meta);
      if (!snap.components.length && !snap.incidents.length && !snap.maintenances.length) {
        panel.append(el("p", { class: "ghgs-note", text: "No incident reported on githubstatus.com — this is not a guarantee that everything works." }));
      }
      if (snap.components.length) {
        panel.append(section("Affected components"));
        const ul = el("ul", { class: "ghgs-list" });
        for (const c of snap.components) ul.append(el("li", {}, el("span", { text: c.name }), el("span", { class: "ghgs-comp-state", text: COMPONENT_WORDS[c.status] || c.status })));
        panel.append(ul);
      }
      const incidentBlock = (i, label) => {
        const box = el("div", { class: "ghgs-incident" });
        box.append(el("div", { class: "ghgs-incident-title" }, el("strong", { text: i.name }), i.status ? el("span", { class: "ghgs-tag", text: i.status.replace(/_/g, " ") }) : null));
        if (i.latest && i.latest.body) box.append(el("p", { class: "ghgs-quote", text: `“${i.latest.body}”${clock(i.latest.at) ? ` · ${clock(i.latest.at)}` : ""}` }));
        if (i.url) box.append(el("a", { href: i.url, target: "_blank", rel: "noopener noreferrer", text: "Incident page ↗" }));
        return box;
      };
      if (snap.incidents.length) {
        panel.append(section("Open incidents"));
        for (const i of snap.incidents) panel.append(incidentBlock(i));
      }
      if (snap.maintenances.length) {
        panel.append(section("Maintenance in progress"));
        for (const m of snap.maintenances) panel.append(incidentBlock(m));
      }
    }
    panel.append(el("p", { class: "ghgs-foot" }, el("span", { text: "GitHub Status · via GH Reloaded" }), el("a", { href: "https://www.githubstatus.com/", target: "_blank", rel: "noopener noreferrer", text: "githubstatus.com ↗" })));
  }

  // Storage hands objects back with sorted keys, a fresh fetch does not: compare by content, not by key order.
  function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
    return JSON.stringify(v);
  }

  function panelSig() {
    // What the panel shows, not when it was fetched: an unchanged refresh must not redraw it.
    return `${dotState()}|${state.loaded}|${state.view.error}|${stable(state.view.snapshot)}`;
  }

  function placePanel(panel) {
    const dot = document.getElementById(DOT_ID);
    if (!dot) return;
    const r = dot.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    panel.style.width = width + "px";
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + "px";
    panel.style.top = Math.max(8, r.bottom + 6) + "px";
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = el("div", { id: PANEL_ID, class: "ghgs-panel", popover: "auto", role: "dialog", "aria-label": "GitHub Status" });
      // The dot and the pill are the panel's invokers (popovertarget), so a second click closes it
      // and the browser gives the focus back only when it was inside the panel.
      panel.addEventListener("beforetoggle", (e) => {
        if (e.newState !== "open") return;
        renderPanel(panel);
        placePanel(panel);
      });
      panel.addEventListener("toggle", (e) => {
        document.getElementById(DOT_ID)?.setAttribute("aria-expanded", String(e.newState === "open"));
      });
      document.body.append(panel);
      window.addEventListener("resize", () => {
        if (panel.matches(":popover-open")) placePanel(panel);
      });
    }
    return panel;
  }

  // The open panel is redrawn only when what it shows changed, never on every scan or minute: a redraw
  // would drop the focus and the selection inside it. The "checked N min ago" text is updated in place.
  function refreshPanel(panel) {
    if (panel.dataset.sig !== panelSig()) {
      renderPanel(panel);
      return;
    }
    for (const m of panel.querySelectorAll(".ghgs-meta")) {
      if (!m.ageText) continue;
      const t = m.ageText();
      if (m.textContent !== t) m.textContent = t;
    }
  }

  // --- scan -----------------------------------------------------------------------

  function removeAll() {
    const header = findHeader();
    document.getElementById(DOT_ID)?.remove();
    for (const l of document.querySelectorAll("[data-ghgs-logo]")) l.removeAttribute("data-ghgs-logo");
    document.getElementById(PILL_ID)?.remove();
    removeLegacyLine(header);
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      try { panel.hidePopover(); } catch {}
      panel.remove();
    }
  }

  function scan() {
    if (!extensionAlive()) return;
    if (!state.enabled) return removeAll();
    const header = findHeader();
    if (!header) return;
    state.path = location.pathname;
    removeLegacyLine(header);
    ensureDot(header);
    ensurePill(header);
    const panel = ensurePanel();
    if (panel.matches(":popover-open")) refreshPanel(panel);
  }

  let scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 120);
  }

  // --- data ---------------------------------------------------------------------

  // Due when the last check failed, or the snapshot (not our last question)
  // is REFRESH_MS old: a tab opened just before the shared cache expired gets
  // an almost-stale snapshot and must ask again soon.
  function refreshDue() {
    if (state.view.error) return true;
    const since = state.view.fetchedAt || state.lastAsk;
    return Date.now() - since >= REFRESH_MS;
  }

  async function refresh(force = false) {
    if (!state.enabled || !extensionAlive()) return;
    state.lastAsk = Date.now();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload: { force } });
    } catch {
      res = null;
    }
    if (res && res.ok) state.view = { snapshot: res.snapshot || null, fetchedAt: res.fetchedAt || 0, error: !!res.error };
    else state.view = { ...state.view, error: true };
    state.loaded = true;
    if (state.view.snapshot) {
      const pruned = R.pruneDismissed(state.dismissed, state.view.snapshot);
      if (Object.keys(pruned).length !== Object.keys(state.dismissed).length) {
        state.dismissed = pruned;
        try { await chrome.storage.local.set({ ghgsDismissed: pruned }); } catch {}
      }
    }
    scan();
  }

  async function init() {
    if (!extensionAlive()) return;
    const stored = await chrome.storage.local.get(["ghgsEnabled", "ghgsNotice", "ghgsDismissed"]);
    state.enabled = stored.ghgsEnabled !== false;
    state.notice = stored.ghgsNotice !== false;
    state.dismissed = stored.ghgsDismissed && typeof stored.ghgsDismissed === "object" ? stored.ghgsDismissed : {};
    if (state.enabled && !document.hidden) refresh();
    scan();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.ghgsEnabled) {
        state.enabled = changes.ghgsEnabled.newValue !== false;
        if (state.enabled && !document.hidden) refresh();
      }
      if (changes.ghgsNotice) state.notice = changes.ghgsNotice.newValue !== false;
      if (changes.ghgsDismissed) state.dismissed = changes.ghgsDismissed.newValue && typeof changes.ghgsDismissed.newValue === "object" ? changes.ghgsDismissed.newValue : {};
      scan();
    });

    new MutationObserver(() => {
      if (!state.enabled) return;
      scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true });
    // A theme change moves the header colour without any DOM insertion: repaint the ring.
    new MutationObserver(scheduleScan).observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode", "data-light-theme", "data-dark-theme"] });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleScan);
    for (const ev of ["turbo:load", "popstate", "pageshow", "resize"]) window.addEventListener(ev, scheduleScan);
    // Same-document navigations (history.pushState) re-evaluate the page at once.
    if (window.navigation) window.navigation.addEventListener("navigatesuccess", scheduleScan);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !state.enabled) return;
      if (refreshDue()) {
        // Repaint first: a snapshot older than the freshness window must not stay green while the request is out.
        scan();
        refresh();
      }
    });
    // Keeps "checked N min ago" and the unverified state honest, and
    // refreshes while the tab is visible.
    setInterval(() => {
      if (!state.enabled || document.hidden) return;
      // While the last check failed, ask on every tick: the background answers
      // from its cache until its own backoff (30 s, 60 s, ...) has elapsed.
      if (refreshDue()) refresh();
      else scan();
    }, TICK_MS);
  }

  init();
})();
