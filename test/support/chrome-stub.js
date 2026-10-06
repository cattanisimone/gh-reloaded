// test/support/chrome-stub.js — a tiny in-memory stand-in for the parts
// of the `chrome.*` extension API that the background modules touch at
// import time and while running under Node's test runner.
//
// Importing this module installs the stub on `globalThis.chrome` as a
// side effect, BEFORE anything else runs. That ordering matters:
// lib/github-api.js registers a `chrome.storage.onChanged` listener the
// moment it is evaluated, so any unit test that imports a background
// module (which transitively imports github-api.js) must have `chrome`
// in place first. ES modules are evaluated in the textual order of their
// import statements, so listing this import first in a test file is
// enough — see test/unit/*.test.js.

let store = {};
const changeListeners = [];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// Mirrors chrome.storage.local.get's three accepted shapes: a single key
// string, an array of keys, or an object whose values are defaults for
// missing keys. Always resolves with a plain object of the requested keys.
function get(query) {
  const out = {};
  if (query == null) {
    Object.assign(out, clone(store));
  } else if (typeof query === "string") {
    if (query in store) out[query] = clone(store[query]);
  } else if (Array.isArray(query)) {
    for (const key of query) if (key in store) out[key] = clone(store[key]);
  } else {
    for (const [key, fallback] of Object.entries(query)) {
      out[key] = key in store ? clone(store[key]) : fallback;
    }
  }
  return Promise.resolve(out);
}

function set(items) {
  const changes = {};
  for (const [key, newValue] of Object.entries(items)) {
    changes[key] = { oldValue: clone(store[key]), newValue: clone(newValue) };
    store[key] = clone(newValue);
  }
  emit(changes);
  return Promise.resolve();
}

function remove(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const changes = {};
  for (const key of list) {
    if (key in store) {
      changes[key] = { oldValue: clone(store[key]), newValue: undefined };
      delete store[key];
    }
  }
  if (Object.keys(changes).length) emit(changes);
  return Promise.resolve();
}

function emit(changes) {
  for (const listener of changeListeners) listener(changes, "local");
}

export const chromeStub = {
  storage: {
    local: { get, set, remove },
    onChanged: {
      addListener(fn) {
        changeListeners.push(fn);
      },
    },
  },
};

// Replaces the backing store for a fresh test. Does NOT drop the
// onChanged listeners — those are registered once at module import and
// are supposed to persist, exactly as they do in the real service worker.
export function resetStorage(initial = {}) {
  store = clone(initial) || {};
}

globalThis.chrome = chromeStub;
