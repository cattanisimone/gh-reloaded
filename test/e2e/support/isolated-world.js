// test/e2e/support/isolated-world.js — evaluates code in the extension's
// content-script ("isolated") world of a page over CDP. The notifications
// engine renders nothing, so a test has to reach the registry and the engine
// state that the content scripts expose on `GHNotifications`, and register a
// dummy module there; none of that may be a test-only file in the extension
// (the release zip would ship it).
//
// The context is the one whose auxData.type is "isolated" and whose name is
// the extension's (from Runtime.executionContextCreated). It is re-resolved
// after a navigation, because every document load creates a new one.

export async function isolatedWorld(context, page, { name = "GH Reloaded" } = {}) {
  const cdp = await context.newCDPSession(page);
  const contexts = new Map(); // id -> description
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => contexts.set(c.id, c));
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on("Runtime.executionContextsCleared", () => contexts.clear());
  await cdp.send("Runtime.enable");

  async function contextId() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = [...contexts.values()].filter((c) => c.name === name && c.auxData?.type === "isolated").pop();
      if (found) return found.id;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no isolated world named "${name}"`);
  }

  // Evaluates an expression (awaited, returned by value) in the isolated world.
  async function evaluate(expression) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = await contextId();
      const res = await cdp.send("Runtime.evaluate", { expression, contextId: id, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
        // A navigation destroyed the context under us: resolve it again.
        if (/context|destroyed/i.test(String(text)) && attempt < 4) continue;
        throw new Error(text);
      }
      return res.result.value;
    }
  }

  // Waits until the content scripts have defined the global, then runs fn.
  async function ready() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await evaluate("typeof globalThis.GHNotifications === 'object'").catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("GHNotifications was never defined");
  }

  return { evaluate, ready };
}
