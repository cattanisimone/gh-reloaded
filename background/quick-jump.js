// background/quick-jump.js — background half of "Quick jump" (see features/quick-jump/).
//
//  - GHQJ_LISTS          the three personal lists and the recent items, for a scope. Two phases:
//                        "cached" answers from the session cache and sends nothing; "refresh" reads
//                        what is due (at most the three GETs below) with the token that serves the scope.
//  - GHQJ_VISIT          records a visited issue, pull request or repository.
//  - GHQJ_STATE          is the feature on, which shortcut, how it is labelled.
//  - GHQJ_OPEN_SETTINGS  opens the Settings page at an allowed anchor.
//  - chrome.commands     the browser shortcut asks the tab to toggle the panel.
//
// Reads only, to api.github.com, each with the token that serves the scope: the token mapped to the
// page's owner, else the default; "Everywhere" uses the default only. A request is never repeated with
// another token and never sent without one. The lists are cached per token record in
// chrome.storage.session (memory only, never on disk) and dropped when the token's secret changes or it
// is removed. Recent items live in chrome.storage.local, 50 items at most for 30 days, and are deleted
// when the feature is switched off or the last token is removed.

import { ghFetchRaw, getTokenRecords, resolveTokenRecord, hasAnyToken } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHQJ_LISTS";
const KEY_ENABLED = "ghqjEnabled";
const KEY_CHOICE = "ghqjShortcut";
const KEY_RECENT = "ghqjRecent";
const KEY_CACHE = "ghqjCache";
const COMMAND = "open-quick-jump";
const MIN_WAIT_MS = 60_000;
const RECENT_MAX = 50;
const RECENT_DAYS = 30;
const DAY = 86_400_000;
const NAMES = ["assigned", "review", "repos"];
const PATHS = {
  assigned: "/issues?filter=assigned&state=open&sort=updated&direction=desc&per_page=100",
  review: "/search/issues?q=is:pr+is:open+user-review-requested:@me&sort=updated&order=desc&per_page=100",
  repos: "/user/repos?sort=pushed&per_page=100",
};
const ANCHORS = new Set(["quick-jump", "tokens-section"]);

// ---- state ------------------------------------------------------------------

async function flags() {
  const o = await chrome.storage.local.get({ [KEY_ENABLED]: true, [KEY_CHOICE]: "browser" });
  return { enabled: o[KEY_ENABLED] !== false, choice: o[KEY_CHOICE] === "cmdk" ? "cmdk" : "browser" };
}

async function isActive() {
  const { enabled } = await flags();
  return enabled && (await hasAnyToken());
}

async function platform() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return info?.os === "mac" ? "mac" : "other";
  } catch {
    return "other";
  }
}

async function commandShortcut() {
  try {
    const all = await chrome.commands.getAll();
    return all.find((c) => c.name === COMMAND)?.shortcut || "";
  } catch {
    return "";
  }
}

export const state = {
  MESSAGE_TYPE: "GHQJ_STATE",
  async handleMessage() {
    const f = await flags();
    const active = f.enabled && (await hasAnyToken());
    return { active, enabled: f.enabled, choice: f.choice, shortcut: await commandShortcut(), platform: await platform() };
  },
};

// ---- the browser shortcut -----------------------------------------------------

// Chrome gives the tab the shortcut was pressed in. A tab without the content script (any page
// outside github.com) cannot receive the message and nothing happens.
export async function handleCommand(command, tab) {
  if (command !== COMMAND || !tab || typeof tab.id !== "number") return;
  if (!(await isActive())) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "GHQJ_TOGGLE" });
  } catch {
    /* no content script in that tab */
  }
}

chrome.commands?.onCommand?.addListener((command, tab) => {
  handleCommand(command, tab);
});

// ---- recent items --------------------------------------------------------------

export function pruneRecent(list, now) {
  const keep = (Array.isArray(list) ? list : []).filter((i) => i && typeof i.key === "string" && Number.isFinite(i.at) && now - i.at <= RECENT_DAYS * DAY);
  return keep.sort((a, b) => b.at - a.at).slice(0, RECENT_MAX);
}

// One entry per item, a revisit moves it to the top and refreshes its time and title.
export function recordVisit(list, visit, now) {
  const item = { key: visit.key, url: visit.url, kind: visit.kind, repo: visit.repo, number: visit.number || 0, title: visit.title, at: now };
  const rest = (Array.isArray(list) ? list : []).filter((i) => i && i.key !== item.key);
  return pruneRecent([item, ...rest], now);
}

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

// Rebuilds the stored item from validated parts, never from a URL the page supplied.
export function cleanVisit(v) {
  if (!v || typeof v !== "object") return null;
  const kind = v.kind;
  if (!["issue", "pull", "repo"].includes(kind)) return null;
  const [owner, repo, ...extra] = String(v.repo || "").split("/");
  if (extra.length || !SEGMENT.test(owner || "") || !SEGMENT.test(repo || "")) return null;
  const number = kind === "repo" ? 0 : Number(v.number);
  if (kind !== "repo" && !(Number.isInteger(number) && number > 0 && number < 1e9)) return null;
  const full = `${owner}/${repo}`;
  const base = `https://github.com/${full}`;
  const url = kind === "repo" ? base : `${base}/${kind === "issue" ? "issues" : "pull"}/${number}`;
  const key = kind === "repo" ? full.toLowerCase() : `${full.toLowerCase()}#${number}`;
  const title = String(v.title || "").replace(/\s+/g, " ").trim().slice(0, 300) || full;
  return { key, url, kind, repo: full, number, title };
}

function githubSender(sender) {
  try {
    return new URL(String(sender?.url || "")).origin === "https://github.com";
  } catch {
    return false;
  }
}

// Every write to the recent list and its clean-up run one after the other, so a visit that was accepted
// just before the feature was switched off cannot put the list back.
let writes = Promise.resolve();
const serial = (fn) => (writes = writes.then(fn, fn));

export const visit = {
  MESSAGE_TYPE: "GHQJ_VISIT",
  async handleMessage(payload, sender) {
    if (!githubSender(sender)) return { recorded: false };
    if (!(await isActive())) return { recorded: false };
    const clean = cleanVisit(payload);
    if (!clean) return { recorded: false };
    return serial(async () => {
      if (!(await isActive())) return { recorded: false };
      const cur = await chrome.storage.local.get(KEY_RECENT);
      await chrome.storage.local.set({ [KEY_RECENT]: recordVisit(cur[KEY_RECENT], clean, Date.now()) });
      return { recorded: true };
    });
  },
};

export const openSettings = {
  MESSAGE_TYPE: "GHQJ_OPEN_SETTINGS",
  async handleMessage(payload, sender) {
    if (!githubSender(sender)) return {};
    const hash = ANCHORS.has(payload?.hash) ? payload.hash : "quick-jump";
    await chrome.tabs.create({ url: `${chrome.runtime.getURL("options/options.html")}#${hash}` });
    return {};
  },
};

// ---- the personal lists --------------------------------------------------------

const slug = (s) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s || "");

function repoOf(item) {
  const full = item.repository?.full_name || String(item.repository_url || "").replace(/^https:\/\/api\.github\.com\/repos\//, "");
  return slug(full) ? full : "";
}

function workItem(item, reason) {
  const repo = repoOf(item);
  if (!repo || !Number.isInteger(item.number)) return null;
  const pull = reason === "review";
  return { kind: pull ? "pull" : "issue", repo, number: item.number, title: String(item.title || "").slice(0, 300), url: `https://github.com/${repo}/${pull ? "pull" : "issues"}/${item.number}`, reason, updatedAt: item.updated_at || "" };
}

const hasNext = (link) => /rel="next"/.test(link || "");

// One list's response → { items, truncated }, only the fields the panel shows.
export function normalize(name, res) {
  if (name === "assigned") {
    const items = (Array.isArray(res.data) ? res.data : []).filter((i) => !i.pull_request).map((i) => workItem(i, "assigned")).filter(Boolean);
    return { items, truncated: hasNext(res.link) };
  }
  if (name === "review") {
    const raw = Array.isArray(res.data?.items) ? res.data.items : [];
    const items = raw.map((i) => workItem(i, "review")).filter(Boolean);
    return { items, truncated: Number(res.data?.total_count) > raw.length };
  }
  const items = (Array.isArray(res.data) ? res.data : []).filter((r) => slug(r.full_name)).map((r) => ({ kind: "repo", repo: r.full_name, url: `https://github.com/${r.full_name}`, pushedAt: r.pushed_at || "" }));
  return { items, truncated: hasNext(res.link) };
}

// What a failed read means for the list: it cannot be read with this token (401, 404, 422, a 403 that
// is not a rate limit), GitHub is limiting requests, or an error (5xx or the network).
export function classify(err) {
  if (err?.rateLimited) return "limited";
  const s = err?.status;
  if (s === 401 || s === 404 || s === 422 || s === 403) return "cannot";
  return "error";
}

async function readCache() {
  const o = await chrome.storage.session.get(KEY_CACHE);
  return o[KEY_CACHE] && typeof o[KEY_CACHE] === "object" ? o[KEY_CACHE] : {};
}

const writeCache = (c) => chrome.storage.session.set({ [KEY_CACHE]: c });

// A list is due when it was never read, or its minute is over and (after a limit or an error) so is the
// wait GitHub asked for.
function due(entry, now) {
  if (!entry) return true;
  if (entry.retryAt && now < entry.retryAt) return false;
  return now - entry.at >= MIN_WAIT_MS;
}

function present(entry, now) {
  if (!entry) return { status: "loading", items: [], truncated: false, waitMs: 0 };
  const waitMs = entry.status === "limited" || entry.status === "error" ? Math.max(MIN_WAIT_MS, (entry.retryAt || 0) - now) : 0;
  return { status: entry.status, items: entry.items || [], truncated: !!entry.truncated, waitMs };
}

// One read per token record and list at a time: a second open, a Tab to another scope served by the same
// record, or a second tab awaits the read already in flight instead of sending the same GET again.
const inflight = new Map();
function readShared(recordId, name, owner) {
  const key = `${recordId}:${name}`;
  if (!inflight.has(key)) inflight.set(key, readOne(name, owner).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function readOne(name, owner) {
  const now = Date.now();
  try {
    const res = await ghFetchRaw(PATHS[name], { owner, requireToken: true });
    return { status: "ok", ...normalize(name, res), at: now, retryAt: 0 };
  } catch (e) {
    if (e?.noToken) throw e;
    const status = classify(e);
    return { status, at: now, retryAt: status === "limited" ? Math.max(now + MIN_WAIT_MS, e.retryAt || 0) : status === "error" ? now + MIN_WAIT_MS : 0, failed: true };
  }
}

async function ownersMapped() {
  const records = await getTokenRecords();
  return [...new Set(records.filter((r) => r.token && (r.owner || "").trim()).map((r) => r.owner.trim()))];
}

export async function handleMessage(payload) {
  const f = await flags();
  if (!f.enabled || !(await hasAnyToken())) return { active: false };
  const phase = payload?.phase === "refresh" ? "refresh" : "cached";
  const scope = payload?.scope === "repo" || payload?.scope === "owner" ? payload.scope : "everywhere";
  const owner = scope === "everywhere" ? "" : String(payload?.owner || "");
  const now = Date.now();
  const cur = await chrome.storage.local.get(KEY_RECENT);
  const recent = pruneRecent(cur[KEY_RECENT], now);
  const record = await resolveTokenRecord(owner);
  const out = { active: true, recent, serving: record?.token ? (scope === "everywhere" ? "default" : record.owner ? "mapped" : "default") : "none", tokenName: record?.name || "", recordId: record?.id || "", mappedOwners: scope === "everywhere" ? await ownersMapped() : [] };
  if (!record?.token) {
    out.lists = Object.fromEntries(NAMES.map((n) => [n, { status: "none", items: [], truncated: false, waitMs: 0 }]));
    return out;
  }
  const cache = await readCache();
  const entry = cache[record.id] || {};
  if (phase === "refresh") {
    const todo = NAMES.filter((n) => due(entry[n], now));
    const results = await Promise.all(todo.map((n) => readShared(record.id, n, owner)));
    todo.forEach((n, i) => {
      const r = results[i];
      // A failed read keeps the rows of the last good one (shown as possibly out of date).
      entry[n] = r.failed ? { ...r, items: entry[n]?.items || [], truncated: !!entry[n]?.truncated } : r;
    });
    // The secret may have changed while the reads ran: what the old credential saw is never cached.
    const now2 = todo.length ? await resolveTokenRecord(owner) : null;
    if (todo.length && now2?.id === record.id && now2.token === record.token) {
      const fresh = await readCache();
      fresh[record.id] = entry;
      await writeCache(fresh);
    } else if (todo.length) {
      return { ...out, active: true, lists: Object.fromEntries(NAMES.map((n) => [n, present(undefined, now)])) };
    }
  }
  out.lists = Object.fromEntries(NAMES.map((n) => [n, present(entry[n], now)]));
  return out;
}

// ---- clean-up ------------------------------------------------------------------

async function purgeSessionFor(ids) {
  if (!ids.length) return;
  const cache = await readCache();
  let changed = false;
  for (const id of ids) {
    if (id in cache) {
      delete cache[id];
      changed = true;
    }
  }
  if (changed) await writeCache(cache);
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area && area !== "local") return;
  if (changes[KEY_ENABLED] && changes[KEY_ENABLED].newValue === false) serial(() => chrome.storage.local.remove(KEY_RECENT));
  if (changes.githubTokens) {
    const oldList = changes.githubTokens.oldValue || [];
    const newList = changes.githubTokens.newValue || [];
    if (!newList.some((r) => r.token)) serial(() => chrome.storage.local.remove(KEY_RECENT));
    const newById = new Map(newList.map((r) => [r.id, r.token]));
    purgeSessionFor(oldList.filter((r) => newById.get(r.id) !== r.token).map((r) => r.id));
  }
});
