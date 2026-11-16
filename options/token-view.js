// The token section as data: tokenView() turns the page's state into plain
// objects, and the small builders below turn those objects into HTML. The page
// (options.js) owns storage, events and the draft of the side panel, and
// renders whatever this module returns, so a field that is computed is a field
// that is shown. No DOM and no chrome.* here: unit tests import it directly.
import { STATUS, STATUS_LABEL } from "./token-diagnostics.js";
import { tokenState, STATE_LABEL, countOk, lastTestLabel, TYPES } from "./token-test.js";
import { warningFor, NOTIF_ID } from "./token-requirements.js";

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const DEFAULT_NAME = "Default token";

export function displayName(e) {
  if (e.isDefault) return e.name && e.name !== "Default" ? e.name : DEFAULT_NAME;
  return e.name || e.owner || "Owner token";
}

const INTRO = "One read-only check per permission type, started only by Test. Nothing was changed on GitHub.";

// One test result (a row's or the panel's draft) as data.
// entry: {name, owner, isDefault}; r: the object runTokenTest resolved to.
export function resultView(entry, r, { required, draft = false, inPanel = false, panelTokenHidden = false } = {}) {
  if (!r) return null;
  const title = draft ? "Result for the changes in this panel (not saved)" : `Test result · ${displayName(entry)}`;
  if (r.outcome === "temporary" || r.outcome === "aborted") return { title, failed: `Not checked: ${r.message}`, lines: [], advice: [], summary: "", when: "", intro: "", canAdvise: false };
  const lines = TYPES.map((t) => {
    const l = r.lines[t.id];
    const optional = !required.has(t.id);
    const why = optional ? "No feature you turned on uses this, so it doesn't make the token Missing permissions." : "A feature you turned on needs it.";
    const reason = l.status === STATUS.NOT_VERIFIED ? l.hint || l.reason || "We can't tell why." : l.status === STATUS.DENIED ? `${why} ${l.hint || ""}`.trim() : l.status === STATUS.AVAILABLE ? why : l.reason || why;
    return { type: t.id, label: t.label, optional, reason, status: l.status, pill: STATUS_LABEL[l.status] };
  });
  const { ok, total } = countOk(r.record);
  const missing = TYPES.filter((t) => required.has(t.id) && r.record.codes[t.id] === "denied").map((t) => t.name);
  const notWorking = r.outcome === "not-working";
  const summary = notWorking ? "GitHub rejected this token: it is invalid, expired or revoked." : `${ok} of ${total} OK.${missing.length ? ` Missing permissions: ${missing.join(", ")}.` : ""}`;
  const owner = entry.isDefault ? "the owner" : entry.owner || "the owner";
  const advice = notWorking
    ? [{ lead: "Replace this token:", body: `create a new one on GitHub, ${inPanel ? (panelTokenHidden ? "use Replace token above to paste it" : "paste it in the Token field") : "use Edit → Replace token to paste it"}, then press Test.` }]
    : TYPES.filter((t) => required.has(t.id)).flatMap((t) => {
      const l = r.lines[t.id];
      if (l.status === STATUS.DENIED) return [{ lead: `${t.name}:`, body: `on GitHub, edit this token and set ${t.name} to Read-only, then press Test again.` }];
      if (l.status === STATUS.NOT_VERIFIED) return [{ lead: `${t.name}:`, body: `we can't tell why. If ${owner} requires approval or SSO, see the SSO note below, then press Test again.` }];
      return [];
    });
  return { title, failed: "", lines: notWorking ? [] : lines, advice, summary, when: lastTestLabel(r.record), intro: notWorking ? "" : INTRO, canAdvise: true };
}

// The classic-token scopes that cover the missing permission types. Projects is
// read:project; Pull requests, Issues and Contents are repo (public_repo when
// only public repositories matter); Actions logs need repo.
export function classicScopes(types = []) {
  const set = new Set(types);
  const parts = [];
  if (set.has("projects")) parts.push("read:project");
  if (set.has(NOTIF_ID)) parts.push("notifications");
  const repoPublic = ["pulls", "issues", "contents"].some((t) => set.has(t));
  if (set.has("actions")) parts.push("repo");
  else if (repoPublic) parts.push("repo (public_repo is enough for public repositories only)");
  return parts.join(" and ");
}

export function stepsFor({ classic, names, ids, types = [] }) {
  const url = classic ? "https://github.com/settings/tokens" : "https://github.com/settings/personal-access-tokens";
  const rest = classic
    ? [`Tick the permissions that cover ${names}${classicScopes(types) ? `: ${classicScopes(types)}` : ""}.`, "If the organization requires approval or SSO, authorize the token or wait for an admin.", "Come back here and press Test again."]
    : [`Set ${names} to Read-only.`, "If the organization requires approval, wait for an admin to approve it.", "Come back here and press Test again."];
  return { key: `${classic}|${names}|${ids.join(",")}`, url, rest };
}

// state: {entries, tests, results, runs (Set of ids), required (Set), features, version, ui}
// ui: {laterHidden, stepsKey, editingId, diags (Set of ids)}
export function tokenView({ entries, tests, results, runs, required, features, version, ui }) {
  const rows = entries.map((e) => {
    const testing = runs.has(e.id);
    const st = testing ? { state: "testing", note: "" } : tokenState({ hasToken: !!e.token, rec: tests[e.id] || null, required });
    const label = testing ? "Testing…" : STATE_LABEL[st.state];
    const name = displayName(e);
    const last = !e.token ? "Never tested" : lastTestLabel(tests[e.id] || null);
    return {
      id: e.id,
      name,
      defaultTag: e.isDefault && name !== DEFAULT_NAME,
      use: `Used for: ${e.isDefault ? "all repositories" : e.owner}`,
      state: st.state,
      label,
      note: st.note && e.token ? st.note : "",
      last: st.note && !e.token ? st.note : last,
      canTest: !!e.token,
      testing,
      editing: ui.editingId === e.id,
      result: results.has(e.id) ? { ...resultView(e, results.get(e.id), { required }), id: e.id } : null,
      diag: ui.diags.has(e.id),
    };
  });
  const tokens = entries.filter((e) => e.token).map((e) => ({ id: e.id, name: displayName(e), codes: tests[e.id]?.codes || null, isDefault: !!e.isDefault }));
  const w = ui.laterHidden ? null : warningFor({ features, tokens, version });
  let warning = null;
  if (w) {
    const names = w.perms.map((p) => p.name).join(", ");
    // The notifications permission only exists on a classic token.
    const classic = w.perms.every((p) => p.type === NOTIF_ID) || w.ids.map((id) => entries.find((e) => e.id === id)).some((e) => e && /^gh[pous]_/.test(e.token || ""));
    const steps = stepsFor({ classic, names, ids: w.ids, types: w.perms.map((p) => p.type) });
    warning = {
      ids: w.ids,
      title: w.title,
      body: w.release ? `${w.release} Tokens: ${w.tokens.map((n) => `«${n}»`).join(", ")}.` : `Tokens: ${w.tokens.map((n) => `«${n}»`).join(", ")}. Features you already use keep working.`,
      notifications: w.perms.some((p) => p.type === NOTIF_ID),
      perms: w.perms.map((p) => ({ name: p.name, tag: p.type === NOTIF_ID ? "Classic scope" : "Read-only", reasons: p.reasons })),
      uses: w.details,
      readOnly: "Read-only: GH Reloaded never writes to GitHub.",
      steps: { ...steps, shown: ui.stepsKey === steps.key },
    };
  }
  return { rows, warning };
}

// --- The Notifications block (#tokens-more) ---

export const README_NOTIFICATIONS = "https://github.com/cattanisimone/gh-reloaded#optional-the-notifications-permission-classic-token";
const NB_NO_TOKEN = "No default token is set. Only a default token can read this list.";
const NEEDS = [
  { title: "Triage", text: "Sorts what GitHub shows on the page with no token. Review requests and mentions need a token that can read the owner's pull requests and issues. Data: the inbox page, then the pull request or issue." },
  { title: "Tags", text: "Same as Triage. Data: the inbox page, then the pull request or issue." },
  { title: "“Why is this here?”", text: "Opens from a tag and follows it. Data: what was read for that tag." },
  { title: "Beyond this page", text: "Optional. Needs a classic default token with the notifications permission. Data: GitHub's notifications list, read with the default token, 50 per page." },
];
const HOW_STEPS = [
  { text: "On GitHub, open Developer settings → Tokens (classic) and choose the token you use here.", href: "https://github.com/settings/tokens", linkText: "Developer settings → Tokens (classic)" },
  { text: "Tick the notifications scope and save. Do not add repo: it gives far more than this needs. If the token already has repo, change nothing." },
  { text: "If your organization uses SSO, follow the SSO note at the bottom of this section." },
  { text: "Come back and press Test again." },
];
const TEMP = new Set(["temporary", "aborted"]);
const PILL = { available: STATUS_LABEL[STATUS.AVAILABLE], denied: STATUS_LABEL[STATUS.DENIED], "not-verified": STATUS_LABEL[STATUS.NOT_VERIFIED], "not-checked": STATUS_LABEL[STATUS.NOT_CHECKED] };

const typeWord = (token) => (/^github_pat_/.test(token || "") ? "fine-grained" : /^gh[pousr]_/.test(token || "") ? "classic" : "type unknown");

export function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  const n = (v, one) => `${v} ${one}${v === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return n(Math.floor(s / 60), "minute");
  if (s < 86400) return n(Math.floor(s / 3600), "hour");
  return n(Math.floor(s / 86400), "day");
}

function checkView({ def, rec, results, runs, required, now }) {
  const c = { name: "Your full notifications list", status: "not-checked", pill: PILL["not-checked"], text: "", extra: "", detailText: "", optional: false, readme: false, age: "" };
  const code = rec?.codes?.[NOTIF_ID];
  const detail = rec?.detail?.[NOTIF_ID];
  const temp = def && results.get(def.id);
  if (!def || !def.token) return { ...c, text: NB_NO_TOKEN };
  if (runs.has(def.id)) return { ...c, pill: "Testing…", text: "Read-only requests, started by you." };
  if (temp && TEMP.has(temp.outcome)) return { ...c, text: `Not checked: ${temp.message}` };
  if (!rec || !code || code === "unchecked") return { ...c, text: "Not tested yet. Nothing runs until you press Test." };
  const age = `Tested ${ago(rec.at, now)}. GitHub may answer differently now.`;
  if (code === "available") return { ...c, status: "available", pill: PILL.available, text: "This token can read your full notifications list.", age };
  if (code === "denied") {
    const optional = !required.has(NOTIF_ID);
    return { ...c, status: "denied", pill: PILL.denied, optional, readme: true, age, text: optional ? "No feature you turned on uses this, so it doesn't make the token Missing permissions." : "GitHub says this token doesn't have the notifications permission. Triage and Tags keep working on the loaded notifications." };
  }
  const v = { ...c, status: "not-verified", pill: PILL["not-verified"], age };
  if (detail === "fine-grained") return { ...v, text: "Fine-grained tokens can't read this list: that's GitHub's rule. It's optional and you don't have to change anything.", extra: "Only a classic default token can read this list. Replacing your default changes how every owner without its own token is read." };
  if (detail === "sso") return { ...v, text: "The organization's SSO or token policy may be blocking this token. See the SSO note at the bottom of this section, then press Test again." };
  return { ...v, text: "GitHub didn't let your default token read your full notifications list, and didn't say why. It's optional and you don't have to change anything.", detailText: "Some organizations don't allow this, and some tokens can't do it. We can't tell which from here." };
}

function ownersView({ entries, tests, urlOwner }) {
  const list = [];
  const saved = new Set(entries.filter((e) => !e.isDefault && e.owner).map((e) => e.owner.toLowerCase()));
  if (urlOwner && urlOwner.owner && !saved.has(urlOwner.owner.toLowerCase())) {
    const st = { denied: ["denied", PILL.denied], unavailable: ["not-verified", PILL["not-verified"]] }[urlOwner.state] || ["not-checked", "Not set"];
    list.push({ key: `url:${urlOwner.owner}`, owner: urlOwner.owner, line: `${urlOwner.owner} — can't be read`, status: st[0], pill: st[1], addFor: urlOwner.owner });
  }
  for (const e of entries) {
    if (e.isDefault || !e.token || !e.owner) continue;
    const codes = tests[e.id]?.codes;
    const cant = codes && (codes.pulls === "denied" || codes.issues === "denied");
    const status = !codes ? "not-checked" : cant ? "denied" : codes.pulls === "available" && codes.issues === "available" ? "available" : "not-verified";
    list.push({ key: e.id, owner: e.owner, line: `${e.owner} — ${e.name || "Owner token"} (${typeWord(e.token)}): ${cant ? "can't read" : "reads"} its pull requests or issues. Not used for your notifications list`.replace("reads its pull requests or issues", "reads its pull requests and issues"), status, pill: PILL[status], addFor: null });
  }
  return list;
}

// entries: tokenView's entries; urlOwner: {owner, state} from the link that opened Settings.
export function notificationsView({ entries, tests = {}, results = new Map(), runs = new Set(), required = new Set(), urlOwner = null, ui = {}, now = Date.now() }) {
  const def = entries.find((e) => e.isDefault);
  const rec = def ? tests[def.id] || null : null;
  const check = checkView({ def, rec, results, runs, required, now });
  const fine = !!def?.token && (/^github_pat_/.test(def.token) || rec?.detail?.[NOTIF_ID] === "fine-grained");
  const denied = check.status === "denied";
  const howTo = fine || check.status === "available" ? null : { summary: "How to add the notifications permission to your token", open: denied || !!ui.howOpen, steps: HOW_STEPS };
  return { check, owners: ownersView({ entries, tests, urlOwner }), needs: NEEDS, howTo };
}

// --- Builders ---

export function resultHtml(res) {
  if (!res) return "";
  if (res.failed) return `<div class="tr-head"><h3>${escapeHtml(res.title)}</h3></div><p class="status error" role="status">${escapeHtml(res.failed)}</p>`;
  const when = res.when ? `<span class="tr-when">${escapeHtml(res.when)}</span>` : "";
  const lines = res.lines.map((l) => `<li class="tr-line" data-type="${l.type}"><strong>${escapeHtml(l.label)}${l.optional ? ' <span class="opt">optional</span>' : ""}</strong><span class="diag-pill is-${l.status}">${escapeHtml(l.pill)}</span><span class="diag-reason">${escapeHtml(l.reason)}</span></li>`).join("");
  const advice = res.advice.length ? `<ul class="tr-advice">${res.advice.map((a) => `<li><strong>${escapeHtml(a.lead)}</strong> ${escapeHtml(a.body)}</li>`).join("")}</ul>` : "";
  return `<div class="tr-head"><h3>${escapeHtml(res.title)}</h3>${when}</div>${res.intro ? `<p class="tr-intro">${escapeHtml(res.intro)}</p>` : ""}${lines ? `<ul class="tr-lines">${lines}</ul>` : ""}<p class="tr-summary">${escapeHtml(res.summary)}</p>${advice}`;
}

export function rowHtml(r) {
  const id = escapeHtml(r.id);
  const testBtn = (text, fk = "") => `<button type="button" class="btn btn-secondary" data-act="test" data-id="${id}"${fk ? ` data-fk="${fk}"` : ""}${r.testing ? " disabled" : ""}>${text}</button>`;
  const result = r.result
    ? `<div class="tr-result" data-result="${id}">${resultHtml(r.result)}<div class="tr-actions-row">${r.result.canAdvise ? '<button type="button" class="btn btn-secondary" data-act="advice">What should I do?</button>' : ""}${testBtn("Test again", "again")}<button type="button" class="btn btn-secondary" data-act="row-check" data-id="${id}" aria-expanded="${r.diag}">Check a specific repository</button></div></div>`
    : "";
  return `<li class="token-item${r.editing ? " is-editing" : ""}${r.note ? " has-note" : ""}" data-id="${id}">
      <div class="token-row">
        <span class="tr-id"><span class="tr-main"><span class="tr-name">${escapeHtml(r.name)}</span>${r.defaultTag ? '<span class="tag">default</span>' : ""}</span>
        <span class="tr-use">${escapeHtml(r.use)}</span></span>
        <span class="tr-state"><span class="state-pill state-${r.state}">${escapeHtml(r.label)}</span><span class="tr-last">${escapeHtml(r.last)}</span>${r.note ? `<span class="tr-note-line">${escapeHtml(r.note)}</span>` : ""}</span>
        <span class="tr-actions">${r.canTest ? testBtn("Test") : ""}<button type="button" class="btn btn-secondary" data-act="edit" data-id="${id}">Edit</button></span>
      </div>
      ${result}
      ${r.diag ? `<div class="diag-host" data-diag="${id}"></div>` : ""}
    </li>`;
}

export function notificationsHtml(v, { open = {} } = {}) {
  const c = v.check;
  const isOpen = (k, dflt) => (open[k] === undefined ? dflt : open[k]);
  const why = c.detailText ? `<details class="nb-details nb-why" data-nb="why"${isOpen("why", false) ? " open" : ""}><summary>Why can't we tell?</summary><p class="nb-text">${escapeHtml(c.detailText)}</p></details>` : "";
  const owners = v.owners.length
    ? `<ul class="nb-owners">${v.owners.map((o) => `<li class="nb-owner" data-owner-key="${escapeHtml(o.key)}"><span class="nb-owner-line">${escapeHtml(o.line)}${o.addFor ? ` <button type="button" class="inline-link nb-add" data-act="add-owner" data-owner="${escapeHtml(o.addFor)}">Add token for ${escapeHtml(o.addFor)}</button>` : ""}</span><span class="diag-pill is-${o.status}">${escapeHtml(o.pill)}</span></li>`).join("")}</ul>`
    : '<p class="nb-text">No owner has a token of its own: every owner uses the default token.</p>';
  const needs = `<ul class="nb-needs">${v.needs.map((n) => `<li><strong>${escapeHtml(n.title)}</strong> — ${escapeHtml(n.text)}</li>`).join("")}</ul>`;
  const how = v.howTo
    ? `<details class="nb-details" data-nb="how"${isOpen("how", v.howTo.open) ? " open" : ""}><summary>${escapeHtml(v.howTo.summary)}</summary><ol class="nb-steps">${v.howTo.steps.map((st) => {
      const text = escapeHtml(st.text);
      const body = st.href ? text.replace(escapeHtml(st.linkText), `<a href="${escapeHtml(st.href)}" target="_blank" rel="noopener">${escapeHtml(st.linkText)} ↗</a>`) : text;
      return `<li>${body}</li>`;
    }).join("")}</ol></details>`
    : "";
  return `<div class="nb-card">
      <div class="nb-check" data-status="${c.status}">
        <div class="nb-main"><strong class="nb-name">${escapeHtml(c.name)}${c.optional ? ' <span class="opt">optional</span>' : ""}</strong>
          <p class="nb-text" data-nb-text>${escapeHtml(c.text)}</p>${c.extra ? `<p class="nb-text">${escapeHtml(c.extra)}</p>` : ""}${why}
          ${c.readme ? `<a class="inline-link nb-readme" href="${README_NOTIFICATIONS}" target="_blank" rel="noopener">Permissions in the README ↗</a>` : ""}
          ${c.age ? `<p class="nb-age">${escapeHtml(c.age)}</p>` : ""}</div>
        <span class="diag-pill is-${c.status}" data-nb-pill>${escapeHtml(c.pill)}</span>
      </div>
      <details class="nb-details" data-nb="owners"${isOpen("owners", v.owners.length > 0) ? " open" : ""}><summary>By owner</summary>${owners}</details>
      <details class="nb-details" data-nb="needs"${isOpen("needs", false) ? " open" : ""}><summary>What each notifications feature needs</summary>${needs}</details>
      ${how}
    </div>`;
}

export function warningDetailsHtml(w) {
  const perms = w.perms.map((p) => `<li class="warning-perm"><span class="wp-main"><strong>${escapeHtml(p.name)}</strong>${p.reasons.map((r) => `<span class="wp-why">${escapeHtml(r)}</span>`).join("")}</span><span class="wp-tag">${escapeHtml(p.tag)}</span></li>`);
  const uses = w.uses.map((u) => `<li class="wp-uses">${escapeHtml(u)}</li>`);
  return [...perms, ...uses, `<li class="wp-note">${escapeHtml(w.readOnly)}</li>`].join("");
}

export function warningStepsHtml(s) {
  return [`<li>Open the token on <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">GitHub ↗</a> and edit it.</li>`, ...s.rest.map((t) => `<li>${escapeHtml(t)}</li>`)].join("");
}

// --- Side panel texts ---

export function whichLines({ isDefault, owner, defaultName, hasDefault = true }) {
  if (isDefault) return ["Used for every repository owner without a token of its own.", "If this token fails, GH Reloaded doesn't try another one."];
  return [`Repositories owned by ${owner || "this owner"} use this token.`, hasDefault ? `Every other owner uses the default token «${defaultName}».` : "Every other owner is read without a token.", "If this token fails, GH Reloaded doesn't try another one."];
}

const TEST_HELP = "Test checks permissions without saving or changing anything.";
// The one hint line under the action row: why Test is disabled (if it is) and what Test does.
export function testHint(reason) {
  return reason ? `${reason}. ${TEST_HELP}` : TEST_HELP;
}
