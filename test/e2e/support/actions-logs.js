// Helpers shared by the Actions log shortcuts specs.
import { routeGithub, routeApi, seedStorage } from "./extension.js";

export const JOB_URL = "https://github.com/acme/web/actions/runs/11/job/22";
export const RUN_URL = "https://github.com/acme/web/actions/runs/11";
export const TOKENS = { githubTokens: [{ id: "t1", name: "Default", token: "ghp_test", owner: "" }], defaultTokenId: "t1" };
export const SHA = "1b9e4c0a7d3f5e6a8b2c4d6e8f0a1b3c5d7e9f02";

// `probe` is the status the logs endpoint answers (302 = the expected redirect). `log` collects API requests.
export async function setup(context, { fixture = "actions-job-failed.html", probe = 302, storage = TOKENS, log = [], delay = 0, transform, clipboard = true } = {}) {
  if (clipboard) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://github.com" });
  await seedStorage(context, storage || {});
  await routeApi(context, [
    {
      match: /\/actions\/jobs\/\d+\/logs/,
      status: () => probe,
      json: () => ({}),
    },
  ]);
  context.on("request", (r) => {
    if (r.url().startsWith("https://api.github.com")) log.push(new URL(r.url()).pathname);
  });
  if (delay) {
    await context.route("https://api.github.com/**/actions/jobs/**", async (route) => {
      await new Promise((r) => setTimeout(r, delay));
      route.fallback();
    });
  }
  await routeGithub(context, fixture, { transform });
  return log;
}

export const row = (page) => page.locator(".ghals-row");
export const copyBtn = (page) => page.getByRole("button", { name: "Copy gh command" });
export const openBtn = (page) => page.getByRole("button", { name: "Open raw log" });
