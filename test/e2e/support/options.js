// Helpers for the Settings page specs.
import { backgroundWorker } from "./extension.js";

export async function openOptions(context, page, hash = "") {
  const worker = await backgroundWorker(context);
  const id = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${id}/options/options.html${hash}`);
  // The token cards are rendered once storage has been read; wait for it so a
  // click never lands on a card that is about to be replaced.
  await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
  return worker;
}

export const PANELS = ["features", "tokens-section", "shortcuts-section", "advanced-section"];
