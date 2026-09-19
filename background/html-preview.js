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

export async function handleMessage({ owner, repo, path, ref }) {
  const html = await fetchFileContent(owner, repo, path, ref);
  return { html };
}
