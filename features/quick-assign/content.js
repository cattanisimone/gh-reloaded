// features/quick-assign/content.js — Quick assignment (experimental), on a
// repository issue page. Under GitHub's own Assignees list it adds
// "Assign me" / "Unassign me" and a small ✕ on each assignee row.
//
// Nothing here writes to GitHub's API. An action drives GitHub's own
// Assignees picker in the user's session (open it, filter by the exact
// login, toggle that one option, press Escape so GitHub saves) and then
// asks the background for a read-only, uncached read of the issue to confirm
// that GitHub's stored assignees really changed. "Assigned" is shown only
// after that read agrees; otherwise an honest failure or a neutral "Sent,
// not confirmed". The decisions live in picker.js (loaded first).
//
// The section is found through data-testid, ARIA and visible text, never a
// CSS-module prefix; a missing anchor means no controls and a retry on the
// next scan, never another container. Controls exist only while the native
// edit button does, so a read-only visitor sees exactly the native page.

(function () {
  const STORAGE_ENABLED = "ghqaEnabled";
  const MESSAGE_TYPE = "QUICK_ASSIGN_READ_ASSIGNEES"; // matches background/quick-assign.js
  const P = globalThis.GHQA_PICKER;
  const PICKER_STEP_MS = 3000;
  const PICKER_OPEN_MS = 8000; // the first open loads GitHub's picker code
  const READ_DELAYS_MS = [800, 2000, 3000]; // before each read-back attempt, ~5.8 s in all
  const SUCCESS_VISIBLE_MS = 6000;

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function issueOfPage() {
    const m = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(location.pathname);
    return m ? { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() } : null;
  }

  const currentUser = () => document.querySelector('meta[name="user-login"]')?.getAttribute("content") || "";

  // --- reading the native section ----------------------------------------

  function findSection() {
    return [...document.querySelectorAll('[data-testid="sidebar-assignees-section"]')].find((s) => /^assignees$/i.test(s.querySelector("h3")?.textContent.trim() || "")) || null;
  }

  // The native edit button is the permission signal: it is absent for a
  // visitor who cannot edit assignees (signed out, no write access, locked).
  function findEditButton(section) {
    return [...section.querySelectorAll("button")].find((b) => /edit assignees/i.test(b.textContent)) || null;
  }

  function findList(section) {
    return section.querySelector('ul[class*="assigneesList"]');
  }

  // One entry per row. `login` is set only for a plain user (link is exactly
  // /<login>); app and bot rows keep a null login and get no ✕.
  function readRows(list) {
    return [...list.children].filter((li) => li.tagName === "LI").map((li) => {
      const link = li.querySelector(":scope > a[href]");
      return { li, link, login: link ? P.loginFromHref(link.getAttribute("href")) : null };
    });
  }

  const userLogins = (rows) => rows.filter((r) => r.login).map((r) => r.login);
  const hasNativeSelfAssign = (section) => !!section.querySelector('[class*="selfAssignButton"]') || [...section.querySelectorAll("button")].some((b) => /assign yourself/i.test(b.textContent));

  // --- the native picker --------------------------------------------------

  function openPickerDialog() {
    const box = document.querySelector('[role="dialog"] [role="combobox"][aria-label="Filter assignees"]');
    return box ? box.closest('[role="dialog"]') : null;
  }

  // Loading is what the picker announces: Primer's filter input wrapper
  // carries aria-busy. Its spinner nodes stay rendered after the list has
  // loaded (observed live), so their presence is not a signal.
  const spinning = (dialog) =>
    [...dialog.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some((el) => !el.hidden && el.getClientRects().length > 0);

  async function until(fn, ms = PICKER_STEP_MS) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(40);
    }
  }

  function setFilter(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function pressEscape(target) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  }

  const readOptions = (dialog) => [...dialog.querySelectorAll('[role="listbox"] [role="option"]')].map((el) => ({
    el,
    label: el.querySelector('[data-component="ActionList.Item.Label"], [class*="ItemLabel"]')?.textContent ?? "",
    selected: el.getAttribute("aria-selected") === "true",
  }));

  // Opens the picker, toggles the option of exactly `login` toward `goal`,
  // presses Escape so GitHub saves. Any surprise leaves the selection
  // untouched (Escape without a click) and reports why. Returns
  // { ok: true } or { ok: false, reason }.
  //
  // Once the user clicks or types after we started, a picker that shows up
  // may be theirs (on this issue or, after a navigation, on another one):
  // we never filter, toggle or close it.
  async function driveNativePicker(editButton, login, goal, pageKey) {
    if (openPickerDialog()) return { ok: false, reason: "busy" };
    const inputs = userInputs;
    const userActed = () => userInputs !== inputs;
    editButton.click();
    const dialog = await until(() => userActed() || openPickerDialog(), PICKER_OPEN_MS);
    if (dialog === true) return { ok: false, reason: "picker" };
    if (!dialog) {
      // The picker is lazy-loaded: if it shows up after we gave up and before
      // the user did anything, it is the one we opened, still untouched, so
      // close it without changing anything.
      until(() => userActed() || openPickerDialog(), PICKER_OPEN_MS).then((late) => {
        if (late && late !== true) pressEscape(late.querySelector('[role="combobox"]') || late);
      });
      return { ok: false, reason: "picker" };
    }
    const input = dialog.querySelector('[role="combobox"][aria-label="Filter assignees"]');
    const cancel = async (reason) => {
      pressEscape(input);
      await until(() => !openPickerDialog());
      return { ok: false, reason };
    };
    setFilter(input, login);
    let option = null;
    let calm = 0;
    const found = await until(() => {
      option = P.findOption(readOptions(dialog), login);
      calm = option && !spinning(dialog) ? calm + 1 : 0;
      return calm >= 2; // present and not loading on two checks in a row
    });
    if (!found) return cancel("option");
    const decision = P.decideToggle(goal, option);
    if (decision !== "click") return cancel(decision === "already" ? "state" : "option");
    // Escape without a click changes nothing: bail out if the page moved on or the user stepped in.
    // Not `editButton.isConnected`: GitHub replaces that node as soon as the picker opens.
    if (userActed() || !findSection() || issueOfPage()?.key !== pageKey) return cancel("picker");
    option.el.click();
    pressEscape(input);
    const closed = await until(() => !openPickerDialog());
    return closed ? { ok: true } : { ok: false, reason: "picker" };
  }

  // --- state --------------------------------------------------------------

  // One action at a time. `status` is what the line under the button shows.
  let busy = false;
  let driving = false; // the native picker is being operated by us
  let status = null; // { tone, text, extra, detail, link, title, until }
  let statusKey = "";
  let pendingFocus = null; // { kind, login } when the activated control was replaced
  // Trusted clicks and key presses, counted so an action can tell whether
  // the user did something since it started.
  let userInputs = 0;
  const countInput = (e) => {
    if (e.isTrusted) userInputs++;
  };
  document.addEventListener("pointerdown", countInput, true);
  document.addEventListener("keydown", countInput, true);

  const ui = { rows: [] };

  function setStatus(next) {
    status = next;
    schedule();
  }

  // --- confirmation -------------------------------------------------------

  const COULDNT = { assign: "Couldn't assign you", unassign: "Couldn't unassign you", remove: "Couldn't remove" };

  function failure(action, detail) {
    const what = action.kind === "remove" ? `${COULDNT.remove} @${action.login}` : COULDNT[action.kind];
    return { tone: "bad", text: `✕ ${what}`, detail: detail || "The list shows GitHub's current state. Use the ⚙ picker." };
  }

  function successText(action) {
    return action.kind === "assign" ? "✓ Assigned" : action.kind === "unassign" ? "✓ Unassigned" : `✓ Removed @${action.login}`;
  }

  function notConfirmed(page, error) {
    const base = { tone: "muted", text: "Sent, not confirmed", link: "Settings → GitHub tokens" };
    if (error?.kind === "rate") {
      const at = error.retryAt ? new Date(error.retryAt) : null;
      const time = at ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "";
      return { tone: "muted", text: "Sent, not confirmed", detail: `GitHub rate limit reached${time ? `, resets at ${time}` : ""}.` };
    }
    if (error?.kind === "error") return { tone: "muted", text: "Sent, not confirmed", detail: "GitHub did not answer the confirmation request. The list shows GitHub's current state." };
    if (error?.kind === "notoken") return { ...base, detail: "The change was sent; a token is needed only to confirm it." };
    return { ...base, detail: `The token for ${page.owner} can't read issues (Issues: Read).` };
  }

  async function readBack(page) {
    try {
      return await chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload: { owner: page.owner, repo: page.repo, number: page.number } });
    } catch {
      return null;
    }
  }

  // Waits for GitHub's stored state to show the change (a few tries, since
  // the save finishes just after the picker closes). The first answer that
  // is a refusal ends the wait; the rest is judged by compareAssignees.
  async function confirm(page, action, before) {
    let last = null;
    for (const delay of READ_DELAYS_MS) {
      await sleep(delay);
      if (issueOfPage()?.key !== page.key) return null;
      const res = await readBack(page);
      if (res && res.ok && res.error) {
        if (res.error.kind !== "error") return notConfirmed(page, res.error);
        last = res;
        continue;
      }
      if (!res || !res.ok || !Array.isArray(res.assignees)) {
        last = res;
        continue;
      }
      const cmp = P.compareAssignees(before, res.assignees, action.login, action.goal);
      if (cmp.status === "confirmed") return { tone: "ok", text: successText(action), extra: " (confirmed by GitHub)", until: Date.now() + SUCCESS_VISIBLE_MS };
      if (cmp.status === "unexpected") {
        return { tone: "bad", text: "⚠ Assignees changed unexpectedly", detail: `${cmp.removed.map((l) => `@${l}`).join(", ")} ${cmp.removed.length === 1 ? "is" : "are"} no longer assigned. Check the list.` };
      }
      last = res;
    }
    // A read that never worked is "not confirmed"; one that worked and shows no change is a failure.
    if (!last || !last.ok || !Array.isArray(last.assignees)) return notConfirmed(page, last?.error || { kind: "error" });
    return failure(action);
  }

  // --- the action ---------------------------------------------------------

  async function run(kind, login, source) {
    const page = issueOfPage();
    const section = findSection();
    const editButton = section && findEditButton(section);
    if (busy || !page || !editButton || openPickerDialog()) return;
    const action = { kind, login, goal: kind === "assign" ? "add" : "remove" };
    busy = true;
    const rows = findList(section) ? readRows(findList(section)) : [];
    const before = userLogins(rows);
    // The control may be replaced by a re-render: remember where focus should land.
    pendingFocus = { kind, source, index: Math.max(0, rows.findIndex((r) => r.login === login)) };
    setStatus({ tone: "muted", text: "Saving…", spinner: true });
    let result;
    try {
      driving = true;
      const driven = await driveNativePicker(editButton, login, action.goal, page.key).finally(() => {
        driving = false;
        // From here on, a click or key press of the user means they moved on.
        if (pendingFocus) pendingFocus.inputs = userInputs;
      });
      if (issueOfPage()?.key !== page.key) return;
      if (!driven.ok) {
        result = driven.reason === "busy" ? null : failure(action, driven.reason === "state" ? "GitHub's list already matches. The list shows GitHub's current state." : "GitHub's picker did not respond as expected, nothing was changed. Use the ⚙ picker.");
      } else {
        schedule();
        result = await confirm(page, action, before);
      }
    } catch {
      result = failure(action);
    } finally {
      busy = false;
    }
    if (issueOfPage()?.key !== page.key) return;
    status = result || null;
    if (pendingFocus) pendingFocus.done = true;
    schedule();
    if (status?.until) setTimeout(schedule, SUCCESS_VISIBLE_MS + 50);
  }

  // GitHub moves focus to its edit button when the picker closes, and React
  // may replace the control the user activated while we wait for the
  // confirmation. Put focus back on that control or on its natural
  // replacement (the new Assign/Unassign button, the row now in the same
  // place), unless the user has moved on by themselves.
  function keepFocus(section, editButton) {
    if (!pendingFocus || driving) return;
    if (pendingFocus.inputs !== undefined && pendingFocus.inputs !== userInputs) {
      pendingFocus = null;
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || active === editButton) {
      let target = pendingFocus.source;
      if (!target?.isConnected) {
        const xs = [...section.querySelectorAll("[data-ghqa-x]")];
        target = pendingFocus.kind === "remove" && xs.length ? xs[Math.min(pendingFocus.index, xs.length - 1)] : section.querySelector("[data-ghqa-btn]") || section.querySelector('[class*="selfAssignButton"]');
      }
      if (target) {
        target.focus();
        pendingFocus.source = target;
      }
    }
    if (pendingFocus.done) pendingFocus = null;
  }

  // --- rendering ----------------------------------------------------------

  function makeButton(kind) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.ghqaBtn = kind;
    b.addEventListener("click", () => {
      const me = currentUser();
      if (me) run(kind, me, b);
    });
    return b;
  }

  function ensureX(row) {
    let x = row.li.querySelector(":scope > [data-ghqa-x]");
    if (x) {
      // React re-inserts its link after our node; keep the ✕ last so Tab goes link → ✕.
      if (x.nextElementSibling && x !== document.activeElement) row.li.append(x);
      return x;
    }
    x = document.createElement("button");
    x.type = "button";
    x.dataset.ghqaX = row.login;
    x.className = "ghqa-x";
    x.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
    // React may reuse the row for another assignee before our next scan:
    // remove whoever the row shows now, which is what the label says.
    x.addEventListener("click", () => {
      const link = x.parentElement?.querySelector(":scope > a[href]");
      const login = link ? P.loginFromHref(link.getAttribute("href")) : null;
      if (login) run("remove", login, x);
    });
    row.li.append(x);
    return x;
  }

  function renderStatus(box) {
    let line = box.querySelector("[data-ghqa-status]");
    if (!status) {
      line?.remove();
      statusKey = "";
      return;
    }
    const key = JSON.stringify([status.tone, status.text, status.extra, status.detail, status.link, !!status.spinner]);
    if (!line) {
      line = document.createElement("div");
      line.dataset.ghqaStatus = "";
      line.setAttribute("role", "status");
      box.append(line);
      statusKey = "";
    }
    if (key === statusKey) return;
    statusKey = key;
    line.dataset.tone = status.tone;
    line.replaceChildren();
    const first = document.createElement("div");
    first.className = "ghqa-line";
    if (status.spinner) first.append(Object.assign(document.createElement("span"), { className: "ghqa-spin" }));
    first.append(status.text);
    if (status.extra) first.append(Object.assign(document.createElement("span"), { className: "ghqa-extra", textContent: status.extra }));
    line.append(first);
    if (status.detail || status.link) {
      const second = document.createElement("div");
      second.className = "ghqa-detail";
      if (status.detail) second.append(status.detail + (status.link ? " " : ""));
      if (status.link) {
        const a = document.createElement("button");
        a.type = "button";
        a.className = "ghqa-link";
        a.textContent = status.link;
        a.addEventListener("click", () => {
          try {
            chrome.runtime.openOptionsPage();
          } catch {}
        });
        second.append(a);
      }
      line.append(second);
    }
    line.title = [status.text, status.detail, status.link].filter(Boolean).join(" — ");
  }

  function render(page, section, editButton, list) {
    const me = currentUser();
    const pickerOpen = !busy && !!openPickerDialog();
    const disabled = busy || pickerOpen;
    section.dataset.ghqa = "";
    section.toggleAttribute("data-ghqa-disabled", disabled);
    const rows = readRows(list);
    ui.rows = rows;
    for (const row of rows) {
      if (!row.login) {
        row.li.removeAttribute("data-ghqa-row");
        row.li.querySelector(":scope > [data-ghqa-x]")?.remove();
        continue;
      }
      row.li.dataset.ghqaRow = "";
      const x = ensureX(row);
      x.dataset.ghqaX = row.login;
      const label = `Remove @${row.login} from assignees`;
      if (x.getAttribute("aria-label") !== label) {
        x.setAttribute("aria-label", label);
        x.title = label;
      }
      x.setAttribute("aria-disabled", String(disabled));
    }

    const meAssigned = rows.some((r) => r.login && r.login.toLowerCase() === me.toLowerCase());
    const emptyNative = rows.length === 0 && hasNativeSelfAssign(section);
    if (status?.until && Date.now() > status.until) status = null;
    let box = section.querySelector("[data-ghqa-actions]");
    // The native "Assign yourself" already covers an empty issue: no button
    // there. The status line stays while an action is pending or reported,
    // since removing the last assignee lands in exactly that empty state.
    if (!me || (emptyNative && !busy && !status)) {
      box?.remove();
      return;
    }
    // The box goes right after the list's wrapper: a direct child of the
    // section when there are rows, inside the header wrapper in the empty
    // state (both observed live).
    const anchor = list.parentElement && list.parentElement !== section && section.contains(list.parentElement) ? list.parentElement : null;
    if (!anchor) {
      box?.remove(); // unknown structure: no controls, retry on the next scan
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.dataset.ghqaActions = "";
    }
    if (box.previousElementSibling !== anchor) anchor.after(box);
    const kind = emptyNative ? null : meAssigned ? "unassign" : "assign";
    let btn = box.querySelector("[data-ghqa-btn]");
    if (btn && btn.dataset.ghqaBtn !== kind) {
      btn.remove();
      btn = null;
    }
    if (kind) {
      if (!btn) {
        btn = makeButton(kind);
        box.prepend(btn);
      }
      const text = kind === "assign" ? "Assign me" : "Unassign me";
      if (btn.textContent !== text) btn.textContent = text;
      btn.className = `ghqa-btn ${kind === "assign" ? "ghqa-primary" : "ghqa-default"}`;
      btn.setAttribute("aria-disabled", String(disabled));
    }
    renderStatus(box);
    keepFocus(section, editButton);
  }

  function teardown() {
    document.querySelectorAll("[data-ghqa-actions], [data-ghqa-x]").forEach((el) => el.remove());
    document.querySelectorAll("[data-ghqa]").forEach((el) => {
      el.removeAttribute("data-ghqa");
      el.removeAttribute("data-ghqa-disabled");
    });
    document.querySelectorAll("[data-ghqa-row]").forEach((el) => el.removeAttribute("data-ghqa-row"));
  }

  let lastKey = "";
  async function sync() {
    if (!extensionAlive()) return;
    const page = issueOfPage();
    if (!page) {
      lastKey = "";
      if (!busy) {
        status = null;
        pendingFocus = null;
      }
      return teardown();
    }
    if (page.key !== lastKey) {
      lastKey = page.key;
      status = null; // a pending state of another issue is never shown here
      pendingFocus = null;
    }
    let enabled;
    try {
      enabled = (await chrome.storage.local.get(STORAGE_ENABLED))[STORAGE_ENABLED];
    } catch {
      return;
    }
    if (enabled !== true) return teardown(); // experimental: off unless switched on
    const section = findSection();
    const editButton = section && findEditButton(section);
    const list = section && findList(section);
    if (!section || !editButton || !list) return teardown(); // no anchor or no permission: nothing, retry on the next scan
    render(page, section, editButton, list);
  }

  let timer;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(sync, 120);
  }

  document.addEventListener("turbo:load", schedule);
  document.addEventListener("turbo:render", schedule);
  document.addEventListener("pjax:end", schedule);
  window.addEventListener("popstate", schedule);

  chrome.storage.onChanged.addListener((changes) => {
    if (extensionAlive() && changes[STORAGE_ENABLED]) schedule();
  });

  // React re-renders the sidebar after the picker saves and may drop our
  // nodes: re-assert. sync() is idempotent, so our own mutations settle.
  const observer = new MutationObserver(() => {
    if (!extensionAlive()) return observer.disconnect();
    if (issueOfPage() || document.querySelector("[data-ghqa]")) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-testid", "href", "role", "aria-selected"] });

  let lastUrl = location.href;
  const pollId = setInterval(() => {
    if (!extensionAlive()) return clearInterval(pollId);
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      schedule();
    }
  }, 800);

  schedule();
})();
