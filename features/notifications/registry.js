// features/notifications/registry.js — the module registry of the
// notifications engine. Later modules (reason tags, filter bar, sections,
// configuration) register here; each has an on/off switch, an availability
// state, and a start/stop pair the registry calls. The "Native inbox"
// override stops every module at once and restores the original page.
//
// Preferences live in chrome.storage.local (ghntModules: {id: boolean},
// ghntNativeInbox: boolean); nothing is written to GitHub. The registry is
// pure bookkeeping: content.js feeds it the stored preferences and tells it
// whether the engine is running, and it starts or stops modules to match.

(function (global) {
  // Which modules should be running. Pure, so every combination is testable.
  function wantedModules(modules, config, running) {
    if (!running || config.nativeInbox) return [];
    return modules.filter((m) => config.modules[m.id] === true && m.availability === "available").map((m) => m.id);
  }

  function createRegistry() {
    const modules = new Map(); // id -> { id, label, start, stop, availability }
    const started = new Set();
    const listeners = new Set();
    const config = { modules: {}, nativeInbox: false };
    let running = false;
    let api = null;

    function notify() {
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          /* a listener must not break the others */
        }
      }
    }

    function reconcile() {
      const want = new Set(wantedModules([...modules.values()], config, running));
      for (const id of [...started]) {
        if (!want.has(id)) {
          started.delete(id);
          try {
            modules.get(id)?.stop?.();
          } catch {
            /* ignore */
          }
        }
      }
      for (const id of want) {
        if (started.has(id)) continue;
        started.add(id);
        try {
          modules.get(id).start?.(api);
        } catch {
          started.delete(id);
        }
      }
    }

    return {
      register({ id, label, start, stop, availability } = {}) {
        if (!id || typeof id !== "string") throw new Error("A module needs an id");
        modules.set(id, { id, label: label || id, start, stop, availability: availability || "available" });
        notify();
        reconcile();
        return () => {
          if (started.delete(id)) {
            try {
              modules.get(id)?.stop?.();
            } catch {
              /* ignore */
            }
          }
          modules.delete(id);
          notify();
        };
      },
      setAvailability(id, availability) {
        const m = modules.get(id);
        if (!m) return;
        m.availability = availability;
        notify();
        reconcile();
      },
      setConfig({ modules: enabled, nativeInbox } = {}) {
        config.modules = enabled && typeof enabled === "object" ? { ...enabled } : {};
        config.nativeInbox = nativeInbox === true;
        notify();
        reconcile();
      },
      // The engine is running (route ok, something enabled): modules may start.
      setRunning(value, engineApi) {
        running = !!value;
        api = engineApi || api;
        reconcile();
      },
      // True when the engine has a reason to run: some enabled, available
      // module and "Native inbox" off.
      hasActive() {
        return wantedModules([...modules.values()], config, true).length > 0;
      },
      list() {
        return [...modules.values()].map((m) => ({ id: m.id, label: m.label, availability: m.availability, enabled: config.modules[m.id] === true, started: started.has(m.id) }));
      },
      nativeInbox: () => config.nativeInbox,
      onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }

  global.GHNT_REGISTRY = { createRegistry, wantedModules };
})(typeof window !== "undefined" ? window : globalThis);
