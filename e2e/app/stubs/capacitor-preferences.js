// Demo stand-in for @capacitor/preferences: sessionStorage of the browser tab (survives a reload; every
// screenshot uses a fresh browser context, so every run starts from scratch).
const K = 'cap:';
export const Preferences = {
  get: async ({ key }) => ({ value: sessionStorage.getItem(K + key) }),
  set: async ({ key, value }) => { sessionStorage.setItem(K + key, value); },
  remove: async ({ key }) => { sessionStorage.removeItem(K + key); },
  keys: async () => ({ keys: Object.keys(sessionStorage).filter((k) => k.startsWith(K)).map((k) => k.slice(K.length)) }),
  clear: async () => { for (const k of Object.keys(sessionStorage)) if (k.startsWith(K)) sessionStorage.removeItem(k); },
};
