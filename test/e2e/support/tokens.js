// Shared helpers for the token Settings specs. api.github.com is mocked per
// test; nothing leaves the machine.
export const FINE = "github_pat_FINE1234";
export const CLASSIC = "ghp_CLASSIC5678";

// handler(call) -> {status, headers, body}; every call is recorded.
export async function mockApi(context, handler) {
  const calls = [];
  await context.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const call = { url: req.url(), method: req.method(), auth: req.headers().authorization, body: req.postData() };
    calls.push(call);
    const { status = 200, headers = {}, body = {} } = (await handler(call)) || {};
    await route.fulfill({
      status,
      headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "*", "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  });
  return calls;
}

// A GitHub whose answers are all good: a private repository exists, every
// type is readable, a classic token (X-OAuth-Scopes present).
export const allGood = (call) => {
  const u = call.url;
  if (u.endsWith("/user")) return { headers: { "x-oauth-scopes": "repo" }, body: { login: "sam" } };
  if (u.includes("/repos?") || u.includes("/user/repos")) return { body: [{ full_name: "acme/app", private: true }] };
  if (u.endsWith("/graphql")) return { body: { data: { viewer: { projectsV2: { totalCount: 1 } }, organization: { projectsV2: { totalCount: 1 } } } } };
  if (u.includes("/actions/runs")) return { body: { workflow_runs: [] } };
  return { body: [] };
};

export const storageOf = (page, area, key) => page.evaluate(([a, k]) => chrome.storage[a].get(k), [area, key]);
