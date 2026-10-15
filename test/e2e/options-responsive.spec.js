// E2E: no sideways scroll or clipping on any panel, desktop to phone.
import { test, expect } from "./support/extension.js";
import { openOptions, PANELS } from "./support/options.js";

for (const width of [1280, 820, 375]) {
  test(`every panel fits at ${width}px`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 800 });
    const worker = await openOptions(context, page);
    await worker.evaluate(() => chrome.storage.local.set({
      quickCreateShortcuts: [{ label: "New bug", url: "https://github.com/a/b/issues/new", project: "a/1", color: "#0969da", icon: "plus" }],
    }));
    await page.reload();
    for (const id of PANELS) {
      await page.evaluate((h) => { location.hash = h; }, id);
      const bad = await page.evaluate(() => {
        const vw = window.innerWidth;
        const off = [...document.querySelectorAll(".panel-view:not([hidden]) :is(button, input, a.cfg, .switch), .nav a")]
          .filter((e) => e.getClientRects().length)
          .filter((e) => {
            if (e.closest(".nav") && getComputedStyle(e.closest(".nav")).overflowX === "auto") return false;
            const r = e.getBoundingClientRect();
            return r.left < -0.5 || r.right > vw + 0.5;
          })
          .map((e) => e.id || e.className || e.textContent);
        return { scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, off };
      });
      expect(bad, `${id} at ${width}`).toEqual({ scroll: 0, off: [] });
    }
    await expect(page.locator('.nav a[href="#advanced-section"]')).toBeAttached();
  });
}
