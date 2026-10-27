// test/support/load-global.js — evaluates content-script files (plain IIFEs
// that attach a global, no ES modules) in a fresh context, in order, and
// returns that context so a test can read the globals they define.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export function loadGlobals(files, extra = {}) {
  const context = { ...extra };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of files) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context;
}
