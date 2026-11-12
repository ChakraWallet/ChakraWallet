// In-memory chrome.storage (local + session), installed before the modules under test are evaluated.
const area = () => {
  let d = {};
  return {
    get: async (k) => {
      if (k == null) return structuredClone(d);
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.filter((x) => d[x] !== undefined).map((x) => [x, structuredClone(d[x])]));
    },
    set: async (o) => { for (const [k, v] of Object.entries(o)) d[k] = structuredClone(v); },
    remove: async (k) => { for (const x of [].concat(k)) delete d[x]; },
    clear: async () => { d = {}; },
    dump: () => d,
  };
};
globalThis.chrome = { storage: { local: area(), session: area() } };
export const storage = globalThis.chrome.storage;
export async function resetStorage() { await storage.local.clear(); await storage.session.clear(); }
