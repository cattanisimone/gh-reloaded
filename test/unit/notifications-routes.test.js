// isInboxRoute: the engine runs on the inbox list only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_ROUTE } = loadGlobals(["features/notifications/route.js"]);

const yes = [
  "https://github.com/notifications",
  "https://github.com/notifications/",
  "https://github.com/notifications?query=reason%3Areview-requested",
  "https://github.com/notifications?query=is%3Asaved",
  "https://github.com/notifications?query=is%3Adone",
  "https://github.com/notifications?after=Y3Vyc29y",
  "/notifications",
];
const no = [
  "https://github.com/notifications/subscriptions",
  "https://github.com/notifications/beta",
  "https://github.com/notifications/beta/archive",
  "https://github.com/notificationsx",
  "https://github.com/acme/web/notifications",
  "https://github.com/",
  "https://example.com/notifications",
  "",
];

for (const u of yes) test(`isInboxRoute: runs on ${u}`, () => assert.equal(GHNT_ROUTE.isInboxRoute(u), true));
for (const u of no) test(`isInboxRoute: not on ${JSON.stringify(u)}`, () => assert.equal(GHNT_ROUTE.isInboxRoute(u), false));
