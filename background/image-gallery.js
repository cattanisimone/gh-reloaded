// background/image-gallery.js — background half of the "Image gallery"
// feature (see features/image-gallery/). Four small message types:
//
//  - LIST     the image files of the folder a blob URL lives in, through the
//             shared Contents API client (public repos need no token), with
//             the listing state classified for the page;
//  - PROBE    why an image did not display: reads the file through the same
//             client, and only reports "removed" / "damaged-able bytes" /
//             "refused" when the answer proves it;
//  - SUPPRESS / CONSUME  the one-navigation suppression after "Open file on
//             GitHub", kept in this worker's memory only (keyed by tab, 10 s,
//             consumed once) — nothing is ever written to storage.
//
// Nothing here writes to GitHub, and the token never leaves api.github.com.

import { ghFetch, resolveTokenRecord } from "../lib/github-api.js";
import { encodePath } from "./html-preview.js";

export const MESSAGE_TYPE = "GHIG_LIST";
const PROBE_TYPE = "GHIG_PROBE";
const SUPPRESS_TYPE = "GHIG_SUPPRESS";
const CONSUME_TYPE = "GHIG_CONSUME";

const LIMIT = 1000; // the Contents API returns at most this many entries of a directory
const TIMEOUT_MS = 15000;
const MAX_PROBE_BYTES = 12 * 1024 * 1024;
const SUPPRESS_TTL_MS = 10000;

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { timedOut: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// What a failed listing means for the page. A bare 401/403/404 never claims
// a missing permission: it is "unknown".
export function classifyError(err) {
  if (err?.rateLimited) return "rate-limit";
  if (err?.timedOut || err?.status === undefined || err.status >= 500) return "error";
  return "unknown";
}

function contentsPath(owner, repo, dir, ref) {
  const tail = dir ? `/${encodePath(dir)}` : "";
  return `/repos/${owner}/${repo}/contents${tail}?ref=${encodeURIComponent(ref)}`;
}

function dirOf(path) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

// ref/path candidates for a /blob/<rest> URL: the embedded ref when the page
// knows it, else the shortest split first, widening only while GitHub says
// that split does not exist (a branch like "feature/x" makes the URL ambiguous).
function candidates(segments, ref) {
  if (ref) {
    const n = ref.split("/").length;
    return [{ ref, path: segments.slice(n).join("/") }];
  }
  const out = [];
  for (let k = 1; k < segments.length; k++) out.push({ ref: segments.slice(0, k).join("/"), path: segments.slice(k).join("/") });
  return out;
}

export async function list({ owner, repo, segments, ref, privateHint } = {}) {
  if (!owner || !repo || !Array.isArray(segments) || segments.length < 2) return { state: "unknown" };
  const record = await resolveTokenRecord(owner);
  if (privateHint && !record?.token) return { state: "private" };

  let last = null;
  for (const c of candidates(segments, ref)) {
    try {
      const data = await withTimeout(ghFetch(contentsPath(owner, repo, dirOf(c.path), c.ref), { owner }));
      if (!Array.isArray(data)) {
        last = Object.assign(new Error("not a directory"), { status: 404 });
        continue;
      }
      const entries = data.filter((e) => e && e.type === "file").map((e) => ({ name: e.name, path: e.path, type: "file" }));
      return { state: "ok", ref: c.ref, path: c.path, entries, received: data.length, incomplete: data.length >= LIMIT };
    } catch (err) {
      if (err?.status === 404 && !err.rateLimited) {
        last = err;
        continue;
      }
      return { state: classifyError(err) };
    }
  }
  return { state: last ? classifyError(last) : "unknown" };
}

async function fileBase64(owner, repo, path, ref) {
  // fresh: this read is about what the repository holds now, not a cached answer.
  const data = await withTimeout(ghFetch(contentsPath(owner, repo, path, ref), { owner, fresh: true }));
  if (Array.isArray(data)) throw Object.assign(new Error("directory"), { status: 404 });
  if (data.size > MAX_PROBE_BYTES) throw Object.assign(new Error("too large"), { tooLarge: true });
  if (typeof data.content === "string" && data.content !== "" && data.encoding !== "none") return data.content.replace(/\n/g, "");
  if (data.sha) {
    const blob = await withTimeout(ghFetch(`/repos/${owner}/${repo}/git/blobs/${data.sha}`, { owner, fresh: true }));
    if (typeof blob.content === "string" && blob.content !== "") return blob.content.replace(/\n/g, "");
  }
  throw new Error("no content");
}

// Reads the file the page could not show. Only a proven cause is reported:
// "removed" when the parent directory is readable and no longer lists the
// file; "refused" for a rejected credential; bytes when they arrive.
export async function probe({ owner, repo, ref, path } = {}) {
  if (!owner || !repo || !ref || !path) return { kind: "neutral" };
  try {
    const base64 = await fileBase64(owner, repo, path, ref);
    const ext = path.split(".").pop().toLowerCase();
    return { kind: "bytes", dataUrl: `data:${MIME[ext] || "application/octet-stream"};base64,${base64}` };
  } catch (err) {
    if (err?.status === 404 && !err.rateLimited) {
      try {
        const dir = await withTimeout(ghFetch(contentsPath(owner, repo, dirOf(path), ref), { owner, fresh: true }));
        if (Array.isArray(dir) && !dir.some((e) => e && e.path === path)) return { kind: "removed" };
      } catch {
        /* the parent is unreadable too: proves nothing */
      }
      return { kind: "neutral" };
    }
    if (err?.status === 401 && /bad credentials/i.test(err.ghMessage || "")) return { kind: "refused" };
    return { kind: "neutral" };
  }
}

// --- one-navigation suppression, memory only ---------------------------
const suppressions = new Map(); // tabId -> { url, at }

export function suppress({ url } = {}, sender, now = Date.now()) {
  const tab = sender?.tab?.id;
  if (tab === undefined || typeof url !== "string") return { stored: false };
  suppressions.set(tab, { url, at: now });
  return { stored: true };
}

// Matches only the URL the click navigated to, is removed on first read, and
// any visit to another URL discards it.
export function consume({ url } = {}, sender, now = Date.now()) {
  const tab = sender?.tab?.id;
  const entry = suppressions.get(tab);
  suppressions.delete(tab);
  return { suppressed: !!entry && entry.url === url && now - entry.at <= SUPPRESS_TTL_MS };
}

export function clearSuppressions() {
  suppressions.clear();
}

export async function handleMessage(payload) {
  return list(payload);
}

export const probeFile = { MESSAGE_TYPE: PROBE_TYPE, handleMessage: async (payload) => probe(payload) };
export const suppression = { MESSAGE_TYPE: SUPPRESS_TYPE, handleMessage: async (payload, sender) => suppress(payload, sender) };
export const consumption = { MESSAGE_TYPE: CONSUME_TYPE, handleMessage: async (payload, sender) => consume(payload, sender) };
