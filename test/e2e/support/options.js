// Helpers for the Settings page specs.
import { backgroundWorker } from "./extension.js";

export async function openOptions(context, page, hash = "") {
  const worker = await backgroundWorker(context);
  const id = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${id}/options/options.html${hash}`);
  return worker;
}

export const PANELS = ["features", "tokens-section", "shortcuts-section", "advanced-section"];
