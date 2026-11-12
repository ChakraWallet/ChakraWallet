// HD site icons for the in-app browser (Android). The app downloads them from each site's own metadata
// (apple-touch-icon, <link rel="icon" sizes>, web app manifest) through the native DappBrowser.siteIcon,
// and caches them per origin in the app WebView's localStorage (not in the wallet storage, which is rewritten
// on every change): 30 days for found icons, 1 day before retrying a site without one, at most 60 sites.
import { useEffect, useState } from 'preact/hooks';

const KEY = 'ck-site-icons';
const TTL = 30 * 864e5, RETRY = 864e5, MAX = 60;
const native = () => globalThis.__CK_NATIVE__;
const originOf = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.origin : ''; } catch { return ''; } };

let cache = null;
const read = () => {
  if (!cache) { try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { cache = {}; } }
  return cache;
};
const write = () => {
  const entries = Object.entries(cache).sort((a, b) => (b[1].t || b[1].fail || 0) - (a[1].t || a[1].fail || 0)).slice(0, MAX);
  cache = Object.fromEntries(entries);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full: keep in memory */ }
};
const subs = new Set();
const inflight = new Map();

export function siteIcon(url) { const o = originOf(url); return (o && read()[o]?.icon) || ''; }

/** Downloads the icon of the site if it is not cached yet (or expired). Resolves with the icon or ''. */
export function ensureSiteIcon(url) {
  const o = originOf(url);
  if (!o || !native()?.siteIcon) return Promise.resolve('');
  const e = read()[o];
  const now = Date.now();
  if (e?.icon && now - e.t < TTL) return Promise.resolve(e.icon);
  if (e?.fail && now - e.fail < RETRY) return Promise.resolve(e.icon || '');
  if (inflight.has(o)) return inflight.get(o);
  const p = native().siteIcon({ url: o })
    .then((r) => { cache[o] = { icon: r.icon, t: Date.now() }; write(); subs.forEach((f) => f(o)); return r.icon; })
    .catch(() => { cache[o] = { ...(e || {}), fail: Date.now() }; write(); return e?.icon || ''; })
    .finally(() => inflight.delete(o));
  inflight.set(o, p);
  return p;
}

/** HD icon for a URL ('' until known); fetches it in the background and re-renders when it arrives. */
export function useSiteIcon(url) {
  const o = originOf(url);
  const [icon, setIcon] = useState(() => siteIcon(url));
  useEffect(() => {
    setIcon(siteIcon(url));
    if (!o) return;
    const f = (origin) => { if (origin === o) setIcon(siteIcon(url)); };
    subs.add(f);
    ensureSiteIcon(url);
    return () => subs.delete(f);
  }, [o]);
  return icon;
}
