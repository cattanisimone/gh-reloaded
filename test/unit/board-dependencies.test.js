// Unit tests for background/board-dependencies.js: besides the edges between
// visible cards, it returns the issue `state` of each visible issue the
// dependency API mentioned, so the content script can hide done→done arrows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "../support/chrome-stub.js";
import { collectBoardEdges, handleMessage } from "../../background/board-dependencies.js";

const web = "https://api.github.com/repos/acme/web";

test("collectBoardEdges returns states of visible issues, from either end's lookup", async () => {
  const realFetch = globalThis.fetch;
  resetStorage({ githubTokens: [{ id: "t", name: "t", token: "x", owner: "" }], defaultTokenId: "t" });
  globalThis.fetch = async (url) => {
    const u = String(url);
    let body = [];
    if (u.includes("/issues/101/dependencies/blocking")) body = [{ number: 102, state: "closed", repository_url: web }, { number: 999, state: "open", repository_url: web }];
    if (u.includes("/issues/103/dependencies/blocked_by")) body = [{ number: 101, state: "open", repository_url: web }];
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  try {
    const items = [101, 102, 103].map((number) => ({ owner: "acme", repo: "web", number }));
    const { edges, states } = await collectBoardEdges(items);
    assert.deepEqual(edges.map((e) => `${e.from}->${e.to}`).sort(), ["acme/web#101->acme/web#102", "acme/web#101->acme/web#103"]);
    assert.deepEqual(states, { "acme/web#102": "closed", "acme/web#101": "open" });
    assert.ok(!("acme/web#999" in states), "an issue off the board is not reported");
    const msg = await handleMessage({ items });
    assert.equal(msg.states["acme/web#102"], "closed");
  } finally {
    globalThis.fetch = realFetch;
  }
});
