// One-click "Test" for a saved or drafted token: proves, one permission type at
// a time, what the token can read. Read-only and on request, at most 7
// requests, using only the token it was given (never the shared client, which
// resolves tokens by owner and can fall back to the default one). The outcome
// is kept as codes only: no GitHub answer text, no token, no repository name.

import { classify, send, tokenType, scrub, STATUS, TIMEOUT_MS } from "./token-diagnostics.js";
import { TYPES, TYPE_IDS, NOTIF_ID } from "./token-requirements.js";

export const MAX_TEST_REQUESTS = 7;
// The default token also reads the notifications list once (never on page open).
export const MAX_TEST_REQUESTS_DEFAULT = MAX_TEST_REQUESTS + 1;
export const SESSION_KEY = "ghrTokenTests";

const API = "https://api.github.com";
const NO_PRIVATE = "We can't tell why.";
const PERSONAL_PROJECTS = "Projects owned by a personal account can't be read with a fine-grained token. Use a classic token with read:project.";
const UNKNOWN_OWNER = "We can't tell whether Projects can be read: GH Reloaded doesn't know which owner this token is for.";

const CODE_STATUS = { available: STATUS.AVAILABLE, denied: STATUS.DENIED, unverified: STATUS.NOT_VERIFIED, unchecked: STATUS.NOT_CHECKED };
export const codeStatus = (code) => CODE_STATUS[code] || STATUS.NOT_CHECKED;

// fine-grained when the secret says so, or when /user answers without an
// X-OAuth-Scopes header (classic tokens always send one); otherwise classic.
export function tokenKind(token, userHeaders = {}) {
  if (tokenType(token) === "fine-grained") return "fine-grained";
  return userHeaders["x-oauth-scopes"] === undefined ? "fine-grained" : "classic";
}

// Where the single private repository comes from, by token and owner.
export function listingUrl(owner, login) {
  const o = String(owner || "").trim();
  if (!o) return `${API}/user/repos?visibility=private&sort=pushed&per_page=1`;
  if (login && o.toLowerCase() === String(login).toLowerCase()) return `${API}/user/repos?visibility=private&affiliation=owner&sort=pushed&per_page=1`;
  return `${API}/orgs/${encodeURIComponent(o)}/repos?type=private&sort=pushed&per_page=1`;
}

// The one read-only GraphQL query for Projects, or null when none can prove
// anything (owner = the token's own login with a fine-grained token).
export function projectsQuery({ owner, login, kind }) {
  const o = String(owner || "").trim();
  const personal = o && login && o.toLowerCase() === String(login).toLowerCase();
  if (!o) {
    return kind === "classic"
      ? { mode: "viewer", query: "query{viewer{projectsV2(first:1){totalCount}}}" }
      : { mode: "orgs", query: "query{viewer{organizations(first:10){nodes{login projectsV2(first:1){totalCount}}}}}" };
  }
  if (personal) return kind === "classic" ? { mode: "viewer", query: "query{viewer{projectsV2(first:1){totalCount}}}" } : null;
  return { mode: "org", query: "query($owner:String!){organization(login:$owner){projectsV2(first:1){totalCount}}}", variables: { owner: o } };
}

const gqlErrors = (body) => (Array.isArray(body?.errors) ? body.errors : []);
const errorType = (e) => String(e?.type || e?.extensions?.code || "");

function line(status, reason = "", hint = "") {
  return { status, reason, hint };
}

function fromClassify(cls) {
  if (cls.status === STATUS.AVAILABLE) return { code: "available", line: line(STATUS.AVAILABLE) };
  if (cls.status === STATUS.DENIED && cls.cause === "permission") return { code: "denied", line: line(STATUS.DENIED, cls.reason, cls.remedy?.text || "") };
  if (cls.cause === "sso" || cls.cause === "policy") return { code: "unverified", sso: true, line: line(STATUS.NOT_VERIFIED, cls.reason, cls.remedy?.text || "") };
  return { code: "unverified", line: line(STATUS.NOT_VERIFIED, "GitHub answered without a reason that proves what is missing.", NO_PRIVATE) };
}

const scopeList = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);

// The outcome of the one read of the notifications list, from codes only.
// res: what send() returned; kind: tokenKind(). Resolves to
//   {code: "available"}                           the scope header proves it
//   {code: "denied"}                              the headers prove notifications and repo absent
//   {code: "unverified", detail}                  detail: fine-grained | sso | ambiguous
//   {temporary: cls}                              rate limit, 5xx, network: nothing is concluded
export function notificationsOutcome(res, { token = "", kind = "classic" } = {}) {
  if (kind === "fine-grained") return { code: "unverified", detail: "fine-grained" };
  const cls = classify(res || {}, { kind: "repo", token });
  if (cls.status === STATUS.TEMPORARY) return { temporary: cls };
  if (cls.cause === "sso" || cls.cause === "policy") return { code: "unverified", detail: "sso" };
  const headers = res.headers || {};
  const granted = headers["x-oauth-scopes"] === undefined ? null : scopeList(headers["x-oauth-scopes"]);
  const accepted = scopeList(headers["x-accepted-oauth-scopes"]);
  const has = !!granted && (granted.includes("notifications") || granted.includes("repo"));
  if (res.status >= 200 && res.status < 300 && has) return { code: "available" };
  if ((res.status === 403 || res.status === 404) && granted && !has && accepted.includes("notifications")) return { code: "denied" };
  return { code: "unverified", detail: "ambiguous" };
}

// Runs the plan. Resolves to {outcome, record, lines, message}:
//   done          every request answered; record = {at, codes, sso}
//   not-working   GET /user answered 401; record has identity "denied"
//   temporary     network, timeout, 5xx or rate limit: nothing is concluded,
//                 `record` is null and the caller keeps its previous result
// Rejects with AbortError when the signal fires.
// {notifications: true} (the default token only) adds the notifications check.
export async function runTokenTest(rec, { signal, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = Date.now, notifications = false } = {}) {
  const token = rec.token;
  const opts = { signal, fetch, timeoutMs };
  const budget = notifications ? MAX_TEST_REQUESTS_DEFAULT : MAX_TEST_REQUESTS;
  let requests = 0;
  const get = (check) => {
    if (++requests > budget) throw new Error("Test request budget exceeded");
    return send(check, token, opts);
  };
  const temporary = (cls) => ({ outcome: "temporary", record: null, lines: null, message: scrub(cls.reason, token) });
  const codes = Object.fromEntries(["identity", ...TYPE_IDS].map((id) => [id, "unchecked"]));
  const lines = Object.fromEntries(["identity", ...TYPE_IDS].map((id) => [id, line(STATUS.NOT_CHECKED)]));
  let sso = false;
  const setLine = (id, r) => {
    codes[id] = r.code;
    lines[id] = { ...r.line, reason: scrub(r.line.reason, token), hint: scrub(r.line.hint, token) };
    if (r.sso) sso = true;
  };
  let detail = null;
  const finish = (outcome) => ({ outcome, record: { at: now(), codes, ...(sso ? { sso: true } : {}), ...(detail ? { detail } : {}) }, lines, message: "" });

  // 1. identity
  const idRes = await get({ kind: "auth", request: { url: `${API}/user` } });
  const idCls = classify(idRes, { kind: "auth", token });
  if (idCls.status === STATUS.TEMPORARY) return temporary(idCls);
  if (idCls.status !== STATUS.AVAILABLE) {
    codes.identity = "denied";
    lines.identity = line(STATUS.DENIED, scrub(idCls.reason, token));
    return finish("not-working");
  }
  setLine("identity", { code: "available", line: line(STATUS.AVAILABLE) });
  const login = idRes.login || "";
  const kind = tokenKind(token, idRes.headers);

  // 2. one private repository the token itself lists
  const listRes = await get({ kind: "repo", keepBody: true, request: { url: listingUrl(rec.owner, login) } });
  const listCls = classify(listRes, { kind: "repo", token });
  if (listCls.status === STATUS.TEMPORARY) return temporary(listCls);
  const repo = Array.isArray(listRes.body) ? listRes.body.find((r) => r && r.private === true && typeof r.full_name === "string") : null;
  const repoTypes = ["contents", "pulls", "issues", "actions"];
  if (!repo || listCls.status !== STATUS.AVAILABLE) {
    const why = listCls.cause === "sso" || listCls.cause === "policy" ? fromClassify(listCls) : null;
    for (const id of repoTypes) {
      setLine(id, { code: "unverified", sso: !!why, line: line(STATUS.NOT_VERIFIED, "No private repository to test against.", why?.line.hint || NO_PRIVATE) });
    }
  }

  const slug = repo ? repo.full_name.split("/").map(encodeURIComponent).join("/") : "";
  const repoChecks = [
    ["contents", "file", `${API}/repos/${slug}/contents/`],
    ["pulls", "pulls", `${API}/repos/${slug}/pulls?per_page=1&state=all`],
    ["issues", "repo", `${API}/repos/${slug}/issues?per_page=1&state=all`],
  ];
  const runRepoCheck = async (id, ckind, url) => {
    const res = await get({ kind: ckind, request: { url } });
    const cls = classify(res, { kind: ckind, token });
    if (cls.status === STATUS.TEMPORARY) return cls;
    setLine(id, fromClassify(cls));
    return null;
  };
  if (repo && listCls.status === STATUS.AVAILABLE) {
    for (const [id, ckind, url] of repoChecks) {
      const failed = await runRepoCheck(id, ckind, url);
      if (failed) return temporary(failed);
    }
  }

  // 6. Projects
  const plan = projectsQuery({ owner: rec.owner, login, kind });
  if (!plan) {
    setLine("projects", { code: "unverified", line: line(STATUS.NOT_VERIFIED, "", PERSONAL_PROJECTS) });
  } else {
    const res = await get({ kind: "repo", keepBody: true, request: { url: `${API}/graphql`, method: "POST", body: JSON.stringify({ query: plan.query, variables: plan.variables || {} }) } });
    const cls = classify(res, { kind: "repo", token });
    if (cls.status === STATUS.TEMPORARY) return temporary(cls);
    if (cls.status !== STATUS.AVAILABLE) {
      setLine("projects", fromClassify(cls));
    } else {
      const errs = gqlErrors(res.body);
      const types = errs.map(errorType);
      const msg = errs.map((e) => String(e?.message || "")).join(" ");
      const data = res.body?.data;
      if (types.includes("RATE_LIMITED")) return temporary({ reason: "GitHub's rate limit was reached; try again in a few minutes." });
      const readable = (node) => node && node.projectsV2 && typeof node.projectsV2.totalCount === "number";
      if (plan.mode === "orgs") {
        const nodes = data?.viewer?.organizations?.nodes || [];
        if (nodes.some(readable)) setLine("projects", { code: "available", line: line(STATUS.AVAILABLE) });
        else setLine("projects", { code: "unverified", line: line(STATUS.NOT_VERIFIED, "", UNKNOWN_OWNER) });
      } else {
        const node = plan.mode === "viewer" ? data?.viewer : data?.organization;
        if (readable(node)) setLine("projects", { code: "available", line: line(STATUS.AVAILABLE) });
        else if (/saml|forbids access via|not been approved|pending|lifetime/i.test(msg)) {
          setLine("projects", { code: "unverified", sso: true, line: line(STATUS.NOT_VERIFIED, "The organization's SSO or token policy may be blocking this token.", NO_PRIVATE) });
        } else if (types.includes("INSUFFICIENT_SCOPES") || types.includes("FORBIDDEN") || /resource not accessible by personal access token/i.test(msg)) {
          setLine("projects", { code: "denied", line: line(STATUS.DENIED, "GitHub says the token lacks the permission to read Projects.") });
        } else setLine("projects", { code: "unverified", line: line(STATUS.NOT_VERIFIED, "GitHub returned no project data.", NO_PRIVATE) });
      }
    }
  }

  // 7. Actions logs (optional: no feature reads them today)
  if (repo && listCls.status === STATUS.AVAILABLE) {
    const failed = await runRepoCheck("actions", "repo", `${API}/repos/${slug}/actions/runs?per_page=1`);
    if (failed) return temporary(failed);
  }

  // 8. The notifications list, default token only: one read, outcome as a code.
  if (notifications) {
    let out;
    if (kind === "fine-grained") out = notificationsOutcome(null, { token, kind });
    else {
      const res = await get({ kind: "notifications", request: { url: `${API}/notifications?per_page=1` } });
      out = notificationsOutcome(res, { token, kind });
    }
    if (out.temporary) return temporary(out.temporary);
    codes[NOTIF_ID] = out.code;
    if (out.detail) detail = { [NOTIF_ID]: out.detail };
  }
  return finish("done");
}

// --- State of a token, from its stored codes and the features that are on ---

// rec: {at, codes} or null. required: Set of type ids.
export function tokenState({ hasToken, rec, required }) {
  if (!hasToken) return { state: "not-set", note: "" };
  if (!rec || !rec.codes) return { state: "not-tested", note: "" };
  const codes = rec.codes;
  if (codes.identity === "denied") return { state: "not-working", note: "" };
  const code = (id) => codes[id] || "unchecked";
  const req = TYPE_IDS.filter((id) => required.has(id));
  const unverified = TYPE_IDS.filter((id) => code(id) === "unverified").length;
  const note = unverified ? `${unverified} check${unverified === 1 ? "" : "s"} couldn't be verified` : "";
  if (req.some((id) => code(id) === "denied") || (required.has(NOTIF_ID) && codes[NOTIF_ID] === "denied")) return { state: "missing", note };
  const pool = req.length ? req : TYPE_IDS;
  if (pool.some((id) => code(id) === "available")) return { state: "works", note };
  const allSso = req.length > 0 && !!rec.sso && req.every((id) => code(id) === "unverified");
  return { state: "cant-verify", note: allSso ? "SSO or the organization's token policy may be blocking this token." : note };
}

export const STATE_LABEL = {
  "not-set": "Not set",
  "not-tested": "Not tested",
  "not-working": "Not working",
  missing: "Missing permissions",
  works: "Works",
  "cant-verify": "Can't verify",
};

// Count = available / checks tested (optional ones included; the notifications
// check only when proven).
export function countOk(rec) {
  if (rec?.codes?.identity === "denied") return { ok: 0, total: TYPE_IDS.length };
  const tested = TYPE_IDS.filter((id) => rec?.codes?.[id] && rec.codes[id] !== "unchecked");
  // The notifications check joins the count only when proven.
  const proven = ["available", "denied"].includes(rec?.codes?.[NOTIF_ID]) ? [NOTIF_ID] : [];
  return { ok: [...tested, ...proven].filter((id) => rec.codes[id] === "available").length, total: tested.length + proven.length };
}

const pad = (n) => String(n).padStart(2, "0");
export function lastTestLabel(rec, now = new Date()) {
  if (!rec) return "Never tested";
  const d = new Date(rec.at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const day = sameDay ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString([], { month: "short", day: "numeric" });
  const { ok, total } = countOk(rec);
  return `${day} ${time} · ${ok} of ${total} OK`;
}

// Rebuilds the per-type lines from stored codes (no answer text is stored).
export function linesFromRecord(rec) {
  const lines = {};
  for (const id of ["identity", ...TYPE_IDS]) {
    const code = rec.codes[id] || "unchecked";
    lines[id] = line(codeStatus(code), "", code === "unverified" ? NO_PRIVATE : "");
  }
  return lines;
}

// --- Session storage of the outcome codes (cleared with the browser session) ---

const memory = new Map(); // fallback when chrome.storage.session is unavailable

function sessionArea(area) {
  return area ?? globalThis.chrome?.storage?.session ?? null;
}

export async function readTests(area) {
  const s = sessionArea(area);
  if (s) {
    try {
      const got = await s.get(SESSION_KEY);
      return { ...(got?.[SESSION_KEY] || {}) };
    } catch { /* fall through to page memory */ }
  }
  return Object.fromEntries(memory);
}

let queue = Promise.resolve();
// Writes run one after another: each reads the whole map and writes it back.
export function writeTest(id, rec, area) {
  const run = queue.then(() => doWrite(id, rec, area));
  queue = run.catch(() => {});
  return run;
}

async function doWrite(id, rec, area) {
  const all = await readTests(area);
  if (rec) all[id] = rec;
  else delete all[id];
  memory.clear();
  for (const [k, v] of Object.entries(all)) memory.set(k, v);
  const s = sessionArea(area);
  if (s) {
    try { await s.set({ [SESSION_KEY]: all }); } catch { /* page memory only */ }
  }
}

export { TYPES };
