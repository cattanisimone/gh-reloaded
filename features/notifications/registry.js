// features/notifications/registry.js — the module registry of the
// notifications engine. Later modules (reason tags, filter bar, sections,
// configuration) register here; each has an on/off switch, an availability
// state, and a start/stop pair the registry calls. The "Native inbox"
// override stops every module at once and restores the original page.
//
// Preferences live in chrome.storage.local (ghntModules: {id: boolean},
// ghntNativeInbox: boolean, ghntLayout: see prefs.js); nothing is written to GitHub. The registry is
// pure bookkeeping: content.js feeds it the stored preferences and tells it
// whether the engine is running, and it starts or stops modules to match.

(function (global) {
  // Which modules should be running. Pure, so every combination is testable.
  function wantedModules(modules, config, running) {
    if (!running || config.nativeInbox) return [];
    return modules.filter((m) => enabled(m, config) && m.availability === "available").map((m) => m.id);
  }

  // A stored boolean wins; otherwise the module's own default (off unless it
  // registered with defaultOn), so a default needs no write on install.
  function enabled(m, config) {
    const flag = config.modules[m.id];
    return typeof flag === "boolean" ? flag : m.defaultOn === true;
  }

  function normalizeLayout(value) {
    return global.GHNT_PREFS ? global.GHNT_PREFS.normalizeLayout(value) : typeof value === "string" ? value : "integrated";
  }

  function createRegistry() {
    const modules = new Map(); // id -> { id, label, start, stop, availability, reason, defaultOn, layouts }
    const started = new Set();
    const listeners = new Set();
    const config = { modules: {}, nativeInbox: false, layout: normalizeLayout() };
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
      register({ id, label, start, stop, availability, reason, defaultOn, layouts } = {}) {
        if (!id || typeof id !== "string") throw new Error("A module needs an id");
        modules.set(id, { id, label: label || id, start, stop, availability: availability || "available", reason: reason || "", defaultOn: defaultOn === true, layouts: Array.isArray(layouts) ? [...layouts] : [] });
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
      setAvailability(id, availability, reason) {
        const m = modules.get(id);
        if (!m) return;
        m.availability = availability;
        m.reason = reason || "";
        notify();
        reconcile();
      },
      setConfig({ modules: flags, nativeInbox, layout } = {}) {
        config.modules = flags && typeof flags === "object" ? { ...flags } : {};
        config.nativeInbox = nativeInbox === true;
        config.layout = normalizeLayout(layout);
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
        return [...modules.values()].map((m) => ({ id: m.id, label: m.label, availability: m.availability, reason: m.reason, layouts: [...m.layouts], enabled: enabled(m, config), started: started.has(m.id) }));
      },
      nativeInbox: () => config.nativeInbox,
      // The stored layout, even when it changes nothing on the page (Triage
      // off or Native inbox on): the modules that render it read it here.
      layout: () => config.layout,
      onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }

  global.GHNT_REGISTRY = { createRegistry, wantedModules };
})(typeof window !== "undefined" ? window : globalThis);
