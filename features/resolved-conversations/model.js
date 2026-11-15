// features/resolved-conversations/model.js — pure rules of "Resolved
// conversations": the copy of the bar, the toggle rule, the status texts, when
// a "K of N" result is forgotten and the pull request route. No DOM, no
// chrome.*: unit-tested through globalThis.GHRC_MODEL.

(function () {
  // Per-conversation bound of an Expand, measured live (GitHub's own content
  // load takes about one second): a conversation that is not open after this
  // is left as GitHub shows it and counted as not expanded.
  const BOUND_MS = 6000;

  function boundMs(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : BOUND_MS;
  }

  const noun = (n) => (n === 1 ? "resolved conversation" : "resolved conversations");
  const loadedNoun = (n, loadMore) => (loadMore ? `loaded ${noun(n)}` : noun(n));

  // Toggle rule: Collapse only when every loaded resolved conversation is open.
  const allOpen = (n, open) => n > 0 && open >= n;

  // `result` is K of the last Expand in which some conversations did not open
  // (null when there is none or it no longer applies).
  function label({ n, open, loadMore, result }) {
    const more = loadMore ? " · more may be hidden" : "";
    const what = loadedNoun(n, loadMore);
    if (allOpen(n, open)) return `${n} of ${n} ${what} expanded${more}`;
    if (typeof result === "number") return `${result} of ${n} ${what} expanded${more}`;
    return `${n} ${what}${more}`;
  }

  function buttonText({ allOpen: all, loadMore, busy }) {
    if (busy) return "Expanding…";
    const scope = loadMore ? "loaded" : "all";
    return `${all ? "Collapse" : "Expand"} ${scope} resolved`;
  }

  // The polite status announcement at the end of an action.
  function status({ kind, n, k, loadMore }) {
    const more = loadMore ? ", more may be hidden" : "";
    const what = loadedNoun(n, loadMore);
    if (kind === "collapsed") return `${n} ${what} collapsed${more}`;
    if (k === n) return `${n} ${what} expanded${more}`;
    return `${k} of ${n} ${what} expanded${more}`;
  }

  // A "K of N" result is the result of the last Expand only: any manual open or
  // close, or a change of the loaded set, changes the signature and ends it.
  function keepResult(result, sig) {
    return !!result && result.sig === sig;
  }

  // Conversation tab of a pull request only.
  function isRoute(pathname) {
    return /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(pathname || "");
  }

  globalThis.GHRC_MODEL = { BOUND_MS, boundMs, allOpen, label, buttonText, status, keepResult, isRoute };
})();
