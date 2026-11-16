// features/notifications/coverage-model.js — the one place that says why a
// notification is limited (#131). It turns the engine's capability states
// into the status of each feature, the notes and action lines of the Triage
// panel's "Coverage and permissions" section, and the one line the inbox may
// show. The panel and the inbox both read it, so they cannot contradict each
// other. Pure: no DOM, no storage, no request; every string of the feature
// lives here, in plain words (no token value, no organization policy named as
// a cause, nobody told to replace a fine-grained default token).
//
// States (page memory only, from the engine): for the notifications list read
// with the default token `api` is one of not-tried, ok, missing-scope,
// unavailable, rate-limited (the engine's refused and no-answer read as
// unavailable); for each owner whose rows needed facts `pr:<owner>` is one of
// ok, no-token, denied, unavailable, rate-limited.
//
// A plain global (content scripts cannot import), loaded before panel.js.

(function (global) {
  const API_KEY = "api:notifications";
  const SETTINGS = "Settings → GitHub tokens";
  const UNVERIFIABLE = "“Unverifiable”";
  const SORTING = "Sorting still works for everything GitHub shows here.";
  const OWNER_STATES = ["ok", "no-token", "denied", "unavailable", "rate-limited"];
  const CAP = 3;

  // refused and no-answer (the multi-page triage states) read as unavailable.
  function normalizeApi(state) {
    if (state === "refused" || state === "no-answer") return "unavailable";
    return ["not-tried", "ok", "missing-scope", "unavailable", "rate-limited"].includes(state) ? state : "not-tried";
  }

  // [{ owner, state }] for `pr:<owner>` capabilities, in a stable order.
  function owners(caps) {
    return Object.entries(caps || {})
      .filter(([k, v]) => k.startsWith("pr:") && OWNER_STATES.includes(v))
      .map(([k, v]) => ({ owner: k.slice(3), state: v }))
      .sort((a, b) => a.owner.localeCompare(b.owner));
  }

  const T = (v) => ({ t: "text", v });
  const L = (kind, label, extra) => ({ t: "link", kind, label, ...(extra || {}) });

  // The status of Triage and Tags (first matching row wins) and of "Beyond this page".
  function featureStatus({ api, owner, rate, hasDefault }) {
    if (rate) return { status: "Limited", desc: `${SORTING} Some review requests wait for GitHub's rate limit.` };
    const bad = owner.filter((o) => ["no-token", "denied", "unavailable"].includes(o.state));
    if (bad.length) return { status: "Limited", desc: `${SORTING} ${bad.length === 1 && hasDefault ? "Some of this owner's review requests can't be confirmed." : "Some review requests can't be confirmed."}` };
    return { status: "Full", desc: "Work on every loaded notification." };
  }

  function beyondStatus({ api, bothOff }) {
    if (bothOff) return { status: "Off", desc: "" };
    if (api === "rate-limited") return { status: "Limited", desc: "Counts outside this page wait for GitHub's rate limit." };
    if (api === "ok") return { status: "Full", desc: "Counts also cover notifications outside this page." };
    return { status: "Not in use", desc: "Optional. Counts cover this page only." };
  }

  // o: { active, phase, caps, rateLimited, retryAt, triageOn, tagsOn, fmtTime }
  // -> { hint, rows: [{id,label,status,desc}], notes: [{n,box,text,more?}], actions: [{segs, owner?, ownerState?}] }
  function describe(o) {
    const hint = { lead: "Tokens and permissions: ", link: SETTINGS };
    if (!o.active) return { active: false, hint, rows: [], notes: [], actions: [] };
    const caps = o.caps || {};
    // The engine reads nothing on a page with no rows, so the key is then absent:
    // that is "unknown", never "no default token" (nobody was asked).
    const known = API_KEY in caps;
    const api = normalizeApi(caps[API_KEY]);
    const owner = owners(caps);
    const rate = !!o.rateLimited || api === "rate-limited" || owner.some((x) => x.state === "rate-limited");
    const hasDefault = known && api !== "not-tried";
    const triageOn = o.triageOn !== false;
    const tagsOn = o.tagsOn !== false;
    const ready = o.phase === "ready";

    // ---- rows
    const st = featureStatus({ api, owner, rate, hasDefault });
    const row = (id, label, on) => ({ id, label, status: on ? st.status : "Off", desc: on ? st.desc : "" });
    const rows = [];
    if (triageOn === tagsOn) rows.push(row("triage-tags", "Triage and Tags", triageOn));
    else rows.push(row("triage", "Triage", triageOn), row("tags", "Tags", tagsOn));
    const by = beyondStatus({ api, bothOff: !triageOn && !tagsOn });
    rows.push({ id: "beyond", label: "Beyond this page", status: by.status, desc: by.desc });

    // ---- notes, in order
    const notes = [];
    const ownerActions = [];
    const when = rate && o.retryAt != null && o.fmtTime ? ` at ${o.fmtTime(o.retryAt)}` : rate ? " when it resets" : "";
    if (rate) notes.push({ n: 1, box: "warning", text: `GitHub's rate limit was reached: classifications update${when}.` });

    const noToken = known && api === "not-tried" && owner.length > 0 && owner.every((x) => x.state === "no-token");
    if (noToken) notes.push({ n: 2, box: "warning", text: `No default GitHub token is set, so some notifications can't be told apart and show as ${UNVERIFIABLE}.` });

    const ownerNotes = (n, list, text, action) => {
      for (const x of list.slice(0, CAP)) {
        notes.push({ n, box: "warning", owner: x.owner, text: text(x.owner) });
        ownerActions.push(action(x));
      }
      if (list.length > CAP) notes.push({ n, box: "warning", more: true, text: `and ${list.length - CAP} more` });
    };
    if (!noToken) {
      ownerNotes(
        3,
        owner.filter((x) => x.state === "no-token" || x.state === "denied"),
        (name) => `No token that can read ${name}: its notifications are shown as ${UNVERIFIABLE}.`,
        (x) => ({ owner: x.owner, ownerState: x.state, segs: [T(`${x.owner}: can't be read. `), L("settings", x.state === "no-token" ? `Add token for ${x.owner} ›` : "Add or replace token ›", { owner: x.owner, ownerState: x.state })] })
      );
    }
    ownerNotes(
      4,
      owner.filter((x) => x.state === "unavailable"),
      (name) => `We couldn't read ${name}'s pull requests or issues, and GitHub didn't say why: its notifications show as ${UNVERIFIABLE}.`,
      (x) => ({ owner: x.owner, ownerState: x.state, segs: [T(`${x.owner}: couldn't be read. `), L("settings", "Test in Settings ›", { owner: x.owner, ownerState: x.state })] })
    );

    if (ready && known && api === "not-tried" && !noToken) {
      const some = owner.some((x) => x.state === "ok");
      notes.push({ n: 5, box: "neutral", text: `No default GitHub token is set, so only the loaded notifications are covered.${some ? " Owners with their own token are read normally." : ""}` });
    }
    if (api === "missing-scope") notes.push({ n: 6, box: "neutral", text: "Your token doesn't have the notifications permission, so only the loaded notifications are covered. This is optional." });
    if (api === "unavailable") notes.push({ n: 7, box: "neutral", text: "Only a classic default token with the notifications permission can read your full notifications list. GitHub didn't let yours, and didn't say why. Everything on the loaded page keeps working." });
    // With no token and no owner recorded, note 5 stands alone (the issue's "only note 5 shows").
    const alone = notes.length === 1 && notes[0].n === 5 && owner.length === 0;
    if (notes.length && !alone) notes.push({ n: 8, box: "plain", text: "Changed a token? Reload this page.", reload: true });

    // ---- action lines at the foot: the owner lines win over the links of notes 2, 6 and 7
    let actions = ownerActions;
    if (!actions.length) {
      if (noToken) actions = [{ segs: [L("settings", `Add a token in ${SETTINGS} ›`)] }];
      else if (api === "missing-scope") actions = [{ segs: [T("How to add it: "), L("settings", `${SETTINGS} ›`), T(" · "), L("readme", "Permissions in the README ›")] }];
      else if (api === "unavailable") actions = [{ segs: [T("What each feature needs: "), L("settings", `${SETTINGS} ›`)] }];
    }
    return { active: true, hint, rows, notes, actions };
  }

  // ---- the inbox line --------------------------------------------------------

  // items: the engine's items; caps: the capabilities; noTokenLine: the "no
  // token at all" coverage line is on screen (it already names that cause).
  // Returns { text, link, owner?, ownerState? } or null.
  function inboxLine({ items, caps, noTokenLine = false }) {
    const api = normalizeApi((caps || {})[API_KEY]);
    const stateOf = (name) => (caps || {})[`pr:${String(name || "").toLowerCase()}`];
    const hit = [];
    for (const it of items || []) {
      if (it.inPage === false || it.pending || it.section !== "unverifiable") continue;
      const s = stateOf(it.owner);
      if (["no-token", "denied", "unavailable", "rate-limited"].includes(s)) hit.push({ owner: it.owner, state: s });
    }
    if (!hit.length) return null;
    const n = hit.length;
    const states = new Set(hit.map((h) => h.state));
    const names = new Set(hit.map((h) => h.owner.toLowerCase()));
    const only = hit[0];
    if (states.size === 1 && states.has("no-token") && api === "not-tried") {
      if (noTokenLine) return null;
      return { text: `${n} are Unverifiable: no default GitHub token is set.`, link: "What this means ›" };
    }
    if (names.size === 1 && (only.state === "no-token" || only.state === "denied")) return { text: `${n} from ${only.owner} are Unverifiable: no token can read ${only.owner}.`, link: "How to fix this ›", owner: only.owner, ownerState: only.state };
    if (names.size === 1 && only.state === "unavailable") return { text: `${n} from ${only.owner} are Unverifiable: we couldn't read ${only.owner}.`, link: "What this means ›", owner: only.owner, ownerState: only.state };
    if (states.size === 1 && states.has("rate-limited")) return { text: `${n} are Unverifiable: GitHub's rate limit was reached.`, link: "What this means ›" };
    return { text: `${n} are Unverifiable.`, link: "What this means ›" };
  }

  global.GHNT_COVERAGE = { SETTINGS, normalizeApi, describe, inboxLine };
})(typeof window !== "undefined" ? window : globalThis);
