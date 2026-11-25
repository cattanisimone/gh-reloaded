// E2E: accessibility of "Viewed per folder". The count is the folder row's accessible description
// (our hidden text added to GitHub's own aria-describedby), the row's name stays the folder name.
// The gate reads Chrome's real accessibility tree (CDP), after the first render, after React rewrites
// and remounts a row, after a native tick and after collapse and expand.
import { test, expect } from "./support/extension.js";
import { openFiles, indicators, settled } from "./support/viewed.js";

async function axOf(context, page, id) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[id="${id}"]` });
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
  await cdp.detach();
  const n = nodes[0];
  return { role: n.role?.value, name: n.name?.value, description: n.description?.value, ignored: n.ignored };
}

const QUERY = "viewed=server/api/src/handlers/auth.rs";

test("gate (a): the folder row's description is the tooltip text and its name is the folder name alone", async ({ context, page }) => {
  await openFiles(context, page, { query: QUERY });
  await settled(page);
  const ind = await indicators(page);
  for (const id of ["server/api/src/handlers", "server", "docs"]) {
    const ax = await axOf(context, page, id);
    expect(ax.role).toBe("treeitem");
    expect(ax.description).toBe(ind[id].text);
    expect(ax.name).toBe(id.split("/").pop());
    expect(ax.name).not.toMatch(/viewed/i);
  }
  expect((await axOf(context, page, "server/api/src/handlers")).description).toBe("1 of 2 files viewed");
});

test("gate (b): React rewrites aria-describedby and remounts the row; the description comes back at once", async ({ context, page }) => {
  await openFiles(context, page, { query: QUERY });
  await settled(page);
  const text = (await indicators(page))["server/api/src/handlers"].text;
  // Rewrite: GitHub's own id only. Our id is back in the same task (MutationObserver microtask).
  const after = await page.evaluate(async () => {
    window.__reactRewrite();
    await Promise.resolve(); // one microtask: the observer has run
    return document.getElementById("server/api/src/handlers").getAttribute("aria-describedby");
  });
  expect(after).toMatch(/_r_\w+_ ghvf-d-\d+$/);
  expect((await axOf(context, page, "server/api/src/handlers")).description).toBe(text);
  // Remount: a brand new li, the way React replaces a row.
  await page.evaluate(() => window.__rerender("server/api/src/handlers"));
  await expect(page.locator('li[id="server/api/src/handlers"] > .row-container .ghvf-ind')).toHaveCount(1);
  const ax = await axOf(context, page, "server/api/src/handlers");
  expect(ax.description).toBe(text);
  expect(ax.name).toBe("handlers");
  await expect(page.locator('li[id="server/api/src/handlers"] .ghvf-ind')).toHaveCount(1); // never two
});

test("gate (c): a native tick changes the description with the count", async ({ context, page }) => {
  await openFiles(context, page, { query: QUERY });
  await settled(page);
  await page.evaluate(() => [...document.querySelectorAll("#diffs [role=region]")].find((r) => r.querySelector("code").textContent.includes("handlers/routes.rs")).querySelector("button").click());
  await expect.poll(async () => (await axOf(context, page, "server/api/src/handlers")).description).toBe("All 2 files viewed");
  expect((await axOf(context, page, "server/api/src/handlers")).name).toBe("handlers");
});

test("gate (d): collapse and expand keep the description", async ({ context, page }) => {
  await openFiles(context, page, { query: QUERY });
  await settled(page);
  await page.locator('li[id="server"] > .row-container').click();
  await expect(page.locator('li[id="server"]')).toHaveAttribute("aria-expanded", "false");
  expect((await axOf(context, page, "server")).description).toBe("1 of 9 files viewed");
  await page.locator('li[id="server"] > .row-container').click();
  await expect(page.locator('li[id="server/api/src/handlers"]')).toHaveCount(1);
  await settled(page);
  expect((await axOf(context, page, "server/api/src/handlers")).description).toBe("1 of 2 files viewed");
  expect((await axOf(context, page, "server")).name).toBe("server");
});

test("the indicator is not focusable and not clickable: a click on it reaches the row", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  const info = await page.evaluate(() => {
    const ind = document.querySelector('li[id="server"] > .row-container .ghvf-ind');
    return { tab: ind.tabIndex, focusables: ind.querySelectorAll("a,button,input,[tabindex]").length, hidden: ind.getAttribute("aria-hidden"), roles: [...ind.querySelectorAll("[role]")].length };
  });
  expect(info).toEqual({ tab: -1, focusables: 0, hidden: "true", roles: 0 });
  await page.locator('li[id="server"] > .row-container .ghvf-ind').click();
  await expect(page.locator('li[id="server"]')).toHaveAttribute("aria-expanded", "false"); // the row's own behaviour ran
  expect(await page.evaluate(() => window.__native.untrusted)).toEqual([]);
});

test("the live region is absent: a tick is silent for a screen reader", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  await expect(page.locator('.ghvf-ind [aria-live], .ghvf-ind [role=status], .ghvf-tip[aria-live]')).toHaveCount(0);
});
