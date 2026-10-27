// features/notifications/route.js — where the notifications engine runs.
// One pure helper decides it: the inbox list at /notifications (any query
// string: filters, Saved, Done, pagination) and nothing else. Sub-pages such
// as /notifications/subscriptions never start it. Loaded first as a plain
// global, like the other features' helpers.

(function (global) {
  function isInboxRoute(url) {
    let u;
    try {
      u = new URL(String(url), "https://github.com");
    } catch {
      return false;
    }
    if (u.hostname !== "github.com") return false;
    return u.pathname.replace(/\/+$/, "") === "/notifications";
  }

  global.GHNT_ROUTE = { isInboxRoute };
})(typeof window !== "undefined" ? window : globalThis);
