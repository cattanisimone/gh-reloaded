// features/image-gallery/content.js — Image gallery: on a repository image
// file page, browse the other images of the same folder in a lightbox.
//
//  - A neutral "Gallery" button is the first child of the file header's
//    action group; an optional automatic opening shows the lightbox on arrival.
//  - The folder list comes from the page's own embedded data when it is valid
//    for this URL, otherwise from the background (Contents API). It never
//    fetches GitHub pages itself.
//  - Images are shown by the same same-origin URL GitHub uses; on failure the
//    background decides between a neutral, "removed" or "damaged" message.
//  - Nothing is stored for the "Open file on GitHub" suppression: the
//    background keeps it in memory for one navigation.
//
// Pure rules live in model.js (globalThis.GHIG_MODEL).

(function () {
  const M = globalThis.GHIG_MODEL;
  if (!M) return;

  const KEY_ENABLED = "ghigEnabled";
  const KEY_AUTO = "ghigAutoOpen";
  const POLL_MS = 800;
  const LOADING_MS = 350;
  const NARROW_PX = 767;

  let enabled = true;
  let autoOpen = true;
  let visit = null; // the current ordinary visit to an image file page
  let visitCounter = 0;
  let dialog = null; // the open lightbox, if any
  let observer = null;
  let layoutQueued = false;

  const SVG_IMAGE =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75ZM1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h.94l6.01-6.01a.75.75 0 0 1 1.06 0l4.74 4.74V2.75a.25.25 0 0 0-.25-.25ZM5.5 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/></svg>';

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

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // --- the page --------------------------------------------------------

  // The action group is the parent of GitHub's edit-and-raw-actions block
  // (and of its collapsed twin): a class-prefix-free anchor.
  function findGroup() {
    const actions = document.querySelector('[class*="react-blob-header-edit-and-raw-actions"]');
    return actions ? actions.parentElement : null;
  }

  // The route this URL is, or null when the feature must add nothing. An SVG
  // counts only in its Preview view (the selected segment decides, not the URL).
  function routeInfo() {
    const info = M.parseBlobPath(location.pathname);
    if (!info || !M.isSupportedImage(info.name)) return null;
    if (/\.svg$/i.test(info.name)) {
      const selected = document.querySelector('ul[aria-label="File view"] button[aria-pressed="true"]');
      if (!selected) return null;
      const label = selected.textContent.trim();
      if (label === "Code" || label === "Blame") return null;
    }
    return info;
  }

  function readEmbedded() {
    try {
      const node = document.querySelector('script[data-target="react-app.embeddedData"]');
      return node ? JSON.parse(node.textContent).payload || null : null;
    } catch {
      return null;
    }
  }

  function pageSaysPrivate(payload) {
    if (payload?.codeViewLayoutRoute?.repo?.private === true) return true;
    for (const l of document.querySelectorAll('#repository-container-header [class*="Label"], [data-testid="repo-title-component"] + span, [data-testid="repo-title-component"] ~ * [class*="Label"]')) {
      if (l.textContent.trim() === "Private") return true;
    }
    return false;
  }

  // The embedded folder tree is only valid for the file the page was loaded
  // on: it goes stale after an SPA navigation, so it is checked against the URL.
  function embeddedListing(info, payload) {
    const layout = payload?.codeViewLayoutRoute;
    const refName = layout?.refInfo?.name;
    if (!layout || !refName || typeof layout.path !== "string") return null;
    if (info.segments.join("/") !== `${refName}/${layout.path}`) return null;
    const node = payload.codeViewFileTreeLayoutRoute?.fileTree?.[M.dirOf(layout.path)];
    if (!node || !Array.isArray(node.items)) return null;
    const items = node.items;
    return {
      state: "ok",
      ref: refName,
      path: layout.path,
      entries: items.map((i) => ({ name: i.name, path: i.path, contentType: i.contentType })),
      incomplete: !M.isComplete(items.length, typeof node.totalCount === "number" ? node.totalCount : null),
    };
  }

  // --- visit ------------------------------------------------------------

  function startVisit(info) {
    const v = {
      id: ++visitCounter,
      key: location.pathname,
      info,
      status: "pending", // pending | ready | blocked
      notice: null, // key of model.noticeFor
      items: [],
      index: -1,
      ref: "",
      path: "",
      incomplete: false,
      interacted: false,
      suppressed: false,
      opened: false,
    };
    visit = v;

    const consume = send("GHIG_CONSUME", { url: location.pathname });
    const payload = readEmbedded();
    const embedded = embeddedListing(info, payload);
    const listing = embedded
      ? Promise.resolve(embedded)
      : send("GHIG_LIST", {
          owner: info.owner,
          repo: info.repo,
          segments: info.segments,
          privateHint: pageSaysPrivate(payload),
        });

    Promise.all([consume, listing]).then(([c, data]) => {
      if (visit !== v) return; // left the page: a late set is dropped
      v.suppressed = !!c?.suppressed;
      applyListing(v, data);
    });
  }

  function applyListing(v, data) {
    if (!data || data.ok === false) {
      // No answer from the worker, or it failed before classifying.
      v.status = "blocked";
      v.notice = !data || data.status === undefined || data.status >= 500 ? "error" : "unknown";
    } else if (data.state !== "ok") {
      v.status = "blocked";
      v.notice = data.state === "none" ? null : data.state;
    } else {
      v.ref = data.ref;
      v.path = data.path;
      v.incomplete = !!data.incomplete;
      v.items = M.imageSet(data.entries);
      v.index = v.items.findIndex((i) => i.path === data.path);
      if (v.index < 0) {
        v.status = "blocked";
        v.notice = v.incomplete ? "incomplete" : "not-in-list";
      } else {
        v.status = "ready";
        v.notice = v.incomplete ? "incomplete" : null;
      }
    }
    syncButton();
    queueLayout();
    if (v.status === "ready" && autoOpen && !v.suppressed && !v.interacted && !dialog) openGallery(true);
  }

  // Anything the user does on the page before the set arrives cancels the
  // automatic opening for this visit.
  function markInteraction() {
    if (visit) visit.interacted = true;
  }
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(type, (e) => e.isTrusted && markInteraction(), true);
  }
  window.addEventListener("scroll", (e) => e.isTrusted && markInteraction(), { passive: true, capture: true });

  // --- button, notice and layout ---------------------------------------

  let button = null;
  let description = null;
  let noticeEl = null;
  let lineEl = null;
  let rowEl = null;

  function ensureButton(group) {
    if (button && button.isConnected && button.parentElement === group && group.firstElementChild === button) return;
    button?.remove();
    description?.remove();
    button = el("button", "ghig-btn");
    button.type = "button";
    button.innerHTML = `${SVG_IMAGE}<span class="ghig-btn-label">Gallery</span>`;
    description = el("span", "ghig-sr");
    description.id = "ghig-btn-desc";
    button.setAttribute("aria-describedby", description.id);
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true" || !visit || visit.status !== "ready") return;
      openGallery(false);
    });
    group.insertBefore(description, group.firstChild);
    group.insertBefore(button, group.firstChild);
    observeRow(group.parentElement);
    syncButton();
  }

  function syncButton() {
    if (!button) return;
    const v = visit;
    const ready = v && v.status === "ready";
    button.setAttribute("aria-disabled", ready ? "false" : "true");
    button.title = ready ? "Open the images in this folder in the Gallery (GH Reloaded)" : "";
    if (!v || v.status === "pending") description.textContent = "Loading the folder list…";
    else if (v.notice) description.textContent = M.noticeFor(v.notice).description;
    else description.textContent = "Open the images in this folder in the Gallery (GH Reloaded)";

    const notice = v && v.notice ? M.noticeFor(v.notice) : null;
    if (!notice) {
      noticeEl?.remove();
      noticeEl = null;
      return;
    }
    if (!noticeEl) {
      noticeEl = el("span", "ghig-notice");
      noticeEl.setAttribute("role", "note");
    }
    noticeEl.dataset.kind = v.notice;
    noticeEl.title = notice.description;
  }

  function observeRow(row) {
    if (rowEl === row && observer) return;
    observer?.disconnect();
    rowEl = row;
    if (!row || typeof ResizeObserver === "undefined") return;
    observer = new ResizeObserver(queueLayout);
    observer.observe(row);
  }

  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }

  function textWidth(node, text) {
    node.querySelector(".ghig-notice-text").textContent = text;
    return node.scrollWidth;
  }

  // Where the button and the notice sit. Fit is decided by measuring our own
  // elements, never by fixed thresholds; native controls keep their boxes.
  function layout() {
    if (!button || !button.isConnected) return;
    const group = button.parentElement;
    const row = group.parentElement;
    const left = group.previousElementSibling; // the native metadata block (Preview / Code / Blame, size)
    const notice = noticeEl && visit?.notice ? M.noticeFor(visit.notice) : null;

    // Start from inline, no notice, to see what inserting Gallery does.
    toInline();
    noticeEl?.remove();
    const combined = group.querySelector('[class*="react-blob-header-edit-and-raw-actions-combined"]');
    const kebabShown = !!combined && combined.getClientRects().length > 0 && combined.offsetWidth > 0;
    const leftWidth = left ? left.getBoundingClientRect().width : 0;
    button.hidden = true;
    const leftWithout = left ? left.getBoundingClientRect().width : 0;
    button.hidden = false;
    const free = left ? group.getBoundingClientRect().left - left.getBoundingClientRect().right : 0;
    const fits = !kebabShown && Math.abs(leftWidth - leftWithout) < 0.5 && free >= 0 && row.scrollWidth <= row.clientWidth;
    if (!fits) toLine();

    if (!notice) return;
    if (!noticeEl.querySelector(".ghig-notice-text")) {
      noticeEl.innerHTML = '<span class="ghig-notice-icon" aria-hidden="true">⚠</span><span class="ghig-notice-text"></span>';
    }
    noticeEl.style.cssText = "";
    const probe = (text) => {
      noticeEl.classList.add("ghig-measure");
      const w = textWidth(noticeEl, text);
      noticeEl.classList.remove("ghig-measure");
      return w;
    };
    const place = (text, cls) => {
      noticeEl.querySelector(".ghig-notice-text").textContent = text;
      noticeEl.classList.toggle("ghig-notice-icon-only", cls === "icon");
    };

    if (fits) {
      // Space left between the native left block and Gallery.
      group.insertBefore(noticeEl, button);
      const avail = free - 8;
      const long = probe(notice.full);
      if (long <= avail) return place(notice.full);
      if (probe(notice.short) <= avail) return place(notice.short);
      noticeEl.remove();
      toLine();
    }
    // Own line: Gallery (when it lives there) keeps its place on the right.
    lineEl.insertBefore(noticeEl, lineEl.firstChild);
    const lineAvail = lineEl.clientWidth - (lineEl.contains(button) ? button.offsetWidth + 8 : 0);
    if (probe(notice.full) <= lineAvail) return place(notice.full);
    if (probe(notice.short) <= lineAvail) return place(notice.short);
    place(notice.short, lineAvail < 48 ? "icon" : undefined);
  }

  function toInline() {
    const group = button.parentElement;
    if (lineEl && lineEl.contains(button)) group.insertBefore(button, group.firstChild);
    if (lineEl) {
      lineEl.remove();
      lineEl = null;
      group.parentElement.classList.remove("ghig-wrap");
    }
  }

  function toLine() {
    if (!lineEl) {
      lineEl = el("div", "ghig-line");
      rowEl.classList.add("ghig-wrap");
      rowEl.appendChild(lineEl);
    }
    if (!lineEl.contains(button)) lineEl.appendChild(button);
  }

  function removeUi() {
    toInlineSafe();
    button?.remove();
    description?.remove();
    noticeEl?.remove();
    lineEl?.remove();
    rowEl?.classList.remove("ghig-wrap");
    observer?.disconnect();
    observer = null;
    button = description = noticeEl = lineEl = rowEl = null;
  }

  function toInlineSafe() {
    if (button && button.isConnected && lineEl) toInline();
  }

  // --- the lightbox -------------------------------------------------------

  function openGallery(auto) {
    const v = visit;
    if (!v || v.status !== "ready" || dialog) return;
    const state = {
      v,
      index: v.index,
      auto,
      scroll: [window.scrollX, window.scrollY],
      focus: document.activeElement,
      token: 0,
      timer: null,
      preload: [],
      announce: true,
    };
    const root = el("dialog", "ghig-dialog");
    root.setAttribute("aria-label", "Image gallery");
    root.innerHTML = `
      <div class="ghig-panel">
        <div class="ghig-top">
          <span class="ghig-kicker">GH Reloaded</span>
          <span class="ghig-title">Image gallery</span>
          <span class="ghig-counter"></span>
          <button type="button" class="ghig-close" aria-label="Close gallery"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg></button>
        </div>
        <div class="ghig-where"><span class="ghig-path"></span><span class="ghig-name"><span class="ghig-name-cut"></span><span class="ghig-name-full"></span></span></div>
        <div class="ghig-stage">
          <button type="button" class="ghig-nav ghig-prev" aria-label="Previous image">‹</button>
          <div class="ghig-frame"><img class="ghig-img" alt=""><div class="ghig-loading" hidden>Loading…</div><div class="ghig-fail" hidden><strong class="ghig-fail-title"></strong><span class="ghig-fail-text"></span></div></div>
          <button type="button" class="ghig-nav ghig-next" aria-label="Next image">›</button>
        </div>
        <div class="ghig-foot"><span class="ghig-hint"></span><a class="ghig-open">Open file on GitHub</a></div>
        <div class="ghig-sr" aria-live="polite"></div>
      </div>`;
    const q = (s) => root.querySelector(s);
    const count = v.items.length;
    const multi = count > 1;
    q(".ghig-hint").textContent = M.hintText(count);
    if (!multi) {
      q(".ghig-prev").remove();
      q(".ghig-next").remove();
    }
    q(".ghig-path").textContent = `${v.info.owner} / ${v.info.repo} / ${v.path.split("/").slice(0, -1).join(" / ")}`;

    function show(i, announce) {
      state.index = i;
      const item = v.items[i];
      const token = ++state.token;
      clearTimeout(state.timer);
      q(".ghig-counter").textContent = M.counterText(i + 1, count, v.incomplete);
      q(".ghig-counter").title = M.counterTooltip(i + 1, count, v.incomplete);
      q(".ghig-name-cut").textContent = M.middleCut(item.name, 56);
      q(".ghig-name-full").textContent = item.name;
      q(".ghig-name").title = item.name;
      const a = q(".ghig-open");
      a.href = M.fileHref(v.info.owner, v.info.repo, v.ref, item.path);
      const sr = q(".ghig-sr");
      if (announce) sr.textContent = `${state.announce ? "GH Reloaded, " : ""}${item.name}, ${M.announcement(i + 1, count, v.incomplete)}`;
      state.announce = false;
      loadImage(q, item, token, state);
      state.preload = [];
      if (multi) {
        for (const d of [1, -1]) {
          const n = v.items[M.step(i, d, count)];
          const im = new Image();
          im.src = rawUrl(v, n);
          state.preload.push(im);
        }
      }
    }

    const go = (d) => multi && show(M.step(state.index, d, count), true);
    function close() {
      closeGallery(state);
    }

    q(".ghig-close").addEventListener("click", close);
    q(".ghig-prev")?.addEventListener("click", () => go(-1));
    q(".ghig-next")?.addEventListener("click", () => go(1));
    root.addEventListener("click", (e) => {
      if (e.target === root || e.target.classList.contains("ghig-stage") || e.target.classList.contains("ghig-frame")) close();
    });
    root.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    q(".ghig-open").addEventListener("click", (e) => openFile(e, state, v, close));

    // Capture-phase keys, only while open: arrows, Esc and the dialog's Tab
    // trap are ours; every other key stops before GitHub's shortcuts see it.
    state.onKey = (e) => {
      if (e.type !== "keydown") {
        e.stopImmediatePropagation();
        if (e.key === "Escape" || e.key.startsWith("Arrow")) e.preventDefault();
        return;
      }
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key !== "Tab") {
        e.stopImmediatePropagation();
        return;
      } else {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", state.onKey, true);
    window.addEventListener("keypress", state.onKey, true);
    window.addEventListener("keyup", state.onKey, true);

    document.body.appendChild(root);
    dialog = { root, state };
    v.opened = true;
    try {
      root.showModal();
    } catch {
      root.setAttribute("open", "");
    }
    show(state.index, true);
    q(".ghig-close").focus();
  }

  function rawUrl(v, item) {
    return `${M.fileHref(v.info.owner, v.info.repo, v.ref, item.path)}?raw=true`;
  }

  function loadImage(q, item, token, state) {
    const v = state.v;
    const img = q(".ghig-img");
    const loading = q(".ghig-loading");
    const fail = q(".ghig-fail");
    img.hidden = false;
    fail.hidden = true;
    loading.hidden = true;
    state.timer = setTimeout(() => {
      if (token === state.token && !img.complete) loading.hidden = false;
    }, LOADING_MS);
    let probed = false;
    const failWith = (kind) => {
      if (token !== state.token) return;
      clearTimeout(state.timer);
      loading.hidden = true;
      img.hidden = true;
      const msg = M.failureMessage(kind, item.name, v.ref);
      q(".ghig-fail-title").textContent = msg.title;
      q(".ghig-fail-text").textContent = msg.text;
      fail.hidden = false;
    };
    img.onload = () => {
      if (token !== state.token) return;
      clearTimeout(state.timer);
      loading.hidden = true;
    };
    img.onerror = async () => {
      if (token !== state.token) return;
      if (probed) return failWith("damaged"); // bytes arrived and still do not decode
      probed = true;
      const res = await send("GHIG_PROBE", { owner: v.info.owner, repo: v.info.repo, ref: v.ref, path: item.path });
      if (token !== state.token) return;
      if (res?.kind === "bytes" && res.dataUrl) img.src = res.dataUrl;
      else failWith(res?.kind === "removed" || res?.kind === "refused" ? res.kind : "neutral");
    };
    img.alt = item.name;
    img.src = rawUrl(v, item);
  }

  // "Open file on GitHub": a real link. Modified clicks keep the browser's
  // new-tab behaviour; a plain click on the shown file only closes.
  async function openFile(e, state, v, close) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const target = new URL(e.currentTarget.href, location.href);
    if (target.pathname === location.pathname) return close();
    await send("GHIG_SUPPRESS", { url: target.pathname });
    location.assign(target.href);
  }

  function closeGallery(state) {
    if (!dialog || dialog.state !== state) return;
    const { root } = dialog;
    dialog = null;
    state.token++;
    clearTimeout(state.timer);
    const img = root.querySelector(".ghig-img");
    if (img) {
      img.onload = img.onerror = null;
      img.removeAttribute("src");
    }
    state.preload.forEach((im) => (im.src = ""));
    window.removeEventListener("keydown", state.onKey, true);
    window.removeEventListener("keypress", state.onKey, true);
    window.removeEventListener("keyup", state.onKey, true);
    try {
      root.close();
    } catch {
      /* not open */
    }
    root.remove();
    window.scrollTo(state.scroll[0], state.scroll[1]);
    const target = state.auto ? button : state.focus && state.focus.isConnected ? state.focus : button;
    target?.focus({ preventScroll: true });
  }

  function closeIfOpen() {
    if (dialog) closeGallery(dialog.state);
  }

  // --- life cycle -----------------------------------------------------------

  function scan() {
    if (!extensionAlive()) {
      clearInterval(poll);
      return;
    }
    const info = enabled ? routeInfo() : null;
    const group = info ? findGroup() : null;
    if (!info || !group) {
      if (visit || button) {
        closeIfOpen();
        removeUi();
        visit = null;
      }
      return;
    }
    if (!visit || visit.key !== location.pathname) {
      closeIfOpen();
      removeUi();
      startVisit(info);
    }
    const had = button && button.isConnected;
    ensureButton(group);
    if (!had) queueLayout();
  }

  const poll = setInterval(scan, POLL_MS);
  for (const ev of ["turbo:load", "turbo:render", "pjax:end", "popstate"]) {
    document.addEventListener(ev, scan);
    window.addEventListener(ev, scan);
  }
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    closeIfOpen();
    removeUi();
    visit = null;
    scan();
  });

  function loadSettings() {
    try {
      chrome.storage.local.get([KEY_ENABLED, KEY_AUTO], (s) => {
        enabled = s[KEY_ENABLED] !== false;
        autoOpen = s[KEY_AUTO] !== false;
        scan();
      });
      chrome.storage.onChanged.addListener((changes) => {
        if (changes[KEY_ENABLED]) enabled = changes[KEY_ENABLED].newValue !== false;
        if (changes[KEY_AUTO]) autoOpen = changes[KEY_AUTO].newValue !== false;
        if (changes[KEY_ENABLED]) scan();
      });
    } catch {
      /* extension reloaded */
    }
  }
  loadSettings();
})();
