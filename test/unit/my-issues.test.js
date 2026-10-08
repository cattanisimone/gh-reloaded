// Unit tests for background/my-issues.js — the pure logic behind the "My
// Issues by Project" grouping: how the dashboard's query is normalized, and
// how a flat list of issues becomes Project → Status → issues with the
// ordering and multi-project rules the feature promises.
import "../support/chrome-stub.js"; // must come first: installs globalThis.chrome
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuery, buildGroups } from "../../background/my-issues.js";

test("normalizeQuery falls back to assigned-issues when empty", () => {
  assert.equal(normalizeQuery(""), "assignee:@me is:issue is:open");
  assert.equal(normalizeQuery("   "), "assignee:@me is:issue is:open");
  assert.equal(normalizeQuery(undefined), "assignee:@me is:issue is:open");
});

test("normalizeQuery scopes a type-less query to issues", () => {
  assert.equal(normalizeQuery("assignee:@me is:open"), "assignee:@me is:open is:issue");
});

test("normalizeQuery leaves a query that already pins the type alone", () => {
  assert.equal(normalizeQuery("is:issue label:bug"), "is:issue label:bug");
  assert.equal(normalizeQuery("author:@me is:pr"), "author:@me is:pr");
  assert.equal(normalizeQuery("type:issue milestone:v1"), "type:issue milestone:v1");
});

const ISSUE = (over) => ({
  number: 1,
  title: "t",
  url: "u",
  state: "OPEN",
  updatedAt: "2026-01-01T00:00:00Z",
  nameWithOwner: "acme/web",
  projectItems: [],
  ...over,
});

const inProject = (id, title, number, status) => ({
  projectId: id,
  projectTitle: title,
  projectNumber: number,
  projectUrl: `https://github.com/orgs/acme/projects/${number}`,
  status, // { name, color, optionId } | null
});

test("buildGroups puts an issue with no project items into noProject", () => {
  const { projects, noProject } = buildGroups([ISSUE({ number: 7, projectItems: [] })]);
  assert.equal(projects.length, 0);
  assert.equal(noProject.length, 1);
  assert.equal(noProject[0].number, 7);
});

test("buildGroups places an issue under every project it belongs to, with that project's status", () => {
  const issue = ISSUE({
    number: 42,
    projectItems: [
      inProject("P1", "Alpha", 1, { name: "In progress", color: "YELLOW", optionId: "o-prog" }),
      inProject("P2", "Beta", 2, { name: "Todo", color: "GRAY", optionId: "o-todo" }),
    ],
  });
  const { projects } = buildGroups([issue]);
  assert.deepEqual(
    projects.map((p) => p.title),
    ["Alpha", "Beta"]
  );
  // Same issue object, one per project, under the per-project status.
  assert.equal(projects[0].statuses[0].name, "In progress");
  assert.equal(projects[0].statuses[0].issues[0].number, 42);
  assert.equal(projects[1].statuses[0].name, "Todo");
  assert.equal(projects[1].statuses[0].issues[0].number, 42);
});

test("buildGroups orders statuses by the project's real option order, with No Status last", () => {
  const mk = (n, opt) =>
    ISSUE({ number: n, projectItems: [inProject("P1", "Alpha", 1, opt && { name: opt.name, color: "GRAY", optionId: opt.id })] });
  const issues = [
    mk(1, { name: "Done", id: "o-done" }),
    mk(2, { name: "Todo", id: "o-todo" }),
    mk(3, null), // no status
    mk(4, { name: "In progress", id: "o-prog" }),
  ];
  // The project's board order: Todo → In progress → Done.
  const order = { P1: { "o-todo": 0, "o-prog": 1, "o-done": 2 } };
  const { projects } = buildGroups(issues, order);
  assert.deepEqual(
    projects[0].statuses.map((s) => s.name),
    ["Todo", "In progress", "Done", null]
  );
});

test("buildGroups sorts projects by title and issues by most-recently-updated", () => {
  const issues = [
    ISSUE({ number: 1, updatedAt: "2026-02-01T00:00:00Z", projectItems: [inProject("Z", "Zeta", 9, null)] }),
    ISSUE({ number: 2, updatedAt: "2026-05-01T00:00:00Z", projectItems: [inProject("Z", "Zeta", 9, null)] }),
    ISSUE({ number: 3, updatedAt: "2026-03-01T00:00:00Z", projectItems: [inProject("A", "Alpha", 1, null)] }),
  ];
  const { projects } = buildGroups(issues);
  assert.deepEqual(
    projects.map((p) => p.title),
    ["Alpha", "Zeta"]
  );
  // Zeta's No Status group: #2 (May) before #1 (Feb).
  assert.deepEqual(
    projects[1].statuses[0].issues.map((i) => i.number),
    [2, 1]
  );
});

test("buildGroups counts a project across all its status groups", () => {
  const issues = [
    ISSUE({ number: 1, projectItems: [inProject("P1", "Alpha", 1, { name: "Todo", color: "GRAY", optionId: "a" })] }),
    ISSUE({ number: 2, projectItems: [inProject("P1", "Alpha", 1, { name: "Done", color: "GREEN", optionId: "b" })] }),
  ];
  const { projects } = buildGroups(issues);
  assert.equal(projects[0].count, 2);
});
