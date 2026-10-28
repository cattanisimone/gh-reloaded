// features/notifications/panel.js — the in-page settings panel of the
// notifications modules: a "Triage ▾" button right after GitHub's own
// "Group by" control on the inbox, opening an anchored panel with the
// per-module switches, the triage layout, "Show native inbox" and "Restore
// defaults". The panel only writes preferences (prefs.js keys, one value per
// control); the registry decides what runs. It reads no GitHub data and
// shows the capability states the engine already has.
//
// The button is gated by the inbox route and the "Group by" anchor only, never
// by the engine, so "Show native inbox" is always reachable. The anchor is the
// visible text "Group by" and its nearest ancestor that is a direct child of
// the filter row; if it is missing nothing is inserted and the next scan
// retries (no other container is used).

(function (global) {
  const SVG = "http://www.w3.org/2000/svg";
  const GUTTER = 16;
  const GAP = 4;

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  }

  function caret() {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z");
    svg.append(path);
    return svg;
  }

  // The visible "Group by" control and the filter-row child that holds it. It
  // is missing on Saved, Done, Read and reason-filtered lists; there the
  // designed fallback is "Sort by", used only while "Group by" is absent.
  function findAnchor(doc) {
    return findControl(doc, /^\s*Group by\b/i) || findControl(doc, /^\s*Sort by\b/i);
  }

  function findControl(doc, label) {
    for (const b of doc.querySelectorAll("button, summary, [role='button']")) {
      if (b.closest(".ghnt-triage") || !label.test(b.textContent || "")) continue;
      let node = b;
      for (let depth = 0; node && node.parentElement && depth < 6; depth++, node = node.parentElement) {
        const parent = node.parentElement;
        if (parent.children.length >= 3 && /flex/.test(getComputedStyle(parent).display)) return node;
      }
    }
    return null;
  }

  // A schematic of one layout: decorative, drawn with Primer colours in CSS.
  function thumb(id) {
    const bar = (cls) => el("i", { class: cls });
    const rows = () => el("b", { class: "ghnt-t-rows" }, bar(""), bar(""), bar(""));
    const parts =
      id === "integrated" ? [el("b", { class: "ghnt-t-rail" }, bar(""), bar(""), bar("")), rows()]
      : id === "quickbar" ? [el("b", { class: "ghnt-t-pills" }, bar(""), bar(""), bar(""), bar("")), rows()]
      : [el("b", { class: "ghnt-t-heads" }, bar("ghnt-t-head"), bar("ghnt-t-head"), bar("ghnt-t-head"))];
    return el("span", { class: `ghnt-thumb ghnt-thumb-${id}`, "aria-hidden": "true" }, parts);
  }

  // Notes about missing data, from the capability states the engine reports.
  function capabilityNotes(state) {
    const caps = state.capabilities || {};
    const notes = [];
    const api = caps["api:notifications"];
    if (api === "not-tried" && state.phase === "ready") notes.push("No GitHub token is configured: reasons that need GitHub data are shown as \u201cUnverifiable\u201d.");
    else if (api === "missing-scope") notes.push("The Notifications API needs the notifications scope of a classic token: some reasons are shown as “Unverifiable”.");
    else if (api === "unavailable") notes.push("The Notifications API could not be read with your token: some reasons are shown as “Unverifiable”.");
    else if (api === "rate-limited") notes.push("GitHub's rate limit was reached: classifications update when it resets.");
    const owners = Object.entries(caps).filter(([k, v]) => k.startsWith("pr:") && (v === "no-token" || v === "denied")).map(([k]) => k.slice(3));
    if (owners.length) notes.push(`No token that can read ${owners.join(", ")}: its notifications are shown as “Unverifiable”.`);
    return notes;
  }

  function create({ registry, engine, prefs, route, storage, openSettings, getHref = () => location.href }) {
    let current = prefs.normalize({});
    let wrap = null;
    let button = null;
    let panel = null;
    let open = false;
    let unsubscribe = null;

    function isOpenOnInbox() {
      return open && !!panel;
    }

    // ---- storage: each control writes only its own value -------------------
    async function writeModule(id, value) {
      const got = await storage.get([prefs.KEYS.modules]);
      await storage.set({ [prefs.KEYS.modules]: prefs.patchModule(got[prefs.KEYS.modules], id, value) });
    }
    const writeNative = (value) => storage.set({ [prefs.KEYS.nativeInbox]: value === true });
    const writeLayout = (id) => storage.set({ [prefs.KEYS.layout]: prefs.normalizeLayout(id) });
    const restore = () => storage.remove(prefs.RESET_KEYS);

    // ---- the button ---------------------------------------------------------
    function buildButton() {
      button = el(
        "button",
        { type: "button", class: "Button Button--secondary Button--medium ghnt-triage-btn", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "ghnt-panel" },
        el("span", { class: "Button-content" }, el("span", { class: "Button-label", text: "Triage" })),
        el("span", { class: "Button-visual Button-trailingVisual" }, caret())
      );
      button.addEventListener("click", () => (open ? close() : openPanel()));
      wrap = el("div", { class: "ghnt-triage" }, button);
    }

    function ensureButton() {
      // A Turbo snapshot restore brings back a dead clone of an earlier button.
      for (const stray of document.querySelectorAll(".ghnt-triage")) if (stray !== wrap) stray.remove();
      if (wrap && wrap.isConnected) {
        const anchor = findAnchor(document);
        if (anchor && anchor.nextElementSibling === wrap) return;
        if (!anchor) return; // transient markup: keep what is there
      }
      const anchor = findAnchor(document);
      if (!anchor) return remove();
      if (!wrap) buildButton();
      anchor.after(wrap);
    }

    // ---- the panel ----------------------------------------------------------
    function switchRow(key, label, description, on, { disabled, note }) {
      const sw = el("button", { type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, class: "ghnt-switch", disabled, "data-ghnt-focus": key });
      return { sw, row: el("div", { class: "ghnt-row" }, el("div", { class: "ghnt-row-text" }, el("div", { class: "ghnt-row-title", text: label }), el("div", { class: "ghnt-hint", text: description }), note ? el("div", { class: "ghnt-note", text: note }) : null), sw) };
    }

    function build() {
      const list = new Map(registry.list().map((m) => [m.id, m]));
      const native = current.nativeInbox;
      const body = [];
      const active = registry.list().filter((m) => m.started).map((m) => m.label);

      body.push(el("div", { class: "ghnt-head" }, el("h2", { id: "ghnt-title", text: "Triage · Settings" }), el("p", { class: "ghnt-hint", text: `Preferences are saved in this browser.${active.length ? ` Active: ${active.join(", ")}` : ""}` })));

      const nativeRow = switchRow("native", "Show native inbox", native ? "GitHub's original inbox is shown. Your switches and layout are kept and come back when you turn this off." : "Temporarily shows GitHub's original UI", native, {});
      nativeRow.sw.addEventListener("click", () => writeNative(!native));
      body.push(el("section", { class: "ghnt-section" }, el("h3", { text: "Original view" }), nativeRow.row));

      const mods = [];
      for (const def of prefs.MODULES) {
        const reg = list.get(def.id);
        const available = !!reg && reg.availability === "available";
        let note = "";
        if (!reg) note = "Not available in this version.";
        else if (!available) note = reg.reason || "Not available right now.";
        else if (native) note = "Kept, paused while the native inbox is shown.";
        else if (def.id === "reasonWhy" && !(list.get("reasonTags") ? list.get("reasonTags").enabled : prefs.moduleOn(current.modules, "reasonTags"))) note = "Opens from a reason tag: turn Tags on to use it.";
        const on = reg ? reg.enabled : prefs.moduleOn(current.modules, def.id);
        const r = switchRow(def.id, def.label, def.description, on, { disabled: !available, note });
        r.sw.addEventListener("click", () => writeModule(def.id, !on));
        mods.push(r.row);
      }
      body.push(el("section", { class: "ghnt-section" }, el("h3", { text: "Modules" }), mods));

      const triage = list.get("triage");
      const layoutIds = triage && triage.availability === "available" ? triage.layouts.filter((id) => prefs.LAYOUTS.some((l) => l.id === id)) : [];
      const layoutSection = el("section", { class: "ghnt-section" }, el("h3", { id: "ghnt-layout-h", text: "Triage layout" }));
      if (!layoutIds.length) {
        layoutSection.append(el("p", { class: "ghnt-hint", text: "Layouts can be chosen once the Triage view is available." }));
      } else {
        layoutSection.append(el("p", { class: "ghnt-hint", text: "Pick one. The four categories are the same in every layout." }));
        const group = el("div", { class: "ghnt-cards", role: "radiogroup", "aria-labelledby": "ghnt-layout-h" });
        for (const l of prefs.LAYOUTS.filter((x) => layoutIds.includes(x.id))) {
          const checked = current.layout === l.id;
          const radio = el("input", { type: "radio", name: "ghnt-layout", value: l.id, checked, "data-ghnt-focus": `layout-${l.id}` });
          radio.checked = checked;
          radio.addEventListener("change", () => writeLayout(l.id));
          group.append(el("label", { class: "ghnt-card" + (checked ? " is-selected" : "") }, thumb(l.id), el("span", { class: "ghnt-card-title" }, radio, el("span", { text: l.label }), l.id === prefs.DEFAULT_LAYOUT ? el("span", { class: "ghnt-default", text: "\u2713 Default" }) : null), el("span", { class: "ghnt-hint", text: l.description })));
        }
        layoutSection.append(group);
      }
      body.push(layoutSection);

      // Only while the engine runs: it is the only source of these states.
      if (engine.isActive()) {
        const notes = capabilityNotes(engine.getState());
        const cov = el("section", { class: "ghnt-section" }, el("h3", { text: "Coverage and permissions" }), el("p", { class: "ghnt-hint", text: "Counts cover the loaded notifications only. When data is missing a notification is “Unverifiable”." }));
        for (const n of notes) cov.append(el("p", { class: "ghnt-warn", text: n }));
        if (notes.length) {
          const link = el("button", { type: "button", class: "ghnt-link", text: "Settings → GitHub tokens", "data-ghnt-focus": "settings" });
          link.addEventListener("click", openSettings);
          cov.append(el("p", { class: "ghnt-hint" }, "A dedicated Notifications permissions page is not part of this version. Check your token in ", link, "."));
        }
        body.push(cov);
      }

      const reset = el("button", { type: "button", class: "Button Button--secondary Button--medium ghnt-reset", text: "Restore defaults", "data-ghnt-focus": "reset" });
      reset.addEventListener("click", restore);
      body.push(el("div", { class: "ghnt-foot" }, reset));
      return body;
    }

    function render() {
      if (!panel) return;
      const focused = panel.contains(document.activeElement) ? document.activeElement.getAttribute("data-ghnt-focus") : null;
      const scroll = panel.scrollTop;
      panel.replaceChildren(...build());
      panel.scrollTop = scroll;
      if (focused) panel.querySelector(`[data-ghnt-focus="${focused}"]`)?.focus();
      position();
    }

    function position() {
      if (!panel || !button.isConnected) return;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const width = Math.min(380, vw - 2 * GUTTER);
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${vh - 2 * GUTTER}px`;
      const rect = button.getBoundingClientRect();
      const left = Math.max(GUTTER, Math.min(rect.right - width, vw - GUTTER - width));
      const height = panel.offsetHeight;
      const top = Math.max(GUTTER, Math.min(rect.bottom + GAP, vh - GUTTER - height));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    }

    const onKey = (e) => {
      if (e.key === "Escape" && open) {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointer = (e) => {
      if (open && !panel.contains(e.target) && !wrap.contains(e.target)) close();
    };
    const onViewport = () => position();

    function openPanel() {
      if (open || !button) return;
      panel = el("div", { id: "ghnt-panel", class: "ghnt-panel", role: "dialog", "aria-labelledby": "ghnt-title" });
      document.body.append(panel);
      open = true;
      button.setAttribute("aria-expanded", "true");
      render();
      panel.querySelector("[data-ghnt-focus]")?.focus();
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", onPointer, true);
      window.addEventListener("resize", onViewport);
      window.addEventListener("scroll", onViewport, true);
      unsubscribe = [registry.onChange(render), engine.subscribe(render)];
    }

    function close(returnFocus) {
      if (!open) return;
      open = false;
      for (const off of unsubscribe || []) off?.();
      unsubscribe = null;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
      panel?.remove();
      panel = null;
      button?.setAttribute("aria-expanded", "false");
      if (returnFocus) button?.focus();
    }

    function remove() {
      close();
      wrap?.remove();
    }

    return {
      // Cheap enough for every scan: nothing but a route test off the inbox.
      sync() {
        if (!route.isInboxRoute(getHref())) return remove();
        ensureButton();
      },
      setPrefs(stored) {
        current = prefs.normalize(stored);
        render();
      },
      isOpen: isOpenOnInbox,
    };
  }

  global.GHNT_PANEL = { create, findAnchor, capabilityNotes };
})(typeof window !== "undefined" ? window : globalThis);
