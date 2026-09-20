// background.js — the extension's one service worker entry point.
//
// This file itself knows nothing about any specific feature: it just
// opens Settings from the toolbar icon and routes incoming messages to
// whichever feature module declares a matching MESSAGE_TYPE. Add a new
// feature's background logic to FEATURES and it's wired in automatically
// — see background/dependency-graph.js for the shape a feature module
// takes, and CONTRIBUTING.md for the full walkthrough.

import { getToken } from "./lib/github-api.js";
import * as dependencyGraph from "./background/dependency-graph.js";
import * as boardDependencies from "./background/board-dependencies.js";
import * as htmlPreview from "./background/html-preview.js";

const FEATURES = [dependencyGraph, boardDependencies, htmlPreview];

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const feature = FEATURES.find((f) => f.MESSAGE_TYPE === msg?.type);
  if (!feature) return;

  (async () => {
    const hasToken = !!(await getToken());
    try {
      const data = await feature.handleMessage(msg.payload);
      sendResponse({ ok: true, hasToken, ...data });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e), status: e.status, hasToken });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
