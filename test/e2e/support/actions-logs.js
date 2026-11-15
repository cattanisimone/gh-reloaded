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

// --- Go to failed step (#134) ------------------------------------------------
export const FS_FIXTURE = "actions-job-failed-steps.html";
export const fsBtn = (page) => page.locator(".ghals-fs-btn");
export const fsRoot = (page) => page.locator(".ghals-fs");
export const fsList = (page) => page.locator(".ghals-fs-list");

const SUB_DEFAULT = ' failed\n    <relative-time datetime="2026-11-12T01:21:27Z" class="no-wrap" title="Nov 12, 2026, 1:21 AM UTC">Nov 12, 2026</relative-time> in 21m 2s\n';

function stepHtml({ n, name, conclusion = "failure", open = false, log = 0, attrs = "" }) {
  const icon = conclusion === "failure" ? "octicon-x-circle-fill color-fg-danger" : "octicon-check-circle-fill color-fg-success";
  return `<check-step data-name="${name}" data-number="${n}" data-conclusion="${conclusion}" data-expand="" data-job-completed="" data-logged-in="" data-use-actions-ux="" data-step-type="" data-catalyst="" ${attrs}><details class="Details-element CheckStep rounded-2 details-reset js-checks-log-details px-2" id="check-step-${n}" data-step-number="${n}" data-conclusion="${conclusion}" data-expand=""${open ? ' open=""' : ""}><summary class="CheckStep-header p-2 mb-1 rounded-2 js-check-step-summary uxr_CheckStep-header mx-2" style="top: 88px" data-retain-focus="" data-target="check-step.header" data-step-pending="false"><div class="d-flex flex-items-center"><svg class="octicon octicon-chevron-right js-check-step-chevron mr-2 flex-shrink-0 CheckStep-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="false"></svg><svg data-component="Octicon" class="octicon ${icon} mr-3 flex-shrink-0 ml-1" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"></svg><span class="CheckStep-title flex-1 ml-n1 mr-1"><span class="CheckStep-titleName css-truncate css-truncate-overflow user-select-none">${name}</span></span><div class="text-mono text-normal text-small float-right">3s</div></div></summary><div class="js-checks-log-display"><div class="text-mono text-small py-1 my-2 js-checks-log-display-container mx-2">${log ? `<div style="height:${log}px">log</div>` : ""}</div></div></details></check-step>\n`;
}

// Builds the transform for routeGithub: the job name, the subtitle text, the
// steps and a few markup variants, all on top of the live-shaped fixture.
//   steps [{ n, name, conclusion, open, log }]   signedOut   noHeader   hashed
export function jobPage({ name, sub, steps, signedOut = false, noHeader = false, hashed = false, dark = false, extra } = {}) {
  return (html) => {
    if (name != null) html = html.replaceAll("test (race mode)", name);
    if (sub != null) html = html.replace(SUB_DEFAULT, ` ${sub} `);
    if (steps) html = html.replace(/<!--steps:begin-->[\s\S]*<!--steps:end-->/, steps.map(stepHtml).join(""));
    if (signedOut) html = html.replace(/<div class="js-check-run-search[\s\S]*?<\/details><\/div><\/div>/, "</div>").replace(/ data-logged-in=""/g, "");
    if (hashed) html = html.replaceAll("uxr_CheckRun-header CheckRun-header", "CheckRun-header__x1Ab2").replaceAll("CheckRun-log-title", "CheckRun-log-title__q9").replaceAll("js-check-run-search CheckRun-search ", "js-check-run-search CheckRun-search__k3 ");
    if (noHeader) html = html.replaceAll("uxr_CheckRun-header CheckRun-header", "gone-header").replaceAll("CheckRun-log-title", "gone-title").replaceAll("CheckRun-search", "gone-search");
    if (dark) html = html.replace('data-color-mode="light"', 'data-color-mode="dark"');
    return extra ? extra(html) : html;
  };
}
