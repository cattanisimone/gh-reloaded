// features/actions-log-shortcuts/content.js — Actions log shortcuts: a small
// row above the content of a GitHub Actions run or job page with
//
//  - "Copy gh command": copies a ready `gh run view ...` command. No request,
//    no token in the text.
//  - "Open raw log" (job pages only): opens the page's own "View raw logs"
//    link in a new tab, shown only when the background says the user's token
//    can read that repository's Actions logs.
//
// The extension never reads log content. Pure rules live in model.js
// (globalThis.GHALS_MODEL). A missing anchor means no row: the next scan
// retries, there is no fallback container.

(function () {
  const M = globalThis.GHALS_MODEL;
  if (!M) return;

  const KEY_ENABLED = "ghalsEnabled";
  const FIRST_PAINT_MS = 1500;
  const SCAN_MS = 250;
  const STATE_TTL_MS = 60_000;

  let enabled = true;
  let scanTimer = null;
  const known = new Map(); // owner/repo -> { state, at }: what detection last said, for the first paint
  const live = new WeakSet(); // rows this script built: a Turbo snapshot clone has the markup but no listeners
  const asked = new Set(); // `${path}|${owner/repo}` already asked on this page view

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // --- reading the page -------------------------------------------------

  function anchorFor(route) {
    if (route.kind === "job") {
      const logs = document.getElementById("logs");
      const column = logs && /CheckRun/.test(logs.className) ? logs.parentElement : null;
      return column ? { parent: column, before: column.firstElementChild } : null;
    }
    const card = document.querySelector(".actions-workflow-stats");
    return card && card.parentElement ? { parent: card.parentElement, before: card } : null;
  }

  function jobStatus() {
    const header = document.querySelector(".CheckRun-header");
    if (!header) return "unknown";
    const line = header.querySelector("span.js-updatable-content") || header.querySelector("span.d-block.f6") || header.querySelector(".CheckRun-log-title > span:last-child");
    return M.readJobStatus(line ? line.textContent : "");
  }

  function runStatus() {
    const icon = document.querySelector('[class*="actions-workflow-runs-status"] [aria-label]');
    let value = "";
    const card = document.querySelector(".actions-workflow-stats");
    if (card) {
      for (const n of card.querySelectorAll("span, div, dt, h4")) {
        if (n.children.length === 0 && n.textContent.trim() === "Status") {
          const sib = n.nextElementSibling || (n.parentElement && n.parentElement.nextElementSibling);
          if (sib) value = sib.textContent;
          break;
        }
      }
    }
    return M.readRunStatus(icon ? icon.getAttribute("aria-label") : "", value);
  }

  function attemptLinks() {
    return [...document.querySelectorAll("nav a")].map((a) => ({
      text: a.textContent,
      href: a.getAttribute("href") || "",
      hidden: !!a.closest('[role="menu"], #attempt-navigation-list, [hidden]'),
    }));
  }

  function rawLink(route) {
    const re = new RegExp(`/${route.owner}/${route.repo}/commit/[0-9a-f]{7,40}/checks/${route.job}/logs$`, "i");
    for (const a of document.querySelectorAll('a[href*="/checks/"][href$="/logs"], a.js-steps-dropdown-raw-logs')) {
      let path = "";
      try {
        path = new URL(a.getAttribute("href") || "", location.origin).pathname;
      } catch {
        continue;
      }
      if (re.test(path)) return a;
    }
    return null;
  }

  // --- the row ----------------------------------------------------------

  function currentRow() {
    return document.querySelector(".ghals-row");
  }

  // Run page, narrow layout: the row's left edge follows the first glyph of
  // the Summary card, measured, so no inset is hardcoded.
  function fitRun(row) {
    if (!row || !row.classList.contains("ghals-run")) return;
    row.style.removeProperty("padding-left");
    if (window.innerWidth > 768) return;
    const card = document.querySelector(".actions-workflow-stats");
    if (!card) return;
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const t = w.nextNode();
    if (!t) return;
    const rg = document.createRange();
    rg.selectNodeContents(t);
    const glyph = rg.getBoundingClientRect();
    if (!glyph.width) return;
    row.style.paddingLeft = "0px";
    const inset = glyph.left - row.getBoundingClientRect().left;
    row.style.paddingLeft = `${Math.max(0, Math.round(inset * 10) / 10)}px`;
  }

  function removeRow() {
    for (const r of document.querySelectorAll(".ghals-row")) r.remove();
  }

  function newRow(route, path, anchor) {
    const row = el("div", `ghals-row ghals-${route.kind}`);
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Log shortcuts");
    row.dataset.path = path;
    row.dataset.painted = "no";
    // The live region exists, empty, before any click: a region created and
    // filled in the same tick is often not announced by screen readers.
    const box = el("span", "ghals-msg");
    box.setAttribute("role", "status");
    row.appendChild(box);
    live.add(row);
    anchor.parent.insertBefore(row, anchor.before);
    return row;
  }

  function button(label, onClick) {
    const b = el("button", "ghals-btn", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  const OK_MESSAGE_MS = 3000;
  const sayTimers = new WeakMap();

  function say(row, text, kind, command) {
    const box = row.querySelector(".ghals-msg");
    if (!box) return;
    clearTimeout(sayTimers.get(row));
    box.className = `ghals-msg ${kind || ""}`;
    box.textContent = text;
    if (kind === "ok") sayTimers.set(row, setTimeout(() => say(row, ""), OK_MESSAGE_MS));
    row.querySelector(".ghals-cmd")?.remove();
    if (command) {
      const input = el("input", "ghals-cmd");
      input.type = "text";
      input.readOnly = true;
      input.value = command;
      input.setAttribute("aria-label", "gh command");
      row.appendChild(input);
      input.focus();
      input.select();
    }
  }

  function commandNow(route) {
    const status = route.kind === "job" ? jobStatus() : runStatus();
    return M.buildCommand(route, M.flagFor(status), M.readAttempt(attemptLinks(), route));
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = el("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function paint(row, route, withOpen) {
    row.dataset.painted = "yes";
    row.querySelector(".ghals-copy, .ghals-open")?.remove();
    for (const b of row.querySelectorAll(".ghals-btn")) b.remove();
    const copyBtn = button("Copy gh command", async () => {
      const cmd = commandNow(route);
      if (await copy(cmd)) say(row, "Copied", "ok");
      else say(row, "Copy failed", "err", cmd);
    });
    copyBtn.classList.add("ghals-copy");
    row.insertBefore(copyBtn, row.firstChild);
    if (withOpen) {
      const openBtn = button("Open raw log", async () => {
        const link = rawLink(route);
        const res = link ? await send("GHALS_OPEN", { href: link.getAttribute("href"), path: route.path }) : null;
        if (res && res.state) known.set(`${route.owner}/${route.repo}`.toLowerCase(), { state: res.state, at: Date.now() });
        if (!res || !res.opened) say(row, "Could not open log", "err");
        else say(row, "");
      });
      openBtn.classList.add("ghals-open");
      row.insertBefore(openBtn, copyBtn.nextSibling);
    }
  }

  function clearButtons(row) {
    for (const b of row.querySelectorAll(".ghals-btn")) b.remove();
    row.dataset.painted = "no";
  }

  // --- scanning ---------------------------------------------------------

  function scan() {
    if (!extensionAlive()) return;
    const path = location.pathname;
    const route = enabled ? M.parseRoute(path) : null;
    if (route) route.path = path;
    if (!route) return removeRow();
    const anchor = anchorFor(route);
    if (!anchor) return removeRow();

    let row = currentRow();
    if (row && (row.dataset.path !== path || row.parentElement !== anchor.parent || !live.has(row))) {
      removeRow();
      row = null;
    }
    if (!row) row = newRow(route, path, anchor);
    fitRun(row);

    const status = route.kind === "job" ? jobStatus() : runStatus();
    if (!M.showCopy(status)) {
      if (row.dataset.painted === "yes") clearButtons(row);
      return;
    }
    if (row.dataset.painted === "yes") return;

    if (route.kind !== "job") return paint(row, route, false);

    const key = `${route.owner}/${route.repo}`.toLowerCase();
    const link = rawLink(route);
    const askKey = `${path}|${key}`;
    const cached = known.get(key);
    const fresh = cached && Date.now() - cached.at < STATE_TTL_MS;
    if (!fresh) asked.delete(askKey); // a stale answer must be asked again
    const ask = () => {
      asked.add(askKey);
      return send("GHALS_DETECT", { path }).then((res) => {
        if (res && res.state) known.set(key, { state: res.state, at: Date.now() });
        return res;
      });
    };
    if (fresh) {
      if (!asked.has(askKey)) asked.add(askKey);
      return paint(row, route, !!link && cached.state === "ok");
    }
    if (!link) {
      if (!asked.has(askKey)) ask();
      return paint(row, route, false);
    }
    if (row.dataset.pending === "yes") return;
    row.dataset.pending = "yes";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (!row.isConnected || row.dataset.path !== path) return;
      const k = known.get(key);
      paint(row, route, !!rawLink(route) && !!k && k.state === "ok" && Date.now() - k.at < STATE_TTL_MS);
    };
    setTimeout(finish, FIRST_PAINT_MS);
    (asked.has(askKey) ? Promise.resolve() : ask()).then(finish);
  }

  function queue() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_MS);
  }

  function start() {
    try {
      chrome.storage.local.get({ [KEY_ENABLED]: true }, (o) => {
        enabled = o[KEY_ENABLED] !== false;
        scan();
      });
      chrome.storage.onChanged.addListener((changes) => {
        if (changes[KEY_ENABLED]) {
          enabled = changes[KEY_ENABLED].newValue !== false;
          scan();
        }
        if (changes.githubTokens || changes.defaultTokenId) {
          known.clear();
          asked.clear();
        }
      });
    } catch {
      return;
    }
    for (const ev of ["turbo:render", "turbo:load", "pjax:end", "popstate"]) document.addEventListener(ev, queue);
    window.addEventListener("popstate", queue);
    window.addEventListener("resize", queue);
    new MutationObserver(queue).observe(document.documentElement, { childList: true, subtree: true });
    // A route change that swaps no DOM (history.pushState alone) fires no mutation: watch the path too.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        queue();
      }
    }, 400);
  }

  start();
})();
