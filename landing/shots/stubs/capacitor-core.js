// Demo stand-in for @capacitor/core in a plain browser: native plugins answer with empty results.
const noop = () => Promise.resolve({});
export const registerPlugin = (name) => new Proxy({}, {
  get(_, k) {
    if (k === 'then') return undefined;
    if (k === 'addListener') return () => Promise.resolve({ remove: noop });
    if (name === 'Biometric' && k === 'isAvailable') return () => Promise.resolve({ available: false });
    return noop;
  },
});
export const Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web', isPluginAvailable: () => false };
export const CapacitorHttp = {};
export const WebPlugin = class {};
