// Unit tests for features/image-gallery/model.js: routes, the folder set,
// listing-state precedence, wording and href encoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHIG_MODEL: M } = loadGlobals(["features/image-gallery/model.js"]);

test("supported extensions are case-insensitive and exclude other files", () => {
  for (const n of ["a.png", "a.PNG", "a.jpg", "b.JPEG", "c.webp", "d.gif", "e.svg"]) assert.equal(M.isSupportedImage(n), true, n);
  for (const n of ["README.md", "a.pdf", "a.bmp", "png", "a.png.txt", ""]) assert.equal(M.isSupportedImage(n), false, n);
});

test("parseBlobPath reads blob routes only and decodes segments", () => {
  assert.equal(M.parseBlobPath("/acme/web/blob/main/shots/a%20b.png").segments.join("/"), "main/shots/a b.png");
  assert.equal(M.parseBlobPath("/acme/web/blob/main/shots/a.png").name, "a.png");
  for (const p of ["/acme/web/blame/main/a.png", "/acme/web/raw/main/a.png", "/acme/web/tree/main/shots", "/acme/web/pull/1/files", "/acme/web/blob/main"]) {
    assert.equal(M.parseBlobPath(p), null, p);
  }
});

test("splitRef uses the known ref, even with slashes, and never counts segments", () => {
  const segs = ["feature", "foo", "bar", "shots", "a.png"];
  assert.deepEqual({ ...M.splitRef(segs, "feature/foo/bar") }, { ref: "feature/foo/bar", path: "shots/a.png" });
  assert.deepEqual({ ...M.splitRef(["main", "a.png"], "") }, { ref: "main", path: "a.png" });
  assert.equal(M.splitRef(segs, "other"), null);
});

test("imageSet keeps files only, supported images only, in source order", () => {
  const entries = [
    { name: "B.png", path: "s/B.png", type: "file" },
    { name: "x.png", path: "s/x.png", type: "dir" },
    { name: "README.md", path: "s/README.md", type: "file" },
    { name: "a.PNG", path: "s/a.PNG", contentType: "file" },
    { name: "10.jpeg", path: "s/10.jpeg", type: "file" },
    { name: "2.svg", path: "s/2.svg", type: "file" },
  ];
  assert.equal(M.imageSet(entries).map((e) => e.name).join(","), "B.png,a.PNG,10.jpeg,2.svg");
});

test("completeness: a plain count only when proven", () => {
  assert.equal(M.isComplete(200, 200), true);
  assert.equal(M.isComplete(200, null), true);
  assert.equal(M.isComplete(1000, 1000), false);
  assert.equal(M.isComplete(5, 9), false);
});

test("listing state precedence: (a) → private → rate limit → error → unknown", () => {
  const all = { blobMissing: true, privateNoToken: true, rateLimited: true, networkError: true, ambiguous: true };
  assert.equal(M.listingState(all), "none");
  assert.equal(M.listingState({ ...all, blobMissing: false }), "private");
  assert.equal(M.listingState({ ...all, blobMissing: false, privateNoToken: false }), "rate-limit");
  assert.equal(M.listingState({ rateLimited: false, networkError: true, ambiguous: true }), "error");
  assert.equal(M.listingState({ ambiguous: true }), "unknown");
  assert.equal(M.listingState({}), "ok");
});

test("notices never say the folder is empty or name a permission as proven", () => {
  for (const kind of ["incomplete", "rate-limit", "private", "error", "unknown", "not-in-list"]) {
    const n = M.noticeFor(kind);
    for (const text of [n.full, n.short, n.description]) assert.doesNotMatch(text, /empty/i, kind);
  }
  assert.equal(M.noticeFor("unknown").full, "Gallery unavailable: GitHub did not return this folder's list. GH Reloaded can't tell why.");
  assert.equal(M.noticeFor("nope"), null);
});

test("counter, tooltip, announcement and hint wording", () => {
  assert.equal(M.counterText(3, 8, false), "3 of 8");
  assert.equal(M.counterText(2, 1000, true), "2 of 1000+");
  assert.equal(M.counterTooltip(2, 1000, true), "Image 2 of at least 1000: the folder list is incomplete");
  assert.equal(M.counterTooltip(2, 8, false), "");
  assert.equal(M.announcement(3, 8, false), "image 3 of 8");
  assert.equal(M.announcement(2, 1000, true), "image 2 of at least 1000, folder list incomplete");
  assert.equal(M.hintText(3), "←→ to navigate · Esc to close");
  assert.equal(M.hintText(1), "Esc to close");
});

test("step is circular in both directions", () => {
  assert.equal(M.step(2, 1, 3), 0);
  assert.equal(M.step(0, -1, 3), 2);
  assert.equal(M.step(0, 1, 1), 0);
});

test("middleCut keeps both ends", () => {
  const long = "very-long-file-name-for-the-onboarding-flow-variant-B-final.png";
  const cut = M.middleCut(long, 30);
  assert.equal(cut.length, 30);
  assert.ok(cut.startsWith("very-") && cut.endsWith("final.png") && cut.includes("…"));
  assert.equal(M.middleCut("a.png", 30), "a.png");
});

test("fileHref encodes spaces, #, %, non-ASCII and keeps slashes in the ref", () => {
  assert.equal(M.fileHref("acme", "web", "main", "s/a b#c%d é.png"), "/acme/web/blob/main/s/a%20b%23c%25d%20%C3%A9.png");
  assert.equal(M.fileHref("acme", "web", "feature/foo/bar", "a.png"), "/acme/web/blob/feature/foo/bar/a.png");
});

test("failure messages: neutral by default, specific ones as specified", () => {
  assert.equal(M.failureMessage("whatever", "a.png").title, "Can't show this image");
  assert.equal(M.failureMessage("damaged", "a.png").title, "Can't display this image");
  assert.equal(M.failureMessage("removed", "a.png", "main").text, "a.png is no longer on main: it may have been moved or deleted after the page opened.");
  assert.equal(M.failureMessage("refused", "a.png").title, "Can't load this image");
});
