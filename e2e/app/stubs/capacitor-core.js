// Demo stand-in for @capacitor/core in a plain browser: native plugins answer with empty results.
// The DappBrowser plugin keeps its listeners, so a test can play the native in-app browser: a page that sends requests
// to the app (TON Connect, window.ethereum) and receives its answers (globalThis.__e2eDapp, see tests/tonconnect).
const noop = () => Promise.resolve({});
const dappListeners = {};
const dapp = {
  sent: [], // what the app sent to pages: { tabId, pageId, msg }
  emit(event, data) { for (const fn of dappListeners[event] || []) fn(data); },
  /** A page opened in a tab, then a message from it (as the native side reports them). */
  open(page) { dapp.emit('navigation', { ...page, loading: false }); },
  post(page, data) { dapp.emit('pageMessage', { ...page, data: JSON.stringify(data) }); },
};
globalThis.__e2eDapp = dapp;
export const registerPlugin = (name) => new Proxy({}, {
  get(_, k) {
    if (k === 'then') return undefined;
    if (name === 'DappBrowser' && k === 'addListener') return (event, fn) => { (dappListeners[event] ||= []).push(fn); return Promise.resolve({ remove: noop }); };
    if (name === 'DappBrowser' && k === 'sendToPage') return ({ tabId, pageId, json }) => { dapp.sent.push({ tabId, pageId, msg: JSON.parse(json) }); return Promise.resolve({}); };
    if (k === 'addListener') return () => Promise.resolve({ remove: noop });
    if (name === 'Biometric' && k === 'isAvailable') return () => Promise.resolve({ available: false });
    return noop;
  },
});
export const Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web', isPluginAvailable: () => false };
export const CapacitorHttp = {};
export const WebPlugin = class {};
