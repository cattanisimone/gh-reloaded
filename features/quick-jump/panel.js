// features/quick-jump/panel.js — the Quick jump dialog: the DOM, the keyboard and the rendering of
// the sections the model builds. It knows nothing about chrome.*: content.js hands it `env`
// ({ state, request, goto, openSettings }) and it answers with a handle to close or refresh the panel.
// Exposed as globalThis.GHQJ_PANEL.

(function () {
  const M = () => globalThis.GHQJ_MODEL;
  const NS = "http://www.w3.org/2000/svg";
  const PATHS = {
    issue: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
    pull: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
    repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
    search: "M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z",
    link: "M4.53 4.75A.75.75 0 0 1 5.28 4h6.01a.75.75 0 0 1 .75.75v6.01a.75.75 0 0 1-1.5 0v-4.2l-5.26 5.261a.749.749 0 0 1-1.154-.114.749.749 0 0 1-.114-.946L9.43 5.5H5.28a.75.75 0 0 1-.75-.75Z",
  };
  const ICON = { issue: "issue", pull: "pull", repo: "repo", link: "link", search: "search" };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svg(kind) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("width", "16");
    s.setAttribute("height", "16");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", `ghqj-svg ghqj-svg-${kind}`);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", PATHS[kind] || PATHS.link);
    s.appendChild(p);
    return s;
  }

  // Text with the matched ranges wrapped in <mark>.
  function highlighted(text, ranges, cls) {
    const out = el("span", cls);
    let at = 0;
    for (const [a, b] of ranges || []) {
      if (a > at) out.append(text.slice(at, a));
      out.appendChild(el("mark", "ghqj-hl", text.slice(a, b)));
      at = b;
    }
    if (at < text.length) out.append(text.slice(at));
    return out;
  }

  // The variant of GitHub's header the native quick search follows: signed in unless the page says otherwise.
  function headerVariant() {
    const meta = document.querySelector('meta[name="user-login"]');
    return meta && !meta.content ? "signed-out" : "signed-in";
  }

  function open(env) {
    const m = M();
    const ctx = m.pageContext(env.pathname(), { notFound: env.notFound(), nwo: env.nwo() });
    const startHref = location.href;
    const opener = document.activeElement;
    let scope = ctx.scopes[0];
    let query = "";
    let data = null; // the last answer of the background for the scope: { lists, recent, ... }
    let view = null; // { groups, statusLines, none }
    let selected = 0;
    let moved = false; // the user moved the selection: a refresh keeps it on the same row
    let rows = [];
    let retryTimer = 0;
    let seq = 0;
    let closed = false;

    const root = el("div", `ghqj-root ghqj-${headerVariant()}`);
    root.setAttribute("data-ghqj", "");
    const panel = el("div", "ghqj-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Quick jump");

    // -- input
    const head = el("div", "ghqj-head");
    const box = el("div", "ghqj-box");
    box.appendChild(svg("search"));
    const input = el("input", "ghqj-input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-label", "Filter your work, or search GitHub");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", "ghqj-listbox");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.placeholder = "Filter your work, or search GitHub…";
    box.appendChild(input);
    head.appendChild(box);

    // -- scope
    const scopeBar = el("div", "ghqj-scope");
    scopeBar.appendChild(el("span", "ghqj-scope-label", "Scope"));
    const seg = el("div", "ghqj-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Scope");
    const segButtons = {};
    for (const s of ctx.scopes) {
      const b = el("button", "ghqj-seg-btn");
      b.type = "button";
      b.setAttribute("data-scope", s);
      b.tabIndex = -1;
      const full = m.scopeLabel(s);
      const short = m.scopeLabel(s, true);
      if (short !== full) b.append(el("span", "ghqj-seg-full", full), el("span", "ghqj-seg-short", short));
      else b.appendChild(el("span", "", full));
      b.addEventListener("click", () => {
        setScope(s);
        input.focus();
      });
      segButtons[s] = b;
      seg.appendChild(b);
    }
    scopeBar.appendChild(seg);
    if (ctx.scopes.length > 1) {
      const hint = el("span", "ghqj-tabhint");
      hint.append(el("kbd", "ghqj-kbd", "Tab"), " switch scope");
      scopeBar.appendChild(hint);
    }

    // -- list
    const list = el("div", "ghqj-list");
    list.id = "ghqj-listbox";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Results");

    // -- footer
    const foot = el("div", "ghqj-foot");
    const keys = el("span", "ghqj-keys");
    keys.append(
      el("span", "ghqj-key"), el("span", "ghqj-key"), el("span", "ghqj-key")
    );
    const k = keys.children;
    k[0].append(el("kbd", "ghqj-kbd", "↑↓"), el("span", "ghqj-keylabel", " move"));
    k[1].append(el("kbd", "ghqj-kbd", "↵"), el("span", "ghqj-keylabel", " open"));
    k[2].append(el("kbd", "ghqj-kbd", "Esc"), el("span", "ghqj-keylabel", " close"));
    const sc = el("span", "ghqj-shortcut");
    const scLabel = el("span", "ghqj-sc-label", "Shortcut ");
    const scKeys = el("kbd", "ghqj-kbd ghqj-sc-keys");
    const change = el("button", "ghqj-change", "Change");
    change.type = "button";
    change.addEventListener("click", () => env.openSettings("quick-jump"));
    sc.append(scLabel, scKeys, " · ", change);
    foot.append(keys, sc);

    const live = el("div", "ghqj-sr");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");

    panel.append(head, scopeBar, list, foot, live);
    root.appendChild(panel);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) {
        e.preventDefault();
        close();
      }
    });
    document.body.appendChild(root);

    function say(text) {
      live.textContent = "";
      setTimeout(() => {
        if (!closed) live.textContent = text;
      }, 30);
    }

    function renderFooter() {
      scKeys.textContent = m.footerShortcut(env.state());
    }

    function currentView() {
      if (!data) return null;
      const recent = data.recent || [];
      const common = { scope, ctx, lists: data.lists, recent, now: Date.now() };
      return query.trim()
        ? m.buildMatches({ ...common, query })
        : m.buildSections({ ...common, tokenName: data.tokenName, mappedOwners: data.mappedOwners, serving: data.serving });
    }

    function lineNode(l) {
      const p = el("p", "ghqj-line");
      p.setAttribute("data-line", l.id || "");
      if (l.link && l.text.includes(l.link)) {
        const [a, b] = l.text.split(l.link);
        p.append(a);
        const a2 = el("button", "ghqj-inline", l.link);
        a2.type = "button";
        a2.addEventListener("click", () => env.openSettings("tokens-section"));
        p.append(a2, b);
      } else p.textContent = l.text;
      return p;
    }

    function rowNode(r, idx) {
      const a = el("a", "ghqj-row");
      a.id = `ghqj-o-${idx}`;
      a.setAttribute("role", "option");
      a.setAttribute("aria-selected", "false");
      a.setAttribute("data-type", r.type);
      a.setAttribute("data-row", r.id);
      a.href = r.href;
      a.tabIndex = -1;
      const ico = el("span", "ghqj-ico");
      ico.appendChild(svg(ICON[r.type] || "link"));
      if (r.typeLabel) ico.appendChild(el("span", "ghqj-sr", `${r.typeLabel}. `));
      a.appendChild(ico);
      const main = el("span", "ghqj-main");
      const title = r.ranges ? highlighted(r.title, r.ranges.title, "ghqj-title") : el("span", "ghqj-title", r.title);
      if (r.bold) title.classList.add("ghqj-bold");
      main.appendChild(title);
      if (r.ctx) {
        const c = el("span", "ghqj-ctx");
        r.ctx.forEach((segText, i) => {
          if (i) c.append(" ");
          const s = el("span", "ghqj-seg-text");
          if (i === 0 && r.number && r.type !== "repo") {
            // owner/repo may be cut with an ellipsis, " #n" never is
            const cut = segText.lastIndexOf(" #");
            const repoText = segText.slice(0, cut);
            s.classList.add("ghqj-first");
            const rp = r.ranges ? highlighted(repoText, r.ranges.repo, "ghqj-repo") : el("span", "ghqj-repo", repoText);
            s.append(rp, el("span", "ghqj-num", segText.slice(cut)));
          } else s.textContent = segText;
          if (i < r.ctx.length - 1) s.appendChild(el("span", "ghqj-sep", "·"));
          c.appendChild(s);
        });
        main.appendChild(c);
      }
      a.appendChild(main);
      if (r.typeLabel || r.scopeNote) {
        const t = el("span", "ghqj-type", r.typeLabel || r.scopeNote);
        t.setAttribute("aria-hidden", "true");
        a.appendChild(t);
      }
      const enter = el("span", "ghqj-enter", "↵");
      enter.setAttribute("aria-hidden", "true");
      a.appendChild(enter);
      a.addEventListener("click", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        activate(a, e.ctrlKey || e.metaKey || e.shiftKey);
      });
      return a;
    }

    function render(keepId) {
      view = currentView();
      renderFooter();
      for (const [s, b] of Object.entries(segButtons)) {
        b.setAttribute("aria-pressed", String(s === scope));
        b.classList.toggle("ghqj-on", s === scope);
      }
      list.textContent = "";
      rows = [];
      if (!view) {
        list.appendChild(skeletonGroup());
        return;
      }
      const statusNode = () => {
        const st = el("div", "ghqj-status");
        for (const l of view.statusLines || []) {
          const p = el("p", "ghqj-line ghqj-statusline", l.text);
          p.setAttribute("data-line", l.id);
          st.appendChild(p);
        }
        return st;
      };
      if (view.none) {
        const none = el("div", "ghqj-none");
        none.append(el("p", "ghqj-line ghqj-line-strong", view.none.text), el("p", "ghqj-line", view.none.second));
        list.appendChild(none);
      }
      let statusShown = false;
      for (const g of view.groups) {
        const sec = el("div", "ghqj-group");
        sec.setAttribute("role", "group");
        if (g.title) {
          const h = el("div", "ghqj-gtitle");
          const id = `ghqj-g-${g.id}`;
          h.id = id;
          sec.setAttribute("aria-labelledby", id);
          h.appendChild(el("span", "", g.title));
          if (g.label) h.appendChild(el("span", "ghqj-glabel", g.label));
          sec.appendChild(h);
        } else sec.setAttribute("aria-label", "Search");
        const lines = (g.lines || []).map(lineNode);
        if (g.loading && !g.rows.some((r) => !r.fixed)) sec.appendChild(skeleton());
        // the empty and error lines of Your work sit under its title; the others after their rows
        if (g.id === "work") lines.forEach((l) => sec.appendChild(l));
        for (const r of g.rows) {
          const node = rowNode(r, rows.length);
          rows.push(node);
          sec.appendChild(node);
        }
        if (g.id !== "work") lines.forEach((l) => sec.appendChild(l));
        list.appendChild(sec);
        if (g.id === "work" || (!statusShown && g.id === "matches")) {
          if (view.statusLines?.length) list.appendChild(statusNode());
          statusShown = true;
        }
      }
      if (!statusShown && view.statusLines?.length) list.appendChild(statusNode());
      let idx = keepId && moved ? rows.findIndex((r) => r.getAttribute("data-row") === keepId) : -1;
      if (idx < 0) idx = view.none ? rows.length - 1 : 0;
      select(idx, false);
    }

    function skeleton() {
      const s = el("div", "ghqj-skeletons");
      s.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i++) s.appendChild(el("div", "ghqj-skel"));
      return s;
    }

    function skeletonGroup() {
      const g = el("div", "ghqj-group");
      const h = el("div", "ghqj-gtitle");
      h.appendChild(el("span", "", "Your work"));
      g.append(h, skeleton());
      return g;
    }

    function select(i, scroll = true) {
      if (!rows.length) {
        input.removeAttribute("aria-activedescendant");
        return;
      }
      selected = (i + rows.length) % rows.length;
      rows.forEach((r, n) => {
        const on = n === selected;
        r.setAttribute("aria-selected", String(on));
        r.classList.toggle("ghqj-sel", on);
      });
      input.setAttribute("aria-activedescendant", rows[selected].id);
      if (scroll) rows[selected].scrollIntoView({ block: "nearest" });
    }

    function activate(row, newTab) {
      if (!row) return;
      env.goto(row.href, newTab);
      if (!newTab) close(false);
    }

    async function load(phase) {
      const my = ++seq;
      let answer;
      try {
        answer = await env.request({ phase, scope, owner: scope === "repo" || scope === "owner" ? ctx.owner : "" });
      } catch {
        return;
      }
      if (closed || my !== seq) return;
      if (!answer || answer.active === false) {
        close(true);
        return;
      }
      data = answer;
      const keep = rows[selected]?.getAttribute("data-row");
      render(keep);
      if (phase === "cached") load("refresh");
      else scheduleRetry();
    }

    function scheduleRetry() {
      clearTimeout(retryTimer);
      if (!data) return;
      const waits = Object.values(data.lists || {}).filter((l) => l.status === "limited" || l.status === "error").map((l) => l.waitMs || m.MIN_WAIT_MS);
      if (!waits.length) return;
      retryTimer = setTimeout(() => !closed && load("refresh"), Math.min(...waits) + 250);
    }

    function setScope(s) {
      if (s === scope || !ctx.scopes.includes(s)) return;
      scope = s;
      data = null;
      selected = 0;
      moved = false;
      render();
      say(`Scope: ${m.scopeLabel(s)}`);
      load("cached");
    }

    function switchScope(dir) {
      const i = ctx.scopes.indexOf(scope);
      setScope(ctx.scopes[(i + dir + ctx.scopes.length) % ctx.scopes.length]);
    }

    function close(restore = true) {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("popstate", onNav);
      document.removeEventListener("turbo:load", onNav);
      window.removeEventListener("pagehide", onNav);
      navApi?.removeEventListener?.("navigate", onNav);
      navApi?.removeEventListener?.("navigatesuccess", onNav);
      root.remove();
      if (restore && opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
      env.closed(handle);
    }

    function onNav() {
      if (location.href !== startHref) close(false);
    }

    function onKey(e) {
      if (closed) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (!root.contains(e.target)) return;
      if (e.key === "ArrowDown") { e.preventDefault(); moved = true; select(selected + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moved = true; select(selected - 1); }
      else if (e.key === "Home" && e.target !== input) { e.preventDefault(); moved = true; select(0); }
      else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        activate(rows[selected], e.ctrlKey || e.metaKey);
      } else if (e.key === "Tab" && e.target === input) {
        if (ctx.scopes.length > 1) {
          e.preventDefault();
          switchScope(e.shiftKey ? -1 : 1);
        } else e.preventDefault();
      }
    }
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("popstate", onNav);
    document.addEventListener("turbo:load", onNav);
    window.addEventListener("pagehide", onNav);
    const navApi = window.navigation;
    navApi?.addEventListener?.("navigate", onNav);
    navApi?.addEventListener?.("navigatesuccess", onNav);

    input.addEventListener("input", () => {
      query = input.value;
      selected = 0;
      moved = false;
      render();
      if (view?.none) say("No matches in your work or recent items.");
    });
    // keep focus inside the dialog: anything focused outside returns to the input
    root.addEventListener("focusout", (e) => {
      if (closed) return;
      const to = e.relatedTarget;
      if (!to || !root.contains(to)) setTimeout(() => !closed && !root.contains(document.activeElement) && input.focus(), 0);
    });

    renderFooter();
    render();
    input.focus();
    load("cached");

    const handle = {
      close,
      isOpen: () => !closed,
      containsFocus: () => root.contains(document.activeElement),
      refreshFooter: renderFooter,
      root,
    };
    return handle;
  }

  globalThis.GHQJ_PANEL = { open };
})();
