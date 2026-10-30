// Per-token access diagnostics for the Settings page. Read-only and on
// request: the caller passes one card's token and the targets the user named,
// and gets back a status per capability that says only what the API
// responses prove. Deliberately not built on lib/github-api.js: that client
// resolves a token by owner, caches, and can fall back to the default token,
// while a diagnostic must use exactly the credential of the card it was
// started from and never retry with another one.

export const STATUS = {
  AVAILABLE: "available",
  DENIED: "denied",
  NOT_VERIFIED: "not-verified",
  NOT_CHECKED: "not-checked",
  TEMPORARY: "temporary",
};

export const STATUS_LABEL = {
  [STATUS.AVAILABLE]: "Available",
  [STATUS.DENIED]: "Access denied",
  [STATUS.NOT_VERIFIED]: "Not verified",
  [STATUS.NOT_CHECKED]: "Not checked",
  [STATUS.TEMPORARY]: "Temporary error",
};

export const MAX_REQUESTS = 5;
export const CONCURRENCY = 2;
export const TIMEOUT_MS = 10000;

const API = "https://api.github.com";
const NAME = /^[A-Za-z0-9_.-]+$/;

const DOCS = {
  fineGrained: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token",
  classic: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic",
  sso: "https://docs.github.com/en/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on",
  orgPolicy: "https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization",
  rateLimit: "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
};

// The prefix only picks which remedy wording to show; it never states how the
// token is configured.
export function tokenType(token) {
  if (/^github_pat_/.test(token || "")) return "fine-grained";
  if (/^ghp_/.test(token || "")) return "classic";
  return "unknown";
}

// Replaces every occurrence of the token in text, so a message that echoes the
// credential can never reach the page.
export function scrub(text, token) {
  const s = String(text ?? "");
  return token ? s.split(token).join("…") : s;
}

// --- Targets ---

function parseRepo(value) {
  const v = String(value || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/, "");
  const [owner, name, ...rest] = v.split("/");
  if (!owner || !name || rest.length || !NAME.test(owner) || !NAME.test(name) || /^\.+$/.test(owner) || /^\.+$/.test(name)) return null;
  return { owner, name };
}

function parseProject(value) {
  const m = String(value || "").trim().match(/^(?:https?:\/\/)?github\.com\/(orgs|users)\/([A-Za-z0-9_.-]+)\/projects\/(\d+)(?:[/?#]|$)/i);
  return m ? { kind: m[1].toLowerCase(), owner: m[2], number: Number(m[3]) } : null;
}

// raw: {repo, issue, project, file} as typed. Returns the parsed targets and,
// per invalid field, the message to show; with any error nothing is sent.
export function parseTargets(raw) {
  const errors = {};
  const targets = { repo: null, issue: null, project: null, file: null };
  targets.repo = parseRepo(raw.repo);
  if (!targets.repo) errors.repo = "Name a repository to check, as owner/repo.";

  const issue = String(raw.issue || "").trim().replace(/^#/, "");
  if (issue) {
    if (/^\d+$/.test(issue) && Number(issue) > 0) targets.issue = Number(issue);
    else errors.issue = "Use an issue number, e.g. 12.";
  }
  const project = String(raw.project || "").trim();
  if (project) {
    targets.project = parseProject(project);
    if (!targets.project) errors.project = "Use a project URL: github.com/orgs/<org>/projects/<n> or github.com/users/<user>/projects/<n>.";
  }
  const file = String(raw.file || "").trim().replace(/^\/+/, "");
  if (file) {
    if (file.split("/").some((s) => s === "" || s === "." || s === "..")) errors.file = "Use a path inside the repository, e.g. docs/index.html.";
    else targets.file = file;
  }
  return { targets, errors, ok: Object.keys(errors).length === 0 };
}

// --- Checks ---

// One entry per capability; an absent optional target yields a Not checked
// entry without a request. At most MAX_REQUESTS carry a request.
export function buildChecks({ repo, issue, project, file }) {
  const slug = `${repo.owner}/${repo.name}`;
  const checks = [{ id: "auth", kind: "auth", label: "Authentication", resource: "api.github.com/user", request: { url: `${API}/user` } }];
  checks.push({
    id: "repo",
    kind: "repo",
    label: "Repository & issues",
    resource: issue ? `${slug}, issue #${issue}` : `${slug}, issues list`,
    request: { url: issue ? `${API}/repos/${slug}/issues/${issue}` : `${API}/repos/${slug}/issues?per_page=1` },
  });
  checks.push({
    id: "pulls",
    kind: "pulls",
    label: "Pull requests",
    resource: `${slug}, pull requests list`,
    request: { url: `${API}/repos/${slug}/pulls?per_page=1` },
  });
  if (project) {
    const root = project.kind === "orgs" ? "organization" : "user";
    checks.push({
      id: "project",
      kind: "project",
      label: "Projects v2",
      resource: `${project.owner} project ${project.number}`,
      project,
      request: {
        url: `${API}/graphql`,
        method: "POST",
        body: JSON.stringify({
          query: `query($login:String!,$number:Int!){${root}(login:$login){projectV2(number:$number){id}}}`,
          variables: { login: project.owner, number: project.number },
        }),
      },
    });
  } else {
    checks.push({ id: "project", kind: "project", label: "Projects v2", resource: "No project given", skip: "Give a Projects v2 URL to check it." });
  }
  if (file) {
    checks.push({
      id: "file",
      kind: "file",
      label: "Private contents",
      resource: `${slug}/${file}`,
      request: { url: `${API}/repos/${slug}/contents/${file.split("/").map(encodeURIComponent).join("/")}` },
    });
  } else {
    checks.push({ id: "file", kind: "file", label: "Private contents", resource: "No private file given", skip: "Give a file path to check reading private contents." });
  }
  return checks;
}

// --- Classification ---

function hasToken(list, name) {
  return String(list || "").split(",").map((s) => s.trim()).includes(name);
}

function rateLimitReason(headers, now) {
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) {
    const when = new Date(reset * 1000);
    if (when.getTime() > now) return `GitHub's rate limit was reached; it resets at ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  }
  return "GitHub's rate limit was reached; try again in a few minutes.";
}

// result: {status?, headers?, message?, errors?, projectNull?, partial?,
// failure?: "network"|"timeout"|"parse"}. `headers` keys are lower-case,
// `message` is GitHub's own message (matched, never displayed), `errors` the
// GraphQL error types. ctx: {kind, token, project, now}.
export function classify(result, ctx) {
  const { kind, token = "", project = null, now = Date.now() } = ctx;
  const type = tokenType(token);
  const headers = result.headers || {};
  const message = String(result.message || "");
  const errors = result.errors || [];
  const out = (status, reason, remedy = null) => ({ status, reason, remedy });
  const userProject = kind === "project" && project && project.kind === "users";

  // Projects owned by a personal account: the remedy follows the URL, not the
  // error, because a fine-grained token cannot be granted access to them.
  const userProjectRemedy = {
    text: type === "classic"
      ? "Projects owned by a personal account need the read:project scope on a classic token (project also works; read:project is the read-only one). Add it to this token."
      : type === "fine-grained"
        ? "Projects owned by a personal account cannot be read by a fine-grained token. Use a classic token with the read:project scope (project also works; read:project is the read-only one)."
        : "Projects owned by a personal account need access to the read:project scope. If this token cannot grant it, use a classic token with the read:project scope (project also works; read:project is the read-only one).",
    href: DOCS.classic,
  };
  const withProjectRemedy = (r) => (userProject && (r.status === STATUS.DENIED || r.status === STATUS.NOT_VERIFIED) ? { ...r, remedy: userProjectRemedy } : r);

  if (result.failure === "timeout") return out(STATUS.TEMPORARY, "GitHub did not answer within 10 seconds. Try again.");
  if (result.failure === "network") return out(STATUS.TEMPORARY, "The request could not reach GitHub (network error). Try again.");
  if (result.failure === "parse") return out(STATUS.TEMPORARY, `GitHub sent an unreadable answer${result.status ? ` (HTTP ${result.status})` : ""}. Try again.`);

  const status = result.status;
  if (status === 401) {
    return out(STATUS.DENIED, "GitHub rejected this token: it is invalid, expired or revoked.", { text: "Create or regenerate the token and paste it again.", href: type === "fine-grained" ? DOCS.fineGrained : DOCS.classic });
  }
  if (status >= 500) return out(STATUS.TEMPORARY, `GitHub answered HTTP ${status}. Try again later.`);

  const limited = ((status === 403 || status === 429) && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined || status === 429 || /secondary rate limit|rate limit exceeded|abuse detection/i.test(message))) || errors.includes("RATE_LIMITED");
  if (limited) {
    return out(STATUS.TEMPORARY, rateLimitReason(headers, now), { text: "Wait for the limit to reset, then run the checks again.", href: DOCS.rateLimit });
  }

  if (status === 403) {
    const sso = String(headers["x-github-sso"] || "");
    if (/required/i.test(sso)) {
      const url = (sso.match(/url=(\S+)/) || [])[1];
      const href = url && url.startsWith("https://github.com/") ? url : DOCS.sso;
      return out(STATUS.DENIED, "This organization requires SAML SSO authorization for the token.", { text: "Authorize the token for the organization, then run the checks again.", href });
    }
    if (/resource not accessible by personal access token/i.test(message)) {
      return withProjectRemedy(out(STATUS.DENIED, "GitHub says the token lacks access to this resource.", permissionRemedy(kind, type, headers, project)));
    }
    if (/forbids access via|personal access token.*(policy|not been approved|pending)|lifetime/i.test(message)) {
      return withProjectRemedy(out(STATUS.DENIED, "The organization's token policy does not allow this token (approval, lifetime or classic-token restriction).", { text: "Ask an organization owner to approve the token or relax the policy.", href: DOCS.orgPolicy }));
    }
    return withProjectRemedy(out(STATUS.NOT_VERIFIED, "Forbidden, without a reason that proves what is missing.", ambiguousRemedy()));
  }

  if (kind === "project" && status === 200) {
    if (errors.includes("INSUFFICIENT_SCOPES")) {
      return withProjectRemedy(out(STATUS.DENIED, "GitHub says the token lacks the scope or permission to read Projects.", permissionRemedy("project", type, headers, project)));
    }
    if (/resource not accessible by personal access token/i.test(message)) {
      return withProjectRemedy(out(STATUS.DENIED, "GitHub says the token lacks access to this resource.", permissionRemedy("project", type, headers, project)));
    }
    if (errors.length || result.partial || result.projectNull) {
      return withProjectRemedy(out(STATUS.NOT_VERIFIED, "GitHub returned no project: it may not exist, or this token may not see it.", ambiguousRemedy()));
    }
    return out(STATUS.AVAILABLE, "The project is readable with this token.");
  }

  if (status >= 200 && status < 300) {
    return out(STATUS.AVAILABLE, availableReason(kind));
  }
  if (status === 404 || status === 410 || status === 422 || status === 451) {
    return withProjectRemedy(out(STATUS.NOT_VERIFIED, "Not found or not visible to this token. It may not exist, the token may lack access, or the organization may not have approved it yet.", ambiguousRemedy()));
  }
  return out(STATUS.TEMPORARY, `GitHub answered HTTP ${status ?? "?"}. Try again later.`);
}

function availableReason(kind) {
  if (kind === "auth") return "The token authenticates.";
  if (kind === "file") return "The file is readable with this token.";
  return "This resource is readable with this token.";
}

function ambiguousRemedy() {
  return { text: "Check the resource name, the token's repository selection or scopes, and whether the organization approved the token." };
}

function permissionRemedy(kind, type, headers, project) {
  if (type === "classic") {
    const have = String(headers["x-oauth-scopes"] || "").trim() || "none";
    const need = String(headers["x-accepted-oauth-scopes"] || "").trim();
    return {
      text: `Add a scope to this classic token. Accepted for this request: ${need || "not stated"}. Granted: ${have}.`,
      href: DOCS.classic,
    };
  }
  if (kind === "project") {
    const text = project && project.kind === "users"
      ? ""
      : "Grant Organization → Projects: read on the token.";
    return { text, href: DOCS.fineGrained };
  }
  const perm = kind === "file" ? "Contents: read" : kind === "pulls" ? "Pull requests: read (and Metadata)" : "Issues: read (and Metadata)";
  return { text: `Include this repository in the token's selection and grant ${perm}.`, href: DOCS.fineGrained };
}

// --- Runner ---

const lower = (headers) => {
  const out = {};
  headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
};

async function send(check, token, { signal, fetch, timeoutMs }) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
    if (check.request.body) headers["Content-Type"] = "application/json";
    const res = await fetch(check.request.url, {
      method: check.request.method || "GET",
      headers,
      body: check.request.body,
      signal: ctl.signal,
      credentials: "omit",
      cache: "no-store",
    });
    const result = { status: res.status, headers: lower(res.headers) };
    if (check.kind === "file" && res.ok) {
      // Only the status matters: never read the file content.
      try { await res.body?.cancel(); } catch { /* nothing to cancel */ }
      return result;
    }
    let body = null;
    try { body = await res.json(); } catch { body = undefined; }
    if (body === undefined) {
      if (res.ok) result.failure = "parse";
      return result;
    }
    if (body && typeof body.message === "string") result.message = body.message;
    if (check.kind === "auth" && res.ok && body && typeof body.login === "string") result.login = body.login;
    if (check.kind === "project") {
      result.errors = Array.isArray(body?.errors) ? body.errors.map((e) => String(e?.type || e?.extensions?.code || "")).filter(Boolean) : [];
      const data = body?.data;
      const node = data && (data.organization ?? data.user);
      result.projectNull = !node || !node.projectV2;
      result.partial = Array.isArray(body?.errors) && body.errors.length > 0 && !!data;
      if (Array.isArray(body?.errors) && !result.errors.length) result.errors = ["UNKNOWN"];
      // Matched by classify(), never displayed.
      if (Array.isArray(body?.errors)) result.message = body.errors.map((e) => String(e?.message || "")).join(" ");
    }
    return result;
  } catch (err) {
    if (timedOut) return { failure: "timeout" };
    if (signal?.aborted) throw err;
    return { failure: "network" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Authentication goes first alone: on a 401 the others would fail for the same
// reason and are reported as Not checked. The rest runs two at a time.
// Resolves to one result per check, in order; rejects with AbortError when the
// signal fires (the caller discards the run).
export async function runDiagnostics(token, rawTargets, { signal, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, onProgress } = {}) {
  const { targets, ok } = parseTargets(rawTargets);
  if (!ok) throw new Error("Invalid targets");
  const checks = buildChecks(targets);
  const results = new Array(checks.length);

  const finish = (i, result) => {
    const c = checks[i];
    const cls = classify(result, { kind: c.kind, token, project: c.project, now: Date.now() });
    let reason = cls.reason;
    if (c.kind === "auth" && cls.status === STATUS.AVAILABLE && result.login) {
      const type = tokenType(token);
      reason = `Authenticated as ${result.login}${type === "unknown" ? "" : `, ${type} token`}.`;
    }
    results[i] = {
      id: c.id,
      label: c.label,
      resource: scrub(c.resource, token),
      status: cls.status,
      reason: scrub(reason, token),
      remedy: cls.remedy ? { text: scrub(cls.remedy.text, token), href: cls.remedy.href } : null,
      at: Date.now(),
    };
    onProgress?.(results.filter(Boolean).length, checks.length);
  };
  const skip = (i, reason) => {
    const c = checks[i];
    results[i] = { id: c.id, label: c.label, resource: c.resource, status: STATUS.NOT_CHECKED, reason: scrub(reason, token), remedy: null, at: Date.now() };
  };
  const opts = { signal, fetch, timeoutMs };

  finish(0, await send(checks[0], token, opts));
  const authDenied = results[0].status === STATUS.DENIED;
  const isLimited = (r) => r.status === STATUS.TEMPORARY && /limit/i.test(r.reason);
  const LIMITED_REASON = "Skipped: GitHub is rate-limiting this token. Wait for the limit to reset.";
  let limited = isLimited(results[0]);
  const queue = [];
  for (let i = 1; i < checks.length; i++) {
    if (checks[i].skip) skip(i, checks[i].skip);
    else if (authDenied) skip(i, "Skipped: the token itself was rejected.");
    else if (limited) skip(i, LIMITED_REASON);
    else queue.push(i);
  }
  const worker = async () => {
    while (queue.length) {
      const i = queue.shift();
      if (limited) {
        skip(i, LIMITED_REASON);
        continue;
      }
      finish(i, await send(checks[i], token, opts));
      if (isLimited(results[i])) limited = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return results;
}

export function summarize(results) {
  const checked = results.filter((r) => r.status !== STATUS.NOT_CHECKED);
  const parts = [STATUS.AVAILABLE, STATUS.DENIED, STATUS.NOT_VERIFIED, STATUS.TEMPORARY]
    .map((s) => [checked.filter((r) => r.status === s).length, STATUS_LABEL[s].toLowerCase()])
    .filter(([n]) => n > 0)
    .map(([n, l]) => `${n} ${l}`);
  return `${checked.length} checked${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}
