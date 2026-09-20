// background/html-preview.js — background half of the "HTML preview"
// feature (see features/html-preview/). Fetches a file's contents at a
// specific ref through the GitHub API — never straight from
// raw.githubusercontent.com — so it goes through the same auth/caching
// path (and rate limit) as every other feature, and works for private
// repos the token has access to.

import { ghFetch } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHHP_FETCH_FILE";

// Service workers have no atob-free binary-safe base64 decoder for
// non-Latin1 text, so go through raw bytes explicitly rather than
// risking mojibake on anything outside ASCII.
function decodeBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function fetchFileContent(owner, repo, path, ref) {
  const data = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
  );
  if (Array.isArray(data)) {
    throw new Error(`${path} is a directory, not a file`);
  }
  if (typeof data.content === "string") {
    return decodeBase64Utf8(data.content);
  }
  // The Contents API omits `content` for files over ~1MB but still
  // returns the blob's own sha — the Git Blobs API serves the same
  // base64 payload with a much higher size ceiling.
  if (data.sha) {
    const blob = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    if (typeof blob.content === "string") return decodeBase64Utf8(blob.content);
  }
  throw new Error(`Could not read the content of ${path}`);
}

// A GitHub blob URL (/owner/repo/blob/<rest>) is genuinely ambiguous
// about where the ref ends and the path begins whenever the branch name
// itself contains a slash (e.g. "feature/x") — the content script can't
// tell "feature/x/file.html" apart from ref "feature" + path
// "x/file.html" from the URL alone. Git's own ref namespace can't have
// both "feature" and "feature/x" as branches at once (one would have to
// be a file and a directory at the same path), so at most one split
// below ever resolves to a real file — try the common no-slash case
// first, then widen the ref by one segment at a time only while the
// Contents API says that exact split doesn't exist.
async function resolveAndFetch(owner, repo, segments) {
  let lastErr;
  for (let k = 1; k < segments.length; k++) {
    const ref = segments.slice(0, k).join("/");
    const path = segments.slice(k).join("/");
    try {
      return { html: await fetchFileContent(owner, repo, path, ref), ref, path };
    } catch (err) {
      if (err.status !== 404) throw err; // a real error, not just "wrong split" — don't mask it
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not resolve a branch/path split for this URL.");
}

export async function handleMessage({ owner, repo, path, ref, segments }) {
  if (segments) return resolveAndFetch(owner, repo, segments);
  const html = await fetchFileContent(owner, repo, path, ref);
  return { html, ref, path };
}
