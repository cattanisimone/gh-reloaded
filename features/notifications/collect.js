// features/notifications/collect.js — reads the notifications the page has
// already loaded and normalises what the REST API returns. Rows are the
// list items of the inbox (li.notifications-list-item, a stable non-hashed
// class); each one is keyed by owner/repo#number (or kind:path for other
// subjects), never by data-notification-id, which is not the REST thread id.
// No CSS-module class is read. A missing anchor yields no rows (the engine
// then makes no request) and is retried on the next scan.
//
// The pure helpers at the top are unit-tested in Node; readPage() needs a DOM.

(function (global) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // The reason as the inbox displays it (lowercase text) -> internal reason.
  const LABELS = {
    "review requested": "review_requested",
    mentioned: "mention",
    "team mentioned": "team_mention",
    subscribed: "subscribed",
    commented: "comment",
    "ci activity": "ci_activity",
    assigned: "assign",
    author: "author",
    "state change": "state_change",
    "approval requested": "approval_requested",
    "security alert": "security_alert",
    invitation: "invitation",
    manual: "manual",
  };

  function reasonFromLabel(label) {
    return Object.hasOwn(LABELS, norm(label)) ? LABELS[norm(label)] : "unknown";
  }

  // A subject URL (absolute or relative, with or without query/hash) ->
  // { kind, owner, repo, number, key, path }. Kind "pull" / "issue" carry
  // owner/repo#number; anything else is keyed by its path.
  function parseSubject(href) {
    let u;
    try {
      u = new URL(String(href), "https://github.com");
    } catch {
      return null;
    }
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    const [owner, repo, type, id] = parts;
    const number = Number(id);
    if ((type === "pull" || type === "issues") && Number.isInteger(number) && number > 0) {
      const kind = type === "pull" ? "pull" : "issue";
      return { kind, owner, repo, number, key: `${owner}/${repo}#${number}`.toLowerCase(), path: u.pathname };
    }
    const other = type === "discussions" ? "discussion" : type === "commit" ? "commit" : type === "actions" ? "run" : type === "releases" ? "release" : type;
    return { kind: other, owner, repo, number: null, key: `${other}:${u.pathname}`.toLowerCase(), path: u.pathname };
  }

  // GET /notifications item -> the same shape as a page row.
  function fromApiItem(item) {
    const url = item?.subject?.url || "";
    const m = /\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)$/.exec(url);
    if (m) {
      const kind = m[3] === "pulls" ? "pull" : "issue";
      return { kind, owner: m[1], repo: m[2], number: Number(m[4]), key: `${m[1]}/${m[2]}#${m[4]}`.toLowerCase(), reason: item.reason || "unknown", inPage: false, title: item.subject?.title || "" };
    }
    const full = item?.repository?.full_name || "";
    const type = String(item?.subject?.type || "other").toLowerCase();
    return { kind: type, owner: full.split("/")[0] || "", repo: full.split("/")[1] || "", number: null, key: `${type}:${full}:${item?.id || url}`.toLowerCase(), reason: item?.reason || "unknown", inPage: false, title: item?.subject?.title || "" };
  }

  // REST wins over the label when both describe the same key; API-only items
  // are appended with inPage: false. Returns rows plus the union size.
  function mergeApi(pageRows, apiItems) {
    const byKey = new Map(pageRows.map((r) => [r.key, { ...r, inPage: true }]));
    for (const item of apiItems || []) {
      const have = byKey.get(item.key);
      if (have) have.reason = item.reason;
      else byKey.set(item.key, item);
    }
    return [...byKey.values()];
  }

  // --- DOM -----------------------------------------------------------------

  function labelOf(li, link) {
    const leaves = [...li.querySelectorAll("*")].filter((el) => !el.children.length && !link.contains(el) && norm(el.textContent));
    const known = leaves.find((el) => Object.hasOwn(LABELS, norm(el.textContent)));
    if (known) return known.textContent;
    const marked = leaves.find((el) => /reason/i.test(el.getAttribute("class") || "") || el.hasAttribute("data-reason"));
    return marked ? marked.textContent : "";
  }

  function subjectLink(li) {
    const anchors = [...li.querySelectorAll("a[href]")].map((a) => ({ a, s: parseSubject(a.href) })).filter((x) => x.s);
    return anchors.find((x) => x.s.kind === "pull" || x.s.kind === "issue") || anchors[0] || null;
  }

  // The key of one inbox row, the same one readPage() and the engine use; null
  // when the row has no subject link.
  function keyOf(li) {
    const found = subjectLink(li);
    return found ? found.s.key : null;
  }

  function readPage(doc = document) {
    const me = doc.querySelector('meta[name="user-login"]')?.getAttribute("content") || "";
    const rows = [];
    const seen = new Set();
    for (const li of doc.querySelectorAll("li.notifications-list-item")) {
      const found = subjectLink(li);
      if (!found || seen.has(found.s.key)) continue;
      seen.add(found.s.key);
      const rawLabel = labelOf(li, found.a).trim();
      rows.push({
        key: found.s.key,
        kind: found.s.kind,
        owner: found.s.owner,
        repo: found.s.repo,
        number: found.s.number,
        reason: reasonFromLabel(rawLabel),
        rawLabel,
        unread: li.classList.contains("notification-unread"),
        inPage: true,
      });
    }
    return { me, rows, hasPagination: !!doc.querySelector('nav[aria-label="Pagination"]') };
  }

  global.GHNT_COLLECT = { reasonFromLabel, parseSubject, fromApiItem, mergeApi, readPage, keyOf, LABELS };
})(typeof window !== "undefined" ? window : globalThis);
