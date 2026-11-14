// background/actions-log-shortcuts.js — background half of "Actions log
// shortcuts" (see features/actions-log-shortcuts/).
//
//  - GHALS_DETECT  can the token for this repository read the job's Actions
//                  logs? One uncached read-only probe (redirect not followed,
//                  no body read) per repository and token per minute.
//  - GHALS_OPEN    opens the job's raw-log link in a new tab, after validating
//                  it against the frame URL Chrome attaches to the message.
//
// Only the last outcome per owner ("ok" or "not-permitted", with its time) is
// stored, for the Options warning. No log bytes, redirect URL, token,
// repository name or job id is ever stored or logged.

import { ghProbe, resolveTokenRecord } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHALS_DETECT";
const OPEN_TYPE = "GHALS_OPEN";
const KEY_ENABLED = "ghalsEnabled";
const KEY_OUTCOMES = "ghalsOutcomes";
const WINDOW_MS = 60_000;
const ROUTE = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)\/?$/;
const RAW = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-fA-F]{7,40})\/checks\/(\d+)\/logs$/;

const cache = new Map(); // `${tokenId}:${owner}/${repo}` -> { state, until }

export function resetState() {
  cache.clear();
}

// owner/repo/job of the Actions job route this message comes from, else null.
// The frame URL Chrome attaches (sender.url) proves the message comes from a
// github.com page, but it is the URL of the last *document* load: GitHub's SPA
// navigation (history.pushState) does not update it. So the route is read from
// `path`, the content script's own location.pathname (the page cannot forge the
// isolated world's message), and falls back to sender.url's path when absent.
// sender.tab.url is never used: it is null without a host permission.
function jobRoute(senderUrl, path) {
  let u;
  try {
    u = new URL(String(senderUrl || ""));
  } catch {
    return null;
  }
  if (u.origin !== "https://github.com") return null;
  const m = ROUTE.exec(typeof path === "string" && path.startsWith("/") ? path : u.pathname);
  return m ? { owner: m[1], repo: m[2], run: m[3], job: m[4] } : null;
}

export function mapAnswer(a) {
  if (!a) return "unknown";
  if (a.redirected || (a.status >= 200 && a.status < 300)) return "ok";
  if (a.rateLimited) return "rate-limited";
  if (a.sso) return "unknown";
  if (a.status === 403 || a.status === 404) return "not-permitted";
  return "unknown";
}

async function enabled() {
  const o = await chrome.storage.local.get({ [KEY_ENABLED]: true });
  return o[KEY_ENABLED] !== false;
}

async function remember(owner, state) {
  if (state !== "ok" && state !== "not-permitted") return;
  const o = await chrome.storage.local.get(KEY_OUTCOMES);
  const outcomes = { ...(o[KEY_OUTCOMES] || {}) };
  outcomes[owner] = { state, at: Date.now() };
  await chrome.storage.local.set({ [KEY_OUTCOMES]: outcomes });
}

async function detectFor(route, { fresh } = {}) {
  if (!(await enabled())) return "off";
  const record = await resolveTokenRecord(route.owner);
  if (!record?.token) return "no-token";
  const key = `${record.id}:${route.owner}/${route.repo}`.toLowerCase();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() < hit.until) return hit.state;
  let answer;
  try {
    answer = await ghProbe(`/repos/${route.owner}/${route.repo}/actions/jobs/${route.job}/logs`, { owner: route.owner });
  } catch {
    answer = null;
  }
  const state = mapAnswer(answer);
  const until = state === "rate-limited" ? answer.retryAt || Date.now() + WINDOW_MS : Date.now() + WINDOW_MS;
  cache.set(key, { state, until });
  await remember(route.owner, state);
  return state;
}

export async function handleMessage(payload, sender) {
  const route = jobRoute(sender?.url, payload?.path);
  if (!route) return { state: "unknown" };
  return { state: await detectFor(route) };
}

// The raw-log URL a link may be, rebuilt from validated parts: https://github.com/<owner>/<repo>/commit/<sha>/checks/<job>/logs,
// owner, repo (case-insensitive) and job equal to the sender's job route. Else null.
export function rawLogUrl(href, senderUrl, path) {
  const route = jobRoute(senderUrl, path);
  if (!route || !href || typeof href !== "string") return null;
  let u;
  try {
    u = new URL(href, "https://github.com");
  } catch {
    return null;
  }
  if (u.origin !== "https://github.com") return null;
  const m = RAW.exec(u.pathname);
  if (!m) return null;
  if (m[1].toLowerCase() !== route.owner.toLowerCase() || m[2].toLowerCase() !== route.repo.toLowerCase() || m[4] !== route.job) return null;
  return `https://github.com/${route.owner}/${route.repo}/commit/${m[3]}/checks/${m[4]}/logs`;
}

export const open = {
  MESSAGE_TYPE: OPEN_TYPE,
  async handleMessage(payload, sender) {
    const url = rawLogUrl(payload?.href, sender?.url, payload?.path);
    const route = jobRoute(sender?.url, payload?.path);
    if (!url || !route) return { opened: false, state: "unknown" };
    const state = await detectFor(route, { fresh: true });
    if (state !== "ok") return { opened: false, state };
    const opts = { url };
    if (sender?.tab?.id != null) {
      opts.openerTabId = sender.tab.id;
      if (Number.isInteger(sender.tab.index)) opts.index = sender.tab.index + 1;
    }
    try {
      await chrome.tabs.create(opts);
    } catch {
      return { opened: false, state };
    }
    return { opened: true, state };
  },
};

// A token change or switching the feature off forgets what was learned.
chrome.storage.onChanged.addListener((changes) => {
  const tokens = changes.githubTokens || changes.defaultTokenId;
  const off = changes[KEY_ENABLED] && changes[KEY_ENABLED].newValue === false;
  if (!tokens && !off) return;
  cache.clear();
  chrome.storage.local.remove(KEY_OUTCOMES);
});
