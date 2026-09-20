// features/html-preview/sandbox.js — the actual rendering surface for a
// previewed file's HTML, loaded into a manifest-declared "sandbox" page
// (see manifest.json's `sandbox.pages`). Chrome gives pages listed there
// their own separate, permissive-by-default CSP (inline scripts, eval,
// no base-uri restriction) and a unique opaque origin with no access to
// any chrome.* API — this is the documented mechanism for rendering
// untrusted HTML/JS safely, and the only way to actually get one: a
// plain `<iframe srcdoc>` anywhere else always inherits its immediate
// parent's CSP (github.com's, or the extension's own `extension_pages`
// CSP, which MV3 forces to `script-src 'self'` with no override) — both
// of which block exactly the inline <script> and <base> tags a real
// HTML file needs. preview.js posts the fetched content here instead of
// writing it directly for that reason.
//
// manifest.json's `sandbox.content_security_policy` for this page is
// wide open on top of that (any script/style/image/font/connect source,
// not just inline) — a previewed file may load anything a normal page
// could, e.g. Mermaid or another diagram lib off a CDN. That's safe to
// allow broadly here specifically because this page has no cookies, no
// chrome.* access, and no same-origin capability towards github.com or
// the extension regardless of how permissive script-src is — the origin
// isolation is what protects everything else, not CSP strictness.
window.addEventListener("message", (e) => {
  if (e.source !== window.parent || typeof e.data?.html !== "string") return;
  document.open();
  document.write(e.data.html);
  document.close();
});
