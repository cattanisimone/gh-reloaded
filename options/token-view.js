// The token section as data: tokenView() turns the page's state into plain
// objects, and the small builders below turn those objects into HTML. The page
// (options.js) owns storage, events and the draft of the side panel, and
// renders whatever this module returns, so a field that is computed is a field
// that is shown. No DOM and no chrome.* here: unit tests import it directly.
import { STATUS, STATUS_LABEL } from "./token-diagnostics.js";
import { tokenState, STATE_LABEL, countOk, lastTestLabel, TYPES } from "./token-test.js";
import { warningFor } from "./token-requirements.js";

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const DEFAULT_NAME = "Default token";

export function displayName(e) {
  if (e.isDefault) return e.name && e.name !== "Default" ? e.name : DEFAULT_NAME;
  return e.name || e.owner || "Owner token";
}

const INTRO = "One read-only check per permission type, started only by Test. Nothing was changed on GitHub.";

// One test result (a row's or the panel's draft) as data.
// entry: {name, owner, isDefault}; r: the object runTokenTest resolved to.
export function resultView(entry, r, { required, draft = false } = {}) {
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
    ? [{ lead: "Replace this token:", body: "create a new one on GitHub, use Edit → Replace token to paste it, then press Test." }]
    : TYPES.filter((t) => required.has(t.id)).flatMap((t) => {
      const l = r.lines[t.id];
      if (l.status === STATUS.DENIED) return [{ lead: `${t.label}:`, body: `on GitHub, edit this token and set ${t.label} to Read-only, then press Test again.` }];
      if (l.status === STATUS.NOT_VERIFIED) return [{ lead: `${t.label}:`, body: `we can't tell why. If ${owner} requires approval or SSO, see the SSO note below, then press Test again.` }];
      return [];
    });
  return { title, failed: "", lines: notWorking ? [] : lines, advice, summary, when: lastTestLabel(r.record), intro: notWorking ? "" : INTRO, canAdvise: true };
}

export function stepsFor({ classic, names, ids }) {
  const url = classic ? "https://github.com/settings/tokens" : "https://github.com/settings/personal-access-tokens";
  const rest = classic
    ? [`Tick the permissions that cover ${names} (read:project, public_repo or repo).`, "If the organization requires approval or SSO, authorize the token or wait for an admin.", "Come back here and press Test again."]
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
    const last = !e.token ? "Never tested" : testing ? "Testing…" : lastTestLabel(tests[e.id] || null);
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
  const tokens = entries.filter((e) => e.token).map((e) => ({ id: e.id, name: displayName(e), codes: tests[e.id]?.codes || null }));
  const w = ui.laterHidden ? null : warningFor({ features, tokens, version });
  let warning = null;
  if (w) {
    const names = w.perms.map((p) => p.name).join(", ");
    const classic = w.ids.map((id) => entries.find((e) => e.id === id)).some((e) => e && /^gh[pous]_/.test(e.token || ""));
    const steps = stepsFor({ classic, names, ids: w.ids });
    warning = {
      ids: w.ids,
      title: w.title,
      body: `Tokens: ${w.tokens.map((n) => `«${n}»`).join(", ")}. Features you already use keep working.`,
      perms: w.perms.map((p) => ({ name: p.name, tag: "Read-only", reasons: p.reasons })),
      uses: w.details,
      readOnly: "Read-only: GH Reloaded never writes to GitHub.",
      steps: { ...steps, shown: ui.stepsKey === steps.key },
    };
  }
  return { rows, warning };
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
        <span class="tr-main"><span class="tr-name">${escapeHtml(r.name)}</span>${r.defaultTag ? '<span class="tag">default</span>' : ""}</span>
        <span class="state-pill state-${r.state}">${escapeHtml(r.label)}</span>
        ${r.note ? `<span class="tr-note-line">${escapeHtml(r.note)}</span>` : ""}
        <span class="tr-use">${escapeHtml(r.use)}</span>
        <span class="tr-last">${escapeHtml(r.last)}</span>
        <span class="tr-actions">${r.canTest ? testBtn("Test") : ""}<button type="button" class="btn btn-secondary" data-act="edit" data-id="${id}">Edit</button></span>
      </div>
      ${result}
      ${r.diag ? `<div class="diag-host" data-diag="${id}"></div>` : ""}
    </li>`;
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
