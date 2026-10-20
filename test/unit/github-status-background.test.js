// Unit tests for background/github-status.js: parsing githubstatus.com's
// summary.json, the shared cache (TTL, single flight, restart), backoff and
// what is sent on the wire.
import "../support/chrome-stub.js"; // must come first: installs globalThis.chrome
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSummary, nextRetryDelay, parseRetryAfter, createStatusService, SUMMARY_URL, TTL_MS } from "../../background/github-status.js";

const component = (name, status = "operational") => ({ id: name, name, status });
const feed = (over = {}) => ({
  page: { updated_at: "2026-10-20T06:41:00Z" },
  status: { indicator: "none", description: "All Systems Operational" },
  components: [component("Git Operations"), component("Actions"), component("Copilot")],
  incidents: [],
  scheduled_maintenances: [],
  ...over,
});
const incident = (over = {}) => ({
  id: "i1",
  name: "Incident with Actions",
  status: "investigating",
  impact: "minor",
  shortlink: "https://stspg.io/abc",
  updated_at: "2026-10-20T06:38:00Z",
  components: [{ name: "Actions" }],
  incident_updates: [
    { body: "older", status: "investigating", updated_at: "2026-10-20T06:30:00Z" },
    { body: "Some workflow runs may be delayed.", status: "investigating", updated_at: "2026-10-20T06:38:00Z" },
  ],
  ...over,
});

test("operational feed: none, no affected components", () => {
  const s = parseSummary(feed());
  assert.equal(s.indicator, "none");
  assert.deepEqual(s.components, []);
  assert.deepEqual(s.incidents, []);
});

test("keeps only affected components", () => {
  const s = parseSummary(feed({ status: { indicator: "major", description: "x" }, components: [component("Actions", "partial_outage"), component("Copilot"), component("Pages", "under_maintenance")] }));
  assert.deepEqual(s.components, [{ name: "Actions", status: "partial_outage" }, { name: "Pages", status: "under_maintenance" }]);
});

for (const indicator of ["minor", "major", "critical"]) {
  test(`indicator ${indicator} passes through`, () => {
    assert.equal(parseSummary(feed({ status: { indicator, description: "d" } })).indicator, indicator);
  });
}

test("incident: newest update, components, impact, official short link", () => {
  const [i] = parseSummary(feed({ incidents: [incident()] })).incidents;
  assert.equal(i.latest.body, "Some workflow runs may be delayed.");
  assert.deepEqual(i.components, ["Actions"]);
  assert.equal(i.impact, "minor");
  assert.equal(i.url, "https://www.githubstatus.com/incidents/i1"); // stspg.io shortlink: canonical page from the id
  assert.equal(parseSummary(feed({ incidents: [incident({ shortlink: "https://www.githubstatus.com/incidents/abc" })] })).incidents[0].url, "https://www.githubstatus.com/incidents/abc");
});

test("javascript: and foreign links are never used", () => {
  assert.equal(parseSummary(feed({ incidents: [incident({ shortlink: "javascript:alert(1)" })] })).incidents[0].url, "https://www.githubstatus.com/incidents/i1");
  assert.equal(parseSummary(feed({ incidents: [incident({ shortlink: "javascript:alert(1)", id: "a/../b" })] })).incidents[0].url, "");
});

test("multiple incidents are kept in order", () => {
  const s = parseSummary(feed({ incidents: [incident(), incident({ id: "i2", name: "Incident with Git" })] }));
  assert.deepEqual(s.incidents.map((i) => i.id), ["i1", "i2"]);
});

test("only in-progress maintenances are kept", () => {
  const s = parseSummary(feed({ scheduled_maintenances: [incident({ id: "m1", status: "in_progress", impact: "maintenance" }), incident({ id: "m2", status: "scheduled" })] }));
  assert.deepEqual(s.maintenances.map((m) => m.id), ["m1"]);
  assert.equal(s.maintenances[0].impact, "none");
});

test("malformed feeds throw", () => {
  for (const bad of [null, "x", {}, feed({ status: { indicator: "weird" } }), feed({ components: {} }), feed({ incidents: null }), feed({ components: [{ name: "A", status: "on_fire" }] }), feed({ incidents: [{ name: "no id" }] })]) {
    assert.throws(() => parseSummary(bad), /Unexpected githubstatus\.com response/);
  }
});

test("backoff: 30 s, 1, 2, 4, then 5 min; Retry-After capped at 15 min", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => nextRetryDelay(n)), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  assert.equal(nextRetryDelay(1, 90), 90_000);
  assert.equal(nextRetryDelay(1, 99999), 15 * 60_000);
  assert.equal(nextRetryDelay(2, NaN), 60_000);
});

// --- service ---------------------------------------------------------------

function memoryArea() {
  const store = {};
  return {
    store,
    get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
    set: async (o) => Object.assign(store, structuredClone(o)),
  };
}
const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
function setup(responses) {
  const clock = { t: 1_000_000 };
  const calls = [];
  const area = memoryArea();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  const make = () => createStatusService({ fetchImpl, area, now: () => clock.t });
  return { clock, calls, area, make, service: make() };
}

test("ten concurrent requests make one fetch", async () => {
  const { service, calls } = setup([ok(feed())]);
  const results = await Promise.all(Array.from({ length: 10 }, () => service.get()));
  assert.equal(calls.length, 1);
  assert.ok(results.every((r) => r.snapshot.indicator === "none" && !r.error));
});

test("what is sent: official URL, no query, no credentials, no referrer", async () => {
  const { service, calls } = setup([ok(feed())]);
  await service.get();
  assert.equal(calls[0].url, SUMMARY_URL);
  assert.equal(new URL(calls[0].url).search, "");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  assert.equal(calls[0].init.headers, undefined);
});

test("TTL: cached for 5 min, then refetched", async () => {
  const { service, calls, clock } = setup([ok(feed()), ok(feed())]);
  await service.get();
  clock.t += TTL_MS - 1;
  await service.get();
  assert.equal(calls.length, 1);
  clock.t += 2;
  await service.get();
  assert.equal(calls.length, 2);
});

test("the cache survives a worker restart", async () => {
  const { service, make, calls } = setup([ok(feed())]);
  await service.get();
  const reborn = make();
  const r = await reborn.get();
  assert.equal(calls.length, 1);
  assert.equal(r.snapshot.indicator, "none");
});

test("failure keeps the last good snapshot and backs off", async () => {
  const { service, calls, clock } = setup([ok(feed({ status: { indicator: "minor", description: "d" } })), new Error("offline"), new Error("offline"), ok(feed())]);
  const first = await service.get();
  const fetchedAt = first.fetchedAt;
  clock.t += TTL_MS + 1;
  const failed = await service.get();
  assert.equal(failed.error, true);
  assert.equal(failed.snapshot.indicator, "minor");
  assert.equal(failed.fetchedAt, fetchedAt);
  clock.t += 29_000; // inside the 30 s backoff
  await service.get();
  assert.equal(calls.length, 2);
  clock.t += 2_000;
  await service.get(); // second failure, 1 min backoff
  assert.equal(calls.length, 3);
  clock.t += 59_000;
  await service.get();
  assert.equal(calls.length, 3);
  clock.t += 2_000;
  const recovered = await service.get();
  assert.equal(recovered.error, false);
  assert.equal(recovered.snapshot.indicator, "none");
});

test("429 honours Retry-After", async () => {
  const { service, calls, clock } = setup([{ ok: false, status: 429, headers: new Headers({ "retry-after": "600" }) }, ok(feed())]);
  const r = await service.get();
  assert.equal(r.error, true);
  assert.equal(r.snapshot, null);
  clock.t += 599_000;
  await service.get();
  assert.equal(calls.length, 1);
  clock.t += 2_000;
  await service.get();
  assert.equal(calls.length, 2);
});

test("Retry-After accepts delay-seconds and HTTP-dates", () => {
  const now = Date.parse("2026-10-20T08:00:00Z");
  assert.equal(parseRetryAfter("120", now), 120);
  assert.equal(parseRetryAfter("Tue, 20 Oct 2026 08:10:00 GMT", now), 600);
  assert.equal(parseRetryAfter("Tue, 20 Oct 2026 07:00:00 GMT", now), 0);
  assert.ok(Number.isNaN(parseRetryAfter("soon", now)));
  assert.ok(Number.isNaN(parseRetryAfter(null, now)));
  assert.ok(Number.isNaN(parseRetryAfter("", now)));
});

test("an HTTP-date Retry-After delays the retry", async () => {
  const start = Date.parse("2026-10-20T08:00:00Z");
  const date = new Date(start + 600_000).toUTCString();
  const { service: s2, calls: c2, clock: k2 } = setup([{ ok: false, status: 429, headers: new Headers({ "retry-after": date }) }, ok(feed())]);
  k2.t = start;
  await s2.get();
  k2.t += 590_000;
  await s2.get();
  assert.equal(c2.length, 1);
  k2.t += 20_000;
  await s2.get();
  assert.equal(c2.length, 2);
});

test("a malformed body is an error, not a snapshot", async () => {
  const { service } = setup([ok({ nope: true })]);
  const r = await service.get();
  assert.equal(r.error, true);
  assert.equal(r.snapshot, null);
});

test("force retries inside the backoff, but not twice within 5 s", async () => {
  const { service, calls, clock } = setup([new Error("x"), ok(feed())]);
  await service.get();
  clock.t += 6_000;
  const r = await service.get({ force: true });
  assert.equal(calls.length, 2);
  assert.equal(r.error, false);
  await service.get({ force: true });
  assert.equal(calls.length, 2);
});

test("a hanging request is aborted after 10 s", async () => {
  const area = memoryArea();
  const service = createStatusService({
    area,
    fetchImpl: (_u, { signal }) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
  });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 10_000 ? 5 : ms, ...a);
  try {
    const r = await service.get();
    assert.equal(r.error, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("the page indicator \"maintenance\" of a running maintenance is accepted, not a malformed feed", () => {
  const s = parseSummary(feed({ status: { indicator: "maintenance", description: "Service Under Maintenance" }, scheduled_maintenances: [incident({ id: "m1", status: "in_progress", impact: "maintenance" })] }));
  assert.equal(s.indicator, "maintenance");
  assert.equal(s.maintenances.length, 1);
});
