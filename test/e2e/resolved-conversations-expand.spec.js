// E2E: Resolved conversations, keyboard and screen reader contract.
import { test, expect } from "./support/extension.js";
import { PR, bar, button, label, status, resolvedThreads, setup } from "./support/resolved.js";

test("Tab reaches the button before the first conversation's chevron; Enter and Space toggle; focus stays", async ({ context, page }) => {
  await setup(context, { delay: 60 });
  await page.goto(PR);
  await expect(bar(page)).toBeVisible();
  await page.locator("select").focus(); // the last focusable element before the bar
  await page.keyboard.press("Tab");
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(button(page)).toBeFocused();
  await expect(button(page)).toHaveText("Collapse all resolved");
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(button(page)).toHaveText("Expand all resolved");
  await expect(button(page)).toBeFocused();
  // The next Tab goes to the first conversation's chevron.
  await page.keyboard.press("Tab");
  await expect(resolvedThreads(page).first().locator("button.review-thread-chevron")).toBeFocused();
});

test("the accessible name is exactly the visible text, the count is the description, aria-expanded mirrors the state", async ({ context, page }) => {
  await setup(context);
  await page.goto(PR);
  await expect(bar(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute("type", "button");
  await expect(button(page)).not.toHaveAttribute("aria-label", /.*/);
  await expect(button(page)).toHaveAccessibleName("Expand all resolved");
  await expect(button(page)).toHaveAccessibleDescription("7 resolved conversations");
  await expect(button(page)).toHaveAttribute("aria-expanded", "false");
  expect(await button(page).getAttribute("aria-describedby")).toBe(await label(page).getAttribute("id"));
  await button(page).click();
  await expect(button(page)).toHaveAccessibleName("Collapse all resolved");
  await expect(button(page)).toHaveAccessibleDescription("7 of 7 resolved conversations expanded");
  await expect(button(page)).toHaveAttribute("aria-expanded", "true");
});

test("Expanding: aria-disabled (never disabled), focus kept, activation ignored, status empty until the end", async ({ context, page }) => {
  await setup(context, { delay: 120 });
  await page.goto(`${PR}?n=10`);
  await expect(bar(page)).toBeVisible();
  await expect(status(page)).toHaveAttribute("role", "status");
  await expect(status(page)).toHaveAttribute("aria-live", "polite");
  await button(page).focus();
  await page.keyboard.press("Enter");
  await expect(button(page)).toHaveAccessibleName("Expanding…");
  await expect(button(page)).toHaveAttribute("aria-disabled", "true");
  await expect(button(page)).not.toHaveAttribute("disabled", /.*/);
  await expect(button(page)).toBeFocused();
  await expect(label(page)).toHaveText("10 resolved conversations");
  // Activation while busy is ignored: neither a second run nor a collapse.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await button(page).click({ force: true }); // Playwright would otherwise wait for aria-disabled to go
  await expect(status(page)).toHaveText("");
  await expect(button(page)).toBeFocused();
  await expect(status(page)).toHaveText("10 resolved conversations expanded", { timeout: 20000 });
  await expect(button(page)).toHaveText("Collapse all resolved");
  await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
  await expect(button(page)).toBeFocused();
  await expect(page.locator('review-thread-collapsible[data-resolved="true"] > div > button[aria-expanded="true"]')).toHaveCount(10);
});

test("the status region exists, empty, before any action and is the only text the bar adds besides label and button", async ({ context, page }) => {
  await setup(context);
  await page.goto(PR);
  await expect(bar(page)).toBeVisible();
  await expect(status(page)).toHaveCount(1);
  await expect(status(page)).toHaveText("");
  expect(await bar(page).evaluate((b) => [...b.children].map((c) => c.className.split(" ")[0]))).toEqual(["ghrc-label", "Button", "ghrc-status"]);
});
