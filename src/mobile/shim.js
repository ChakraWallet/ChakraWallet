// Android (Capacitor) runtime: emulates the subset of the WebExtension API used by Chakra,
// so the same background + UI code runs inside the app.
//   storage.local   -> Capacitor Preferences (native SharedPreferences), cached in memory
//   storage.session -> memory only (cleared when the app process dies)
//   runtime / ports -> in-process messaging; dapp pages talk through the native DappBrowser plugin
//   windows         -> approval overlay inside the app
import { Preferences } from '@capacitor/preferences';
import { registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

const DappBrowser = registerPlugin('DappBrowser');
CapApp.addListener('backButton', () => window.dispatchEvent(new Event('ck-back')));
globalThis.__CK_exitApp = () => CapApp.exitApp();
globalThis.__CK_MOBILE__ = true;
globalThis.__CK_NATIVE__ = DappBrowser;
globalThis.__CK_BIO__ = registerPlugin('Biometric');
globalThis.__CK_SYSUI__ = registerPlugin('SystemUi');
globalThis.__CK_NOTIFY__ = registerPlugin('Notify');

// Keyboard: when the WebView shrinks above it, keep the focused field in view (inside its scroll container)
const keepFocusedVisible = () => {
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
};
window.addEventListener('resize', keepFocusedVisible);

// Keyboard open = the page got much shorter at the same width (the WebView shrinks above the keyboard):
// body.kb-open hides the bottom tab bar, which would otherwise ride up on top of the keyboard.
const fullHeight = {};
const trackKeyboard = () => {
  const w = window.innerWidth, h = window.innerHeight;
  fullHeight[w] = Math.max(fullHeight[w] || 0, h);
  document.body?.classList.toggle('kb-open', fullHeight[w] - h > 120);
};
window.addEventListener('resize', trackKeyboard);
document.addEventListener('DOMContentLoaded', trackKeyboard);
document.addEventListener('focusin', () => setTimeout(keepFocusedVisible, 300));

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const ev = (arr) => ({
  addListener: (f) => arr.push(f),
  removeListener: (f) => { const i = arr.indexOf(f); if (i >= 0) arr.splice(i, 1); },
  hasListener: (f) => arr.includes(f),
});
const L = { changed: [], msg: [], connect: [], alarm: [], winRemoved: [], installed: [] };
const emitChanged = (changes, area) => setTimeout(() => L.changed.forEach((f) => { try { f(changes, area); } catch (e) { console.error(e); } }), 0);

// ---------------------------------------------------------------- storage
// Each storage key is a separate Preferences entry (`ew_local:<key>`), so a write only rewrites that key
// (balance caches for many accounts x networks would make a single blob slow). The old single-blob format
// (`ew_local`) is migrated on first start.
function makeArea(name, persist) {
  let data = null;
  const pkey = (k) => `ew_${name}:${k}`;
  const ready = (async () => {
    data = {};
    if (!persist) return;
    try {
      const { value: legacy } = await Preferences.get({ key: `ew_${name}` });
      if (legacy) {
        data = JSON.parse(legacy);
        for (const [k, v] of Object.entries(data)) await Preferences.set({ key: pkey(k), value: JSON.stringify(v) });
        await Preferences.remove({ key: `ew_${name}` });
        return;
      }
      const { keys } = await Preferences.keys();
      const mine = keys.filter((k) => k.startsWith(`ew_${name}:`));
      await Promise.all(mine.map(async (k) => {
        const { value } = await Preferences.get({ key: k });
        if (value != null) try { data[k.slice(name.length + 4)] = JSON.parse(value); } catch { /* skip corrupt entry */ }
      }));
    } catch { /* start empty */ }
  })();
  const save = (changed) => (persist
    ? Promise.all(Object.keys(changed).map((k) => (data[k] === undefined ? Preferences.remove({ key: pkey(k) }) : Preferences.set({ key: pkey(k), value: JSON.stringify(data[k]) }))))
    : Promise.resolve());
  const keysOf = (k) => (k == null ? Object.keys(data) : Array.isArray(k) ? k : typeof k === 'string' ? [k] : Object.keys(k));
  return {
    async get(k) {
      await ready;
      const out = {};
      for (const key of keysOf(k)) if (data[key] !== undefined) out[key] = clone(data[key]);
      if (k && typeof k === 'object' && !Array.isArray(k)) for (const [key, def] of Object.entries(k)) if (out[key] === undefined) out[key] = def;
      return out;
    },
    async set(obj) {
      await ready;
      // values identical to the stored ones are skipped: no native write, no change event (chrome does the same)
      const changes = {};
      for (const [key, v] of Object.entries(obj)) {
        const json = v === undefined ? undefined : JSON.stringify(v);
        if (json === (data[key] === undefined ? undefined : JSON.stringify(data[key]))) continue;
        const nv = json === undefined ? undefined : JSON.parse(json);
        changes[key] = { oldValue: data[key], newValue: nv }; data[key] = nv;
      }
      if (!Object.keys(changes).length) return;
      await save(changes); emitChanged(changes, name);
    },
    async remove(k) {
      await ready;
      const changes = {};
      for (const key of keysOf(k)) if (data[key] !== undefined) { changes[key] = { oldValue: data[key] }; delete data[key]; }
      if (!Object.keys(changes).length) return;
      await save(changes); emitChanged(changes, name);
    },
    async clear() {
      await ready;
      const changes = {};
      for (const key of Object.keys(data)) changes[key] = { oldValue: data[key] };
      data = {}; await save(changes); emitChanged(changes, name);
    },
    setAccessLevel: async () => {},
  };
}

// ---------------------------------------------------------------- runtime messaging
const RUNTIME_ID = 'chakra-android';
function sendMessage(msg) {
  return new Promise((resolve) => {
    let async = false, done = false;
    const respond = (r) => { if (!done) { done = true; resolve(clone(r)); } };
    for (const f of [...L.msg]) {
      try { if (f(clone(msg), { id: RUNTIME_ID, url: location.href }, respond) === true) async = true; } catch (e) { console.error(e); }
    }
    if (!async) setTimeout(() => respond(undefined), 0);
  });
}
const stubPort = (name) => ({ name, postMessage() {}, disconnect() {}, onMessage: ev([]), onDisconnect: ev([]) });

// ---------------------------------------------------------------- dapp pages (from the native browser)
// One "content script" port per tab and page: a new page (or a closed tab) disconnects the previous one.
const pages = new Map(); // tabId -> {tabId, pageId, port, url, origin, title, favicon, portL}
const navs = new Map();  // tabId -> last navigation state
const dropPage = (tabId) => {
  const p = pages.get(tabId);
  if (p) { pages.delete(tabId); p.portL.disc.forEach((f) => f(p.port)); }
};
DappBrowser.addListener('pageMessage', (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  let page = pages.get(e.tabId);
  if (!page || page.pageId !== e.pageId) {
    dropPage(e.tabId);
    const portL = { msg: [], disc: [] };
    page = { tabId: e.tabId, pageId: e.pageId, url: e.url, origin: e.origin, title: e.title, portL };
    page.port = {
      name: 'chakra-content',
      sender: { id: RUNTIME_ID, url: e.url, origin: e.origin, tab: { id: e.tabId, url: e.url, title: e.title || '', favIconUrl: e.favicon || '' } },
      postMessage: (m) => { DappBrowser.sendToPage({ tabId: page.tabId, pageId: page.pageId, json: JSON.stringify(m) }).catch(() => {}); },
      disconnect() {},
      onMessage: ev(portL.msg),
      onDisconnect: ev(portL.disc),
    };
    pages.set(e.tabId, page);
    L.connect.forEach((f) => f(page.port));
  }
  if (e.favicon) page.port.sender.tab.favIconUrl = e.favicon;
  page.portL.msg.forEach((f) => f(data, page.port));
});
// taps on the pages of the dapp browser (a native WebView the app's document doesn't see) count as activity for the
// auto-lock (the plugin reports them at most every 2 s; app.jsx sets __CK_activity)
DappBrowser.addListener('activity', () => globalThis.__CK_activity?.());
DappBrowser.addListener('navigation', (e) => {
  const p = pages.get(e.tabId);
  if (p && e.pageId !== p.pageId) dropPage(e.tabId);
  navs.set(e.tabId, e);
});
// a background tab unloaded to save resources: its page is gone (it loads again when reopened)
DappBrowser.addListener('tabDiscarded', (e) => dropPage(e.tabId));
DappBrowser.addListener('favicon', (e) => { const p = pages.get(e.tabId); if (p) p.port.sender.tab.favIconUrl = e.favicon; });
/** called by the browser UI when a tab is closed */
globalThis.__CK_tabClosed = (tabId) => { dropPage(tabId); navs.delete(tabId); };

// ---------------------------------------------------------------- approvals "window"
const APPROVAL_WIN = 777;
let approvalOpen = false;
const setApproval = (open) => { approvalOpen = open; window.dispatchEvent(new CustomEvent('ck-approval', { detail: { open } })); };
/** called by the UI when the user dismisses the approval overlay (back button) */
globalThis.__CK_closeApproval = () => { if (approvalOpen) { setApproval(false); L.winRemoved.forEach((f) => f(APPROVAL_WIN)); } };
// The approval screen calls window.close() when there is nothing left to approve.
window.close = () => setApproval(false);

// ---------------------------------------------------------------- alarms
const alarms = new Map();

globalThis.chrome = {
  runtime: {
    id: RUNTIME_ID,
    getURL: (p) => `${location.origin}/${p}`,
    sendMessage,
    connect: ({ name } = {}) => stubPort(name),
    onMessage: ev(L.msg),
    onConnect: ev(L.connect),
    onInstalled: ev(L.installed),
  },
  storage: { local: makeArea('local', true), session: makeArea('session', false), onChanged: ev(L.changed) },
  alarms: {
    create(name, info) {
      clearTimeout(alarms.get(name));
      alarms.set(name, setTimeout(() => L.alarm.forEach((f) => f({ name })), (info?.delayInMinutes || 1) * 60000));
    },
    clear: async (name) => { clearTimeout(alarms.get(name)); return true; },
    onAlarm: ev(L.alarm),
  },
  windows: {
    async create() { setApproval(true); return { id: APPROVAL_WIN }; },
    async update(id) { if (id === APPROVAL_WIN && approvalOpen) return { id }; throw new Error('no window'); },
    async remove(id) { if (id === APPROVAL_WIN) setApproval(false); },
    async getLastFocused() { return {}; },
    onRemoved: ev(L.winRemoved),
  },
  tabs: {
    async create({ url }) { if (/^https?:/.test(url)) window.dispatchEvent(new CustomEvent('ck-open-url', { detail: url })); return { id: 1 }; },
    async query() {
      return [...navs.values()].filter((n) => /^https?:/.test(n.url || '')).map((n) => ({ id: n.tabId, url: n.url, title: n.title || '', favIconUrl: n.favicon || '' }));
    },
    async sendMessage(tabId, msg) {
      const n = navs.get(tabId);
      if (n) await DappBrowser.sendToPage({ tabId, pageId: n.pageId, json: JSON.stringify(msg) }).catch(() => {});
    },
  },
};

// ---------------------------------------------------------------- UI helpers
// Clipboard fallback (Android WebView may refuse navigator.clipboard)
const origWrite = navigator.clipboard?.writeText?.bind(navigator.clipboard);
const fallbackCopy = (text) => {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
};
try {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t) => { try { if (origWrite) return await origWrite(t); } catch { /* fallback */ } fallbackCopy(t); } },
  });
} catch { /* ignore */ }

// External links (explorers...) open in the integrated browser
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || !/^https?:/.test(a.href)) return;
  e.preventDefault();
  window.dispatchEvent(new CustomEvent('ck-open-url', { detail: a.href }));
}, true);
