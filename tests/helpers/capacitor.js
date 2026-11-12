// Capacitor stand-ins for the Android shim: Preferences backed by a Map (globalThis.__PREFS), no-op plugins.
export const store = (globalThis.__PREFS ??= new Map());
const prefs = () => globalThis.__PREFS;
export const Preferences = {
  get: async ({ key }) => ({ value: prefs().has(key) ? prefs().get(key) : null }),
  set: async ({ key, value }) => { prefs().set(key, value); },
  remove: async ({ key }) => { prefs().delete(key); },
  keys: async () => ({ keys: [...prefs().keys()] }),
};
export const App = { addListener: () => Promise.resolve({ remove() {} }), exitApp: () => {} };
export const registerPlugin = () => new Proxy({}, { get: () => () => Promise.resolve({ remove() {} }) });
