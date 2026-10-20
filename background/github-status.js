// background/github-status.js — background half of "GitHub Status" (see
// features/github-status/). One anonymous GET of githubstatus.com's
// summary.json, shared by every github.com tab: the snapshot is cached in
// chrome.storage.session (in memory, survives service-worker restarts), kept
// for 5 minutes, fetched by one request at a time, with a 10 s timeout and a
// limited backoff after a failure. A malformed body counts as a failure. The
// last good snapshot is kept on failure; the page decides, from fetchedAt,
// when it is too old to be shown as current.
//
// Nothing about the user, the page or a token is sent: no query string, no
// credentials, no referrer.

export const MESSAGE_TYPE = "GITHUB_STATUS_GET";
export const SUMMARY_URL = "https://www.githubstatus.com/api/v2/summary.json";
export const CACHE_KEY = "ghgsCache";
export const TTL_MS = 5 * 60_000;
export const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
const RETRY_AFTER_CAP_MS = 15 * 60_000;
const MIN_FORCE_GAP_MS = 5_000;

const INDICATORS = ["none", "minor", "major", "critical"];
// Statuspage reports a running scheduled maintenance as its own page indicator.
const PAGE_INDICATORS = [...INDICATORS, "maintenance"];
const COMPONENT_STATUSES = ["operational", "degraded_performance", "partial_outage", "major_outage", "under_maintenance"];

const str = (v, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function need(cond, what) {
  if (!cond) throw new Error(`Unexpected githubstatus.com response: ${what}`);
}

function parseWhen(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

// Only https links to githubstatus.com are kept; anything else is dropped.
function statusLink(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && /(^|\.)githubstatus\.com$/.test(u.hostname) ? u.href : "";
  } catch {
    return "";
  }
}

function parseIncident(i) {
  need(i && typeof i === "object" && str(i.id) && str(i.name), "incident");
  const updates = Array.isArray(i.incident_updates) ? i.incident_updates : [];
  const latest = [...updates].filter((u) => u && typeof u === "object").sort((a, b) => parseWhen(b.updated_at || b.created_at) - parseWhen(a.updated_at || a.created_at))[0];
  return {
    id: str(i.id, 64),
    name: str(i.name),
    status: str(i.status, 40),
    impact: INDICATORS.includes(i.impact) ? i.impact : "none",
    updatedAt: str(i.updated_at, 40),
    url: statusLink(i.shortlink),
    components: (Array.isArray(i.components) ? i.components : []).map((c) => str(c?.name, 120)).filter(Boolean),
    latest: latest ? { body: str(latest.body, 600), status: str(latest.status, 40), at: str(latest.updated_at || latest.created_at, 40) } : null,
  };
}

// summary.json -> the few fields the page reads. Throws on anything that is
// not the documented shape, so a changed feed turns into "Unverified"
// instead of a wrong green.
export function parseSummary(json) {
  need(json && typeof json === "object", "not an object");
  need(json.status && PAGE_INDICATORS.includes(json.status.indicator), "status.indicator");
  need(Array.isArray(json.components), "components");
  need(Array.isArray(json.incidents), "incidents");
  const components = json.components.map((c) => {
    need(c && typeof c === "object" && str(c.name) && COMPONENT_STATUSES.includes(c.status), "component");
    return { name: str(c.name, 120), status: c.status };
  });
  const maintenances = (Array.isArray(json.scheduled_maintenances) ? json.scheduled_maintenances : [])
    .filter((m) => m && typeof m === "object" && m.status === "in_progress")
    .map((m) => ({ ...parseIncident(m), impact: "none" }));
  return {
    indicator: json.status.indicator,
    description: str(json.status.description, 200),
    updatedAt: str(json.page?.updated_at, 40),
    components: components.filter((c) => c.status !== "operational"),
    incidents: json.incidents.map(parseIncident),
    maintenances,
  };
}

// Retry-After is delay-seconds or an HTTP-date; returns seconds, or NaN.
export function parseRetryAfter(value, nowMs) {
  if (value == null || String(value).trim() === "") return NaN;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? NaN : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export function nextRetryDelay(failures, retryAfterSeconds) {
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, RETRY_AFTER_CAP_MS);
  return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1];
}

// A service with its collaborators injected, so tests drive time, storage
// and the network. The module-level handleMessage below uses the real ones.
export function createStatusService({ fetchImpl = (...a) => fetch(...a), area, now = Date.now } = {}) {
  let inflight = null;
  const read = async () => (await area.get(CACHE_KEY))[CACHE_KEY] || {};
  const write = (value) => area.set({ [CACHE_KEY]: value });
  const view = (c, error) => ({ snapshot: c.snapshot || null, fetchedAt: c.fetchedAt || 0, error: !!error });

  async function refresh(c) {
    const started = now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(SUMMARY_URL, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: ctl.signal });
      if (!res.ok) {
        const e = new Error(`githubstatus.com answered ${res.status}`);
        e.retryAfter = parseRetryAfter(res.headers?.get?.("retry-after"), now());
        throw e;
      }
      const snapshot = parseSummary(await res.json());
      const next = { snapshot, fetchedAt: now(), failures: 0, retryAt: 0, attemptedAt: started };
      await write(next);
      return view(next, false);
    } catch (e) {
      const failures = (c.failures || 0) + 1;
      const next = { ...c, failures, retryAt: now() + nextRetryDelay(failures, e.retryAfter), attemptedAt: started };
      await write(next);
      return view(next, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function get({ force = false } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      const c = await read();
      const t = now();
      if (force) {
        if (t - (c.attemptedAt || 0) < MIN_FORCE_GAP_MS) return view(c, !!c.failures);
      } else if (c.snapshot && !c.failures && t - c.fetchedAt < TTL_MS) {
        return view(c, false);
      } else if (t < (c.retryAt || 0)) {
        return view(c, !!c.failures);
      }
      return refresh(c);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return { get };
}

let service;
export async function handleMessage(payload) {
  service ||= createStatusService({ area: chrome.storage.session || chrome.storage.local });
  return service.get({ force: !!payload?.force });
}
