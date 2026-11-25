// Demo stand-in for @capacitor/core in a plain browser: native plugins answer with empty results.
// The DappBrowser plugin keeps its listeners, so a scene can play a site of the in-app browser that sends requests to
// the app (window.ethereum) and receives its answers (globalThis.__demoDapp; as in e2e/app/stubs/capacitor-core.js).
const noop = () => Promise.resolve({});
const dappListeners = {};
const dapp = {
  sent: [], // what the app sent to pages: { tabId, pageId, msg }
  emit(event, data) { for (const fn of dappListeners[event] || []) fn(data); },
  /** A page opened in a tab, then a message from it (as the native side reports them). */
  open(page) { dapp.emit('navigation', { ...page, loading: false }); },
  post(page, data) { dapp.emit('pageMessage', { ...page, data: JSON.stringify(data) }); },
};
globalThis.__demoDapp = dapp;
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
