// background/html-preview.js — background half of the "HTML preview"
// feature (see features/html-preview/). Fetches a file's contents at a
// specific ref through the GitHub API — never straight from
// raw.githubusercontent.com — so it goes through the same auth/caching
// path (and rate limit) as every other feature, and works for private
// repos the token has access to.
//
// The file's own relative resources (a stylesheet, a script, an image)
// are inlined as data: URIs the same way, for the same reason: a plain
// `<base href="https://raw.githubusercontent.com/...">` would send those
// requests straight from the browser with no token attached, so on a
// private repo the page loads but comes back unstyled and broken. Only
// direct references from the HTML (and one level deep into a linked
// stylesheet) are covered — content.js still sets that `<base href>` too,
// as a best-effort fallback for anything this doesn't catch (srcset,
// `@import`, a script's own runtime fetches).

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

// Returns the file's content as a base64 string, exactly as GitHub's API
// hands it back — the right shape both for turning into a UTF-8 string
// (decodeBase64Utf8) and for embedding as-is in a data: URI, where
// re-decoding/re-encoding binary content (an image, a font) would risk
// corrupting it.
async function fetchContentsBase64(owner, repo, path, ref) {
  const data = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
  );
  if (Array.isArray(data)) {
    throw new Error(`${path} is a directory, not a file`);
  }
  if (typeof data.content === "string") {
    return data.content.replace(/\n/g, "");
  }
  // The Contents API omits `content` for files over ~1MB but still
  // returns the blob's own sha — the Git Blobs API serves the same
  // base64 payload with a much higher size ceiling.
  if (data.sha) {
    const blob = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    if (typeof blob.content === "string") return blob.content.replace(/\n/g, "");
  }
  throw new Error(`Could not read the content of ${path}`);
}

const MIME_BY_EXT = {
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  json: "application/json",
  txt: "text/plain",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

function mimeFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function isRelativeUrl(url) {
  if (!url) return false;
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url); // any "scheme:" or protocol-relative "//" is not relative
}

// Joins a reference onto the directory it was found in, the same way a
// browser resolves a relative URL against a page — "../" walks up a
// segment, and a leading "/" resets to the repo root (there's no true
// document root to resolve against here, so the repo root is the closest
// sensible equivalent).
function resolveRelativePath(dir, ref) {
  const clean = ref.split("#")[0].split("?")[0];
  const stack = clean.startsWith("/") ? [] : dir ? dir.replace(/\/$/, "").split("/") : [];
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

function dirOf(path) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

// `String.replace` has no async-replacer form — this runs the async
// replacer over every match up front, then substitutes each one in turn.
// Matches are taken from the ORIGINAL string, so this assumes replacing
// one occurrence at a time (in order) lands each result in the right
// place, which holds even for byte-for-byte duplicate matches.
async function replaceAsync(str, regex, asyncFn) {
  const matches = [...str.matchAll(regex)];
  let out = str;
  for (const m of matches) {
    const replacement = await asyncFn(...m);
    if (replacement !== m[0]) out = out.replace(m[0], replacement);
  }
  return out;
}

// Fetches one relative asset and returns it as a data: URI, or null if
// it isn't relative, or couldn't be fetched (a 404, a permissions gap) —
// callers leave the original reference alone in that case, so content.js's
// own `<base href>` fallback still gets a chance at it.
async function inlineAsset(owner, repo, ref, dir, rawRef) {
  if (!isRelativeUrl(rawRef)) return null;
  const path = resolveRelativePath(dir, rawRef);
  if (!path) return null;
  try {
    const base64 = await fetchContentsBase64(owner, repo, path, ref);
    return `data:${mimeFor(path)};base64,${base64}`;
  } catch {
    return null;
  }
}

// Rewrites every `url(...)` in a chunk of CSS (a `<style>` block, a
// `style="..."` attribute, or a fetched stylesheet's own text) to a data:
// URI, resolved relative to `dir` — the directory of whichever file the
// CSS itself came from, not necessarily the HTML page's own directory.
async function inlineCssUrls(css, owner, repo, ref, dir) {
  return replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (full, _q, url) => {
    const dataUrl = await inlineAsset(owner, repo, ref, dir, url);
    // Left unquoted deliberately: this CSS can itself end up inside an
    // HTML `style="..."` attribute, and a data: URI never contains a
    // quote, space, or parenthesis, so it's valid either way — quoting
    // it here would risk closing that attribute early if it uses the
    // same quote character.
    return dataUrl ? `url(${dataUrl})` : full;
  });
}

async function inlineHtmlAssets(html, owner, repo, ref, dir) {
  let out = html;

  // <img src="...">, <script src="...">
  out = await replaceAsync(
    out,
    /<(img|script)\b([^>]*?)\bsrc=(["'])([^"']+)\3([^>]*)>/gi,
    async (full, tag, before, quote, url, after) => {
      const dataUrl = await inlineAsset(owner, repo, ref, dir, url);
      return dataUrl ? `<${tag}${before}src=${quote}${dataUrl}${quote}${after}>` : full;
    }
  );

  // <link rel="stylesheet" href="...">, inlined as <style> so its own
  // url()s (fonts, background images) can be resolved and rewritten too
  // — a data: URI wrapping the raw, unrewritten CSS text would just move
  // the same problem one level down instead of fixing it.
  out = await replaceAsync(out, /<link\b[^>]*>/gi, async (tag) => {
    if (!/\brel=["']?stylesheet["']?/i.test(tag)) return tag;
    const hrefMatch = /\bhref=(["'])([^"']+)\1/i.exec(tag);
    if (!hrefMatch || !isRelativeUrl(hrefMatch[2])) return tag;
    const cssPath = resolveRelativePath(dir, hrefMatch[2]);
    if (!cssPath) return tag;
    try {
      const cssText = decodeBase64Utf8(await fetchContentsBase64(owner, repo, cssPath, ref));
      const rewritten = await inlineCssUrls(cssText, owner, repo, ref, dirOf(cssPath));
      return `<style>${rewritten}</style>`;
    } catch {
      return tag;
    }
  });

  // Inline <style>...</style> blocks and style="..." attributes.
  out = await replaceAsync(out, /<style\b([^>]*)>([\s\S]*?)<\/style>/gi, async (full, attrs, css) => {
    const rewritten = await inlineCssUrls(css, owner, repo, ref, dir);
    return `<style${attrs}>${rewritten}</style>`;
  });
  out = await replaceAsync(out, /\bstyle=(["'])((?:(?!\1)[\s\S])*)\1/gi, async (full, quote, css) => {
    if (!/url\(/i.test(css)) return full;
    const rewritten = await inlineCssUrls(css, owner, repo, ref, dir);
    return `style=${quote}${rewritten}${quote}`;
  });

  return out;
}

export async function handleMessage({ owner, repo, path, ref }) {
  const html = decodeBase64Utf8(await fetchContentsBase64(owner, repo, path, ref));
  return { html: await inlineHtmlAssets(html, owner, repo, ref, dirOf(path)) };
}
