// E2E: light and dark each use one family of surfaces.
import { test, expect } from "./support/extension.js";
import { openOptions } from "./support/options.js";

const sample = (page) => page.evaluate(() => {
  const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bg = (el) => getComputedStyle(el).backgroundColor;
  const els = { body: document.body, sidebar: document.querySelector(".sidebar"), card: document.querySelector(".card") };
  const out = {};
  for (const [k, el] of Object.entries(els)) out[k] = lum(parse(bg(el)));
  const t = lum(parse(getComputedStyle(document.body).color));
  const L = Math.max(out.card, t), D = Math.min(out.card, t);
  out.contrast = (L + 0.05) / (D + 0.05);
  out.gradients = [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).backgroundImage !== "none").length;
  return out;
});

for (const scheme of ["light", "dark"]) {
  test(`${scheme}: sidebar, body and panels share one theme`, async ({ context, page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openOptions(context, page);
    const s = await sample(page);
    for (const k of ["body", "sidebar", "card"]) {
      if (scheme === "light") expect(s[k], k).toBeGreaterThan(0.5);
      else expect(s[k], k).toBeLessThan(0.1);
    }
    expect(s.contrast).toBeGreaterThanOrEqual(4.5);
    expect(s.gradients).toBe(0);
  });
}

test("switching the scheme on an open page re-themes everything", async ({ context, page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openOptions(context, page);
  expect((await sample(page)).sidebar).toBeGreaterThan(0.5);
  await page.emulateMedia({ colorScheme: "dark" });
  const s = await sample(page);
  expect(s.sidebar).toBeLessThan(0.1);
  expect(s.body).toBeLessThan(0.1);
  expect(s.card).toBeLessThan(0.1);
});
