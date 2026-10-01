// Unit tests for the pure helpers in background/html-preview.js that do
// the fiddly path/URL/MIME work behind inlining a previewed file's own
// relative assets.
import "../support/chrome-stub.js"; // first: the module transitively imports lib/github-api.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRelativePath,
  isRelativeUrl,
  mimeFor,
  dirOf,
  decodeBase64Utf8,
  encodePath,
} from "../../background/html-preview.js";

test("isRelativeUrl rejects absolute and protocol-relative URLs", () => {
  assert.equal(isRelativeUrl("styles/app.css"), true);
  assert.equal(isRelativeUrl("../img/logo.png"), true);
  assert.equal(isRelativeUrl("https://example.com/x.css"), false);
  assert.equal(isRelativeUrl("//cdn.example.com/x.css"), false);
  assert.equal(isRelativeUrl("data:image/png;base64,AAAA"), false);
  assert.equal(isRelativeUrl(""), false);
});

test("resolveRelativePath walks up for ../ relative to the file's directory", () => {
  assert.equal(resolveRelativePath("docs/sub/", "../img/logo.png"), "docs/img/logo.png");
  assert.equal(resolveRelativePath("docs/sub/", "./style.css"), "docs/sub/style.css");
  assert.equal(resolveRelativePath("docs/sub/", "a/b/c.js"), "docs/sub/a/b/c.js");
});

test("resolveRelativePath treats a leading slash as repo root", () => {
  assert.equal(resolveRelativePath("docs/sub/", "/assets/app.css"), "assets/app.css");
});

test("resolveRelativePath strips query and hash before resolving", () => {
  assert.equal(resolveRelativePath("docs/", "style.css?v=2"), "docs/style.css");
  assert.equal(resolveRelativePath("docs/", "style.css#top"), "docs/style.css");
});

test("dirOf returns the directory portion, or empty for a root-level file", () => {
  assert.equal(dirOf("docs/sub/index.html"), "docs/sub/");
  assert.equal(dirOf("index.html"), "");
});

test("mimeFor maps known extensions and defaults to octet-stream", () => {
  assert.equal(mimeFor("a/b/style.CSS"), "text/css");
  assert.equal(mimeFor("logo.png"), "image/png");
  assert.equal(mimeFor("font.woff2"), "font/woff2");
  assert.equal(mimeFor("weird.xyz"), "application/octet-stream");
});

test("encodePath percent-encodes each segment but keeps the slashes", () => {
  assert.equal(encodePath("docs/a b/c+d.html"), "docs/a%20b/c%2Bd.html");
});

test("decodeBase64Utf8 round-trips multi-byte UTF-8 text", () => {
  const text = "héllo — 世界 🌍";
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  assert.equal(decodeBase64Utf8(b64), text);
});

test("decodeBase64Utf8 tolerates the newlines GitHub wraps base64 with", () => {
  const b64 = Buffer.from("hello world", "utf-8").toString("base64");
  const wrapped = b64.slice(0, 2) + "\n" + b64.slice(2);
  assert.equal(decodeBase64Utf8(wrapped), "hello world");
});
