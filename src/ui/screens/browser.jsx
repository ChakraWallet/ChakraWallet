// In-app dapp browser (Android), with tabs. Each tab's page is a native WebView positioned over `.browser-view`
// (see DappBrowserPlugin.java); this component holds the tab list, the address bar, the tab switcher and the
// certificate sheet. Open tabs are saved and restored (lazily: a tab loads only when you open it).
import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'preact/hooks';
import { bg, local } from '../../shared/ext.js';
import { fmtDateTime, shortAddr } from '../../shared/format.js';
import { Icon, Avatar, ChainIcon, Sheet, Btn, CopyBtn, Switch, useApp, rich } from '../components.jsx';
import { NetworkSheet } from './home.jsx';
import { t, tn, locale } from '../../shared/i18n.js';
import { useSiteIcon } from '../siteIcons.js';

const native = () => globalThis.__CK_NATIVE__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EASE = 'cubic-bezier(.2,.8,.2,1)';

// featured dapps: icons are downloaded by the app from each site's metadata (see siteIcons.js)
const FEATURED = [ // cat: i18n keys
  { name: 'Uniswap', url: 'https://app.uniswap.org', color: '#FF007A', cat: 'browser.cat.exchange' },
  { name: 'Aave', url: 'https://app.aave.com', color: '#9391F7', cat: 'browser.cat.lending' },
  { name: 'Lido', url: 'https://stake.lido.fi', color: '#00A3FF', cat: 'browser.cat.staking' },
  { name: 'Jumper', url: 'https://jumper.exchange', color: '#5B4CF0', cat: 'browser.cat.bridge' },
  { name: 'Curve', url: 'https://curve.fi', color: '#E1352B', cat: 'browser.cat.exchange' },
  { name: 'OpenSea', url: 'https://opensea.io', color: '#2081E2', cat: 'browser.cat.nft' },
  { name: 'Revoke', url: 'https://revoke.cash', color: '#111827', cat: 'browser.cat.security' },
  { name: 'DefiLlama', url: 'https://defillama.com', color: '#2172E5', cat: 'browser.cat.analytics' },
];

export function toUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const pathOf = (u) => { try { const x = new URL(u); const p = x.pathname + x.search; return p === '/' ? '' : p; } catch { return ''; } };
function ago(ms) {
  const s = (ms - Date.now()) / 1000, a = Math.abs(s);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (a < 60) return rtf.format(0, 'minute');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

/** Small site icon: HD icon from the site's metadata when known, else the page favicon, else its initial. */
function Favicon({ src, url, size = 18 }) {
  const hd = useSiteIcon(url);
  const [err, setErr] = useState(false);
  const px = `${size / 16}rem`;
  const img = hd || (!err && src);
  if (img) return <img class="fav-img" src={img} onError={() => setErr(true)} style={{ width: px, height: px }} alt="" />;
  const h = hostOf(url || '');
  return <span class="fav-img fav-letter" style={{ width: px, height: px, fontSize: `${size / 16 * 0.6}rem` }}>{h ? h[0].toUpperCase() : <Icon name="globe" size={size * 0.7} />}</span>;
}

/** App-style tile: HD icon full bleed, or the small favicon on a soft square, or the initial on a colour. */
function SiteTile({ url, name, favicon, color, size = 48 }) {
  const hd = useSiteIcon(url);
  const px = `${size / 16}rem`;
  const style = { width: px, height: px };
  if (hd) return <img class="site-tile" src={hd} style={style} alt="" />;
  if (favicon) return <span class="site-tile soft" style={style}><img src={favicon} alt="" style={{ width: '50%', height: '50%' }} /></span>;
  return <span class="site-tile letter" style={{ ...style, background: color || 'var(--primary)', fontSize: `${size / 16 * 0.42}rem` }}>{(name || hostOf(url) || '?')[0].toUpperCase()}</span>;
}

/**
 * Short name for a tile: page titles are often "Brand | slogan" or "Page - Brand". Takes the part that names the
 * site (it contains the main word of the host), else the first part; the full title stays in the bookmark.
 */
export function shortName(title, url) {
  const host = hostOf(url);
  const parts = String(title || '').split(/\s+[|–—·•-]\s+|:\s+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return host;
  const word = host.split('.').slice(-2, -1)[0]?.toLowerCase() || '';
  return (word.length > 2 && parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(word))) || parts[0];
}

/** Bookmark tile: tap opens, long press shows the options. */
function BookmarkTile({ b, onOpen, onLong }) {
  const timer = useRef(null), long = useRef(false);
  const down = () => { long.current = false; timer.current = setTimeout(() => { long.current = true; navigator.vibrate?.(12); onLong(b); }, 480); };
  const cancel = () => clearTimeout(timer.current);
  return (
    <button class="bm" onPointerDown={down} onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()} onClick={() => { if (!long.current) onOpen(b.url); }}>
      <SiteTile url={b.url} name={b.title} favicon={b.favicon} size={52} />
      <span class="bm-name" title={b.title || hostOf(b.url)}>{shortName(b.title, b.url)}</span>
    </button>
  );
}

// ---- camera / microphone / location per site: "allow" remembered choices (stored as "origin|kind")
const sitePerms = {
  get: () => local.get('sitePerms', {}),
  async push() { native()?.setSitePermissions({ perms: await this.get() }).catch(() => {}); },
  async set(origin, kinds, value) {
    await local.update('sitePerms', {}, (m) => { const n = { ...m }; for (const k of kinds) { if (value) n[`${origin}|${k}`] = value; else delete n[`${origin}|${k}`]; } return n; });
    await this.push();
  },
};
const PERM_ICON = { camera: 'camera', microphone: 'mic', location: 'mapPin' };

/** A site asks for camera / microphone / location: remember, only this time, or deny. */
function PermissionSheet({ req, onDone }) {
  const host = hostOf(req.origin);
  const kinds = req.kinds || [];
  const what = kinds.map((k) => t(`browser.perm.${k}`)).join(t('browser.perm.and'));
  const answer = async (allow, remember) => {
    if (allow && remember) await sitePerms.set(req.origin, kinds, 'allow');
    onDone();
    native()?.answerPermission({ id: req.id, allow }).catch(() => {});
  };
  return (
    <Sheet title={t('browser.perm.title')} onClose={() => answer(false)}>
      <div class="perm-head">
        <div class="perm-icons">{kinds.map((k) => <span class="perm-ic"><Icon name={PERM_ICON[k]} size={24} /></span>)}</div>
        <div><b>{host}</b> {t('browser.perm.wants', { what })}</div>
      </div>
      {kinds.includes('location') && <div class="warn small">{t('browser.perm.locationWarn')}</div>}
      <Btn onClick={() => answer(true, true)}>{t('browser.perm.remember')}</Btn>
      <Btn kind="secondary" onClick={() => answer(true, false)}>{t('browser.perm.once')}</Btn>
      <button class="btn ghost red" onClick={() => answer(false)}>{t('browser.perm.deny')}</button>
    </Sheet>
  );
}

function SitePermissions({ origin }) {
  const [list, setList] = useState([]);
  const load = () => sitePerms.get().then((m) => setList(Object.entries(m).filter(([k]) => k.startsWith(`${origin}|`)).map(([k, v]) => [k.split('|')[1], v])));
  useEffect(() => { load(); }, [origin]);
  if (!list.length) return null;
  return (
    <>
      <div class="section-title">{t('browser.perm.section')}</div>
      <div class="card" style={{ padding: '0.375rem' }}>
        {list.map(([k, v]) => (
          <div class="item">
            <span class="perm-ic sm"><Icon name={PERM_ICON[k]} size={16} /></span>
            <span class="grow">{t(`browser.perm.${k}`)}</span>
            <span class={`badge ${v === 'allow' ? 'green' : 'red'}`}>{t(v === 'allow' ? 'browser.perm.allowed' : 'browser.perm.blocked')}</span>
            <button class="btn ghost sm" onClick={async () => { await sitePerms.set(origin, [k], null); load(); }}>{t('browser.perm.revoke')}</button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---- desktop / mobile version per site (like Chrome's "Desktop site")
// Mobile by default. Dapps (pages that look for a wallet, plus the featured ones) open in their desktop version,
// because many show the in-page wallet only there. The user's choice for a site always wins.
const normHost = (u) => hostOf(u).toLowerCase().replace(/:\d+$/, '');
const siteModes = {
  async load() {
    const [modes, dapps] = await Promise.all([local.get('siteModes', {}), local.get('dappHosts', [])]);
    return { modes, dapps: new Set([...dapps, ...FEATURED.map((d) => normHost(d.url))]) };
  },
  async desktopHosts() {
    const { modes, dapps } = await this.load();
    const set = new Set([...dapps].filter((h) => modes[h] !== 'mobile'));
    for (const [h, m] of Object.entries(modes)) if (m === 'desktop') set.add(h);
    return [...set];
  },
  async push() { native()?.setDesktopHosts({ hosts: await this.desktopHosts() }).catch(() => {}); },
  async isDesktop(url) {
    const h = normHost(url);
    const { modes, dapps } = await this.load();
    return modes[h] ? modes[h] === 'desktop' : [...dapps].some((d) => h === d || h.endsWith(`.${d}`));
  },
  /** Remembers a dapp; true when its version changes (the page should be reloaded). */
  async markDapp(url) {
    const h = normHost(url);
    if (!h || !/^https?:/.test(url)) return false;
    const { modes, dapps } = await this.load();
    if (modes[h] || [...dapps].some((d) => h === d || h.endsWith(`.${d}`))) return false;
    await local.update('dappHosts', [], (l) => [h, ...l.filter((x) => x !== h)].slice(0, 300));
    await this.push();
    return true;
  },
  async choose(url, mode) {
    await local.update('siteModes', {}, (m) => ({ ...m, [normHost(url)]: mode }));
    await this.push();
  },
};

const BLANK = { url: '', title: '', favicon: '', thumb: '', loading: false, progress: 0, canGoBack: false, canGoForward: false, error: null, flagged: null, home: false };
// home: the start page is shown over the tab's page, which is kept (with its history) so Forward returns to it

// What went wrong loading the page, in plain words (kinds come from DappBrowserPlugin.kindOf / SSL / Safe Browsing)
const ERR_ICON = { offline: 'globe', unsafe: 'warn', cert: 'lock', crashed: 'refresh' };
function ErrorPage({ err, onRetry, onBack, onEdit, onProceed }) {
  const kind = err.kind;
  const host = hostOf(err.url || '');
  const danger = kind === 'unsafe' || kind === 'cert';
  const text = kind === 'unsafe' ? t(`browser.err.threat.${err.detail}`) : kind === 'cert' ? t(`browser.err.cert.${err.detail}`) : t(`browser.err.${kind}.text`, { host });
  return (
    <div class={`content err-page ${danger ? 'danger' : ''}`}>
      <div class="err-icon"><Icon name={ERR_ICON[kind] || 'warn'} size={30} /></div>
      <h2>{t(`browser.err.${kind}.title`)}</h2>
      {host && <div class="err-host">{host}</div>}
      <p>{text}</p>
      {kind === 'unsafe' && <p class="small">{t('browser.err.unsafe.falsePositive')}</p>}
      <div class="err-actions">
        {kind === 'unsafe' ? <>
          <Btn onClick={onBack}>{t('browser.err.goBack')}</Btn>
          <button class="btn ghost red" onClick={onProceed}>{t('browser.err.proceed')}</button>
        </> : kind === 'cert' ? (
          <Btn onClick={onBack}>{t('browser.err.goBack')}</Btn>
        ) : <>
          <Btn onClick={onRetry}><Icon name="refresh" size={16} /> {kind === 'crashed' ? t('browser.reload') : t('browser.err.retry')}</Btn>
          {['dns', 'badUrl', 'scheme', 'cleartext'].includes(kind) && <Btn kind="secondary" onClick={onEdit}>{t('browser.err.edit')}</Btn>}
          <button class="btn ghost" onClick={onBack}>{t('browser.err.goBack')}</button>
        </>}
      </div>
      <div class="err-code mono">{[err.code ? `${t('browser.err.code')} ${err.code}` : '', kind === 'unsafe' || kind === 'cert' ? '' : err.detail].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

export function Browser({ visible, entering, openUrl, onSiteOpen, onExit }) {
  const { state, chain, account, refresh, toast } = useApp();
  const viewRef = useRef(null);
  const [tabs, setTabs] = useState([]);   // [{id, url, title, favicon, thumb, loading, progress, canGoBack, canGoForward}]
  const [activeId, setActiveId] = useState(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState('page'); // page | tabs
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [bookmarks, setBookmarks] = useState([]);
  const [recent, setRecent] = useState([]);
  const [sheet, setSheet] = useState(null); // network | cert | {bookmark} | {closeTab}
  const pendingOpen = useRef(null);
  // tab list animations
  const [ghost, setGhost] = useState(null);       // zooming screenshot {src, from, to, done}
  const [zoomIn, setZoomIn] = useState(null);     // tab id whose card is the target of the opening zoom
  const [leaving, setLeaving] = useState(false);  // tab list fading out while a tab zooms to full size
  const [closing, setClosing] = useState(() => new Set());
  const cardRefs = useRef({}), shotRefs = useRef({}), flipFirst = useRef(null), thumbWait = useRef(null), ghostRef = useRef(null);

  const tabsRef = useRef(tabs);
  const histSeen = useRef(new Map()); // tabId -> last navigation state, to record each page in the history once
  tabsRef.current = tabs;
  const tab = tabs.find((x) => x.id === activeId) || null;
  const opened = !!tab?.url && !tab?.home;
  const patch = (id, p) => setTabs((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const bounds = () => {
    const r = viewRef.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : {};
  };

  // ---- native events
  useEffect(() => {
    siteModes.push();
    sitePerms.push();
    local.get('bookmarks', []).then(setBookmarks);
    local.get('browserHistory', []).then(setRecent);
    const n = native();
    if (!n) return;
    const subs = [
      n.addListener('navigation', (e) => {
        setTabs((l) => l.map((x) => (x.id === e.tabId ? { ...x, url: e.url, title: e.title, loading: e.loading, progress: e.progress, canGoBack: e.canGoBack, canGoForward: e.canGoForward, favicon: e.favicon || (e.url === x.url ? x.favicon : ''), flagged: x.flagged && originOf(x.flagged) === originOf(e.url) ? x.flagged : null } : x)));
        // history: once per finished page (load ended or new address), never for title / progress / SPA ticks
        const last = histSeen.current.get(e.tabId);
        const landed = !e.loading && e.url && /^https?:/.test(e.url) && (!last || last.loading || last.url !== e.url);
        histSeen.current.set(e.tabId, { url: e.url, loading: e.loading });
        if (landed) {
          local.update('browserHistory', [], (h) => {
            const old = h.find((x) => x.url === e.url);
            return [{ url: e.url, title: e.title || hostOf(e.url), favicon: e.favicon || old?.favicon || '', t: Date.now() }, ...h.filter((x) => x.url !== e.url)].slice(0, 30);
          }).then(setRecent);
        }
      }),
      n.addListener('favicon', (e) => {
        patch(e.tabId, { favicon: e.favicon });
        const u = tabsRef.current.find((x) => x.id === e.tabId)?.url;
        if (u) local.get('browserHistory', []).then((h) => {
          if (!h.some((x) => x.url === u && x.favicon !== e.favicon)) return;
          local.update('browserHistory', [], (l) => l.map((x) => (x.url === u ? { ...x, favicon: e.favicon } : x))).then(setRecent);
        });
      }),
      n.addListener('thumbnail', (e) => {
        patch(e.tabId, { thumb: e.thumb });
        if (thumbWait.current?.id === e.tabId) { thumbWait.current.res(e.thumb); thumbWait.current = null; }
      }),
      // the page looks for a wallet: remember it as a dapp and reload it once in its desktop version
      n.addListener('pageMessage', async (e) => {
        if (!String(e.data).includes('"dapp"')) return;
        try { if (JSON.parse(e.data).type !== 'dapp') return; } catch { return; }
        if (await siteModes.markDapp(e.url)) native()?.navigate({ tabId: e.tabId, url: e.url }).catch(() => {});
      }),
      n.addListener('permissionRequest', (e) => setSheet({ perm: e })),
      n.addListener('permissionCancelled', (e) => setSheet((s) => (s?.perm?.id === e.id ? null : s))),
      n.addListener('downloadRequest', (e) => setSheet({ dl: e })),
      n.addListener('download', (e) => toast(t(`browser.download.${e.status}`, { name: e.name }), e.status === 'failed' ? 'warn' : 'info')),
      n.addListener('loadError', (e) => patch(e.tabId, { error: { kind: e.kind, code: e.code, detail: e.detail, url: e.url }, loading: false })),
      n.addListener('tabOpened', (e) => { setTabs((l) => [...l, { ...BLANK, id: e.tabId, loading: true }]); setActiveId(e.tabId); setView('page'); }),
      n.addListener('tabClosedByPage', (e) => closeTab(e.tabId)),
    ];
    return () => subs.forEach((p) => p?.then((x) => x.remove()));
  }, []);

  // ---- restore saved tabs (lazily) once the view has a size
  useEffect(() => {
    const n = native();
    if (!n) return;
    (async () => {
      const saved = await local.get('browserTabs', null);
      const list = (saved?.tabs || []).slice(0, 10);
      const made = [];
      for (const sv of list) {
        try { const r = await n.newTab({ url: sv.url || '', title: sv.title || '', favicon: sv.favicon || '', background: true }); made.push({ ...BLANK, id: r.tabId, url: sv.url || '', title: sv.title || '', favicon: sv.favicon || '' }); } catch { /* skip */ }
      }
      if (!made.length) {
        const r = await n.newTab({ ...bounds() });
        made.push({ ...BLANK, id: r.tabId });
      }
      setTabs(made);
      const act = made[Math.min(Math.max(0, saved?.active || 0), made.length - 1)];
      setActiveId(act.id);
      setReady(true);
      if (pendingOpen.current) { const u = pendingOpen.current; pendingOpen.current = null; openInNewTab(u, made.length); }
    })();
  }, []);

  // ---- save tabs (url, title, favicon; screenshots stay in memory)
  useEffect(() => {
    if (!ready) return;
    const tm = setTimeout(() => {
      local.set('browserTabs', { tabs: tabs.map(({ url, title, favicon, home }) => (home ? { url: '', title: '', favicon: '' } : { url, title, favicon })), active: Math.max(0, tabs.findIndex((x) => x.id === activeId)) });
    }, 400);
    return () => clearTimeout(tm);
  }, [ready, tabs.map((x) => `${x.url} ${x.favicon.length} ${x.home}`).join('|'), activeId]); // not the title: some pages change it every second

  // ---- the app hides its tab pill while a site is on screen (sites often have a similar bar of their own)
  const siteOnScreen = visible && view === 'page' && opened && !editing;
  useEffect(() => { onSiteOpen?.(siteOnScreen); }, [siteOnScreen]);

  // ---- show / hide / position the native WebView of the active tab
  // while the tab slides in, the native page (which can't move with it) waits: it is placed once the screen is still
  const showNative = visible && !entering && view === 'page' && !(sheet && !sheet.closeTab) && !editing && opened && !tab?.error;
  useEffect(() => {
    const n = native();
    if (!n || !ready) return;
    // a newer decision (e.g. hide because the page failed, or the user left the Browser tab) cancels an older
    // "show" still waiting for switchTab: otherwise the page could pop up over the rest of the app
    let stale = false;
    if (showNative) {
      n.switchTab({ tabId: activeId, ...bounds() })
        .then(() => (stale ? n.hide() : n.show()))
        .then(() => setTimeout(() => setGhost(null), 140)) // the zoomed screenshot covers the switch, then goes away
        .catch(() => setGhost(null));
    } else n.hide().catch(() => {});
    return () => { stale = true; };
  }, [showNative, activeId, ready]);
  // leaving the Browser tab always hides the page, whatever happened before
  useEffect(() => { if (!visible) native()?.hide().catch(() => {}); }, [visible]);
  // keep the native page exactly over the page area whenever that area moves or changes size
  // (keyboard, bars, coming back to the Browser tab)
  useEffect(() => {
    if (!showNative || !viewRef.current) return;
    const sync = () => native()?.setBounds(bounds()).catch(() => {});
    const ro = new ResizeObserver(sync);
    ro.observe(viewRef.current);
    window.addEventListener('resize', sync);
    return () => { ro.disconnect(); window.removeEventListener('resize', sync); };
  }, [showNative]);
  useEffect(() => () => { native()?.hide().catch(() => {}); }, []);

  // ---- Android back: closes the tab list / address editing first
  useEffect(() => {
    globalThis.__CK_browserBack = () => {
      if (!visible) return false;
      if (editing) { stopEdit(); return true; }
      if (view === 'tabs') { switchTo(activeId); return true; }
      if (tab?.error) { errBack(); return true; }
      if (opened) { back(); return true; } // inside the site, then the start page
      return false; // on the start page: leave the browser
    };
    return () => { globalThis.__CK_browserBack = null; };
  }, [visible, editing, view, activeId, tab]);

  // ---- actions
  const go = async (raw) => {
    const url = toUrl(raw);
    if (!url || !native()) return;
    setEditing(false); setInput(''); setView('page'); urlRef.current?.blur();
    if (!tab) return openInNewTab(url);
    patch(tab.id, { url, loading: true, progress: 5, error: null, home: false });
    await native().navigate({ tabId: tab.id, url, ...bounds() }).catch(() => {});
  };
  const openInNewTab = async (url, count = tabsRef.current.length) => {
    const n = native();
    if (!n) return;
    if (count >= 10) { go(url); return; }
    await n.captureActive().catch(() => {});
    const r = await n.newTab({ url: url || '', ...bounds() }).catch(() => null);
    if (!r) return;
    setTabs((l) => [...l, { ...BLANK, id: r.tabId, url: url || '', loading: !!url }]);
    setActiveId(r.tabId); setView('page');
  };
  useEffect(() => {
    if (!openUrl?.url) return;
    if (!ready) pendingOpen.current = openUrl.url; else openInNewTab(openUrl.url);
  }, [openUrl]);

  // page -> tab list: fresh screenshot of the page, then it shrinks into its card
  const openTabs = async () => {
    const cur = tabsRef.current.find((x) => x.id === activeId);
    let shot = '';
    if (cur?.url && !cur.home && view === 'page') {
      const wait = new Promise((res) => { thumbWait.current = { id: cur.id, res }; });
      native()?.captureActive().catch(() => {});
      shot = await Promise.race([wait, sleep(450).then(() => '')]) || cur.thumb;
    }
    setLeaving(false);
    setZoomIn(shot ? cur.id : null);
    setView('tabs');
    if (shot) setGhost({ src: shot, from: rectOf(viewRef.current), target: cur.id });
  };
  // tab list -> page: the card grows to fill the page area, then the real page replaces it
  const switchTo = (id) => {
    const tb = tabsRef.current.find((x) => x.id === id);
    const el = shotRefs.current[id];
    if (tb?.url && !tb.home && !tb.error && tb.thumb && el && view === 'tabs') {
      setLeaving(true);
      setGhost({ src: tb.thumb, from: rectOf(el), to: rectOf(viewRef.current), done: () => { setActiveId(id); setView('page'); setLeaving(false); } });
    } else { setActiveId(id); setView('page'); setLeaving(false); }
  };
  // safety net: the zoomed screenshot never stays on screen (e.g. if the page can't be shown)
  useEffect(() => { if (!ghost) return; const tm = setTimeout(() => setGhost(null), 1500); return () => clearTimeout(tm); }, [ghost]);
  // run the ghost animation (opening: the target card is measured after the list is laid out)
  useLayoutEffect(() => {
    const el = ghostRef.current;
    if (!ghost || !el || ghost.running) return;
    let to = ghost.to;
    if (!to && ghost.target != null) {
      const card = shotRefs.current[ghost.target];
      if (!card) { setGhost(null); setZoomIn(null); return; }
      card.scrollIntoView({ block: 'nearest' });
      to = rectOf(card);
    }
    ghost.running = true;
    // transform-only (compositor thread): smooth even when a heavy site keeps the shared renderer thread busy.
    // The box sits at the larger rect and scales; the screenshot inside is counter-scaled to stay undistorted.
    const f = ghost.from, B = f.w * f.h >= to.w * to.h ? f : to;
    Object.assign(el.style, { left: `${B.x}px`, top: `${B.y}px`, width: `${B.w}px`, height: `${B.h}px` });
    const img = el.firstElementChild;
    const box = [], pic = [];
    for (let i = 0; i <= 8; i++) {
      const k = i / 8, lerp = (a, b) => a + (b - a) * k;
      const r = { x: lerp(f.x, to.x), y: lerp(f.y, to.y), w: lerp(f.w, to.w), h: lerp(f.h, to.h) };
      const sx = r.w / B.w, sy = r.h / B.h;
      box.push({ transform: `translate(${r.x - B.x}px, ${r.y - B.y}px) scale(${sx}, ${sy})` });
      pic.push({ transform: `scale(1, ${sx / sy})` }); // the picture keeps the box width and its own proportions
    }
    const opt = { duration: 320, easing: EASE, fill: 'forwards' };
    const anim = el.animate(box, opt);
    img?.animate(pic, opt);
    const rad = (r, w) => `${r * (B.w / w)}px`; // radius as seen on screen, whatever the scale
    el.animate([{ borderRadius: rad(ghost.target != null ? 0 : 14, f.w) }, { borderRadius: rad(ghost.target != null ? 14 : 0, to.w) }], opt);
    anim.onfinish = () => {
      if (ghost.done) ghost.done(); // keeps covering the area until the native page is shown
      else { setGhost(null); setZoomIn(null); }
    };
  }, [ghost]);

  const closeTab = async (id) => {
    await native()?.closeTab({ tabId: id }).catch(() => {});
    globalThis.__CK_tabClosed?.(id);
    const l = tabsRef.current;
    const i = l.findIndex((x) => x.id === id);
    const rest = l.filter((x) => x.id !== id);
    const next = rest[Math.min(Math.max(i, 0), rest.length - 1)]?.id ?? null;
    setTabs(rest);
    setActiveId((cur) => (cur === id ? next : cur));
    if (!rest.length) { // never leave the browser without a tab
      const r = await native()?.newTab({ ...bounds() }).catch(() => null);
      if (r) { setTabs([{ ...BLANK, id: r.tabId }]); setActiveId(r.tabId); }
    }
  };
  // from the tab list: the card shrinks away, then the others slide into place
  const closeAnimated = (id) => {
    setClosing((x) => new Set(x).add(id));
    setTimeout(() => {
      flipFirst.current = Object.fromEntries(Object.entries(cardRefs.current).filter(([k, el]) => el && Number(k) !== id).map(([k, el]) => [k, el.getBoundingClientRect()]));
      setClosing((x) => { const n = new Set(x); n.delete(id); return n; });
      closeTab(id);
    }, 190);
  };
  const askClose = (tb) => {
    if (tb.url && connectedOrigins.has(originOf(tb.url))) setSheet({ closeTab: tb });
    else closeAnimated(tb.id);
  };
  useLayoutEffect(() => {
    const first = flipFirst.current;
    if (!first) return;
    flipFirst.current = null;
    for (const [k, el] of Object.entries(cardRefs.current)) {
      const a = first[k];
      if (!el || !a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 260, easing: EASE });
    }
  }, [tabs]);

  // history: the start page sits before the first page of the tab (like Chrome's new tab page)
  const home = () => { if (tab?.url) patch(tab.id, { home: true, error: null }); };
  const canBack = opened;                                  // the site's history, then the start page
  const canForward = tab?.home ? !!tab.url : !!tab?.canGoForward;
  const back = () => {
    if (!tab || tab.home) return;
    if (tab.canGoBack) native().goBack({ tabId: tab.id }); else home();
  };
  const forward = () => {
    if (!tab) return;
    if (tab.home && tab.url) patch(tab.id, { home: false }); else if (tab.canGoForward) native().goForward({ tabId: tab.id });
  };

  // ---- address bar editing
  const urlRef = useRef(null);
  const startEdit = () => {
    if (editing) return;
    setInput(opened ? tab.url : '');
    setEditing(true);
    requestAnimationFrame(() => urlRef.current?.select()); // whole address selected, ready to type over
  };
  const stopEdit = () => { setEditing(false); urlRef.current?.blur(); };
  const copyUrl = async () => { await navigator.clipboard.writeText(editing ? input.trim() : tab.url); toast(t('browser.urlCopied')); };

  // ---- error page actions
  const retry = async (tb = tab) => {
    if (!tb?.error) return;
    const url = tb.error.url || tb.url;
    patch(tb.id, { error: null, loading: true, progress: 5 });
    await native()?.navigate({ tabId: tb.id, url, ...bounds() }).catch(() => {});
  };
  const errBack = async () => {
    const err = tab.error;
    if (err.kind === 'unsafe') await native()?.resolveUnsafe({ tabId: tab.id, proceed: false }).catch(() => {});
    if (tab.canGoBack && err.kind !== 'crashed') { patch(tab.id, { error: null }); native().goBack({ tabId: tab.id }); return; }
    // nothing before the failed page: back to a clean start page (the failed page is not kept to go forward to)
    await native()?.clearTab({ tabId: tab.id }).catch(() => {});
    patch(tab.id, { ...BLANK, id: tab.id });
  };
  const proceedUnsafe = async () => {
    const url = tab.error.url;
    patch(tab.id, { error: null, flagged: url });
    await native()?.resolveUnsafe({ tabId: tab.id, proceed: true }).catch(() => {});
  };
  // back online: retry the tabs that failed because the phone was offline
  useEffect(() => {
    const onOnline = () => tabsRef.current.filter((x) => x.error?.kind === 'offline').forEach((x) => retry(x));
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const isBookmarked = opened && bookmarks.some((b) => b.url === tab.url);
  const saveBookmarks = async (next) => { await local.set('bookmarks', next); setBookmarks(next); };
  const toggleBookmark = () => saveBookmarks(isBookmarked ? bookmarks.filter((b) => b.url !== tab.url) : [{ url: tab.url, title: tab.title || hostOf(tab.url), favicon: tab.favicon || '' }, ...bookmarks]);
  const clearHistory = async () => { await local.set('browserHistory', []); setRecent([]); toast(t('browser.historyCleared')); };
  const connected = opened && (state.permissions?.[originOf(tab.url)] || state.tonSites?.[originOf(tab.url)] || state.solSites?.[originOf(tab.url)]);
  const secure = opened && tab.url.startsWith('https://') && !tab.flagged;
  // sites connected to Ethereum accounts and to TON (TON Connect)
  const connectedOrigins = useMemo(() => new Set([...Object.keys(state.permissions || {}), ...Object.keys(state.tonSites || {}), ...Object.keys(state.solSites || {})]), [state.permissions, state.tonSites, state.solSites]);

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    const seen = new Set();
    return [...bookmarks.map((b) => ({ ...b, kind: 'star' })), ...recent.map((r) => ({ ...r, kind: 'history' }))]
      .filter((x) => !q || x.url.toLowerCase().includes(q) || (x.title || '').toLowerCase().includes(q))
      .filter((x) => (seen.has(x.url) ? false : seen.add(x.url)))
      .slice(0, 8);
  }, [input, bookmarks, recent]);

  // ---------------------------------------------------------------- render
  return (
    <div class="screen browser" style={{ display: visible ? 'flex' : 'none' }}>
      {/* address bar: one element that morphs. The text field is always there, under the displayed address,
          so the tap itself focuses it and Android opens the keyboard right away */}
      <div class={`bbar ${editing ? 'editing' : ''}`}>
        {editing ? (
          <button class="sec-btn edit-back" onPointerDown={(e) => e.preventDefault()} onClick={stopEdit} title={t('common.back')}><Icon name="back" size={18} /></button>
        ) : (
          <button class="sec-btn" disabled={!opened} onClick={onExit} title={t('browser.backToWallet')}>
            <Icon name={opened ? 'back' : 'globe'} size={opened ? 18 : 16} />
          </button>
        )}
        <div class="urlbox">
          {editing ? <span class="url-lead"><Icon name="globe" size={16} /></span> : opened && (
            // site info (certificate, connection, permissions); a site that isn't secure shows the warning instead of its icon
            <button class={`url-site ${secure ? '' : 'bad'}`} onPointerDown={(e) => e.preventDefault()} onClick={() => setSheet('cert')} title={t('browser.security')}>
              {secure ? <Favicon src={tab.favicon} url={tab.url} size={16} /> : <Icon name="warn" size={16} />}
            </button>
          )}
          <div class="url-field">
            <input ref={urlRef} value={editing ? input : ''} placeholder={editing || !opened ? t('browser.searchPlaceholder') : ''} inputMode="url" autoCapitalize="off" autoComplete="off" spellcheck={false} enterKeyHint="go"
              onFocus={startEdit} onInput={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(input); }} />
            {!editing && opened && <span class="url-text" aria-hidden="true"><b>{hostOf(tab.url)}</b><span class="muted">{pathOf(tab.url)}</span></span>}
          </div>
          {editing && input && <button class="iconbtn sm" onPointerDown={(e) => e.preventDefault()} onClick={() => { setInput(''); urlRef.current?.focus(); }} title={t('browser.clear')}><Icon name="close" size={14} /></button>}
          {(editing ? !!input.trim() : opened) && <button class="iconbtn sm url-copy" onPointerDown={(e) => e.preventDefault()} onClick={copyUrl} title={t('browser.copyUrl')}><Icon name="copy" size={15} /></button>}
        </div>
        <button class="iconbtn bar-side" disabled={!opened} style={{ visibility: opened ? 'visible' : 'hidden' }} tabIndex={editing ? -1 : 0}
          onClick={() => (tab.loading ? native().stop({ tabId: tab.id }) : native().reload({ tabId: tab.id }))} title={opened && tab.loading ? t('browser.stop') : t('browser.reload')}>
          <Icon name={opened && tab.loading ? 'close' : 'refresh'} size={17} />
        </button>
        <button class="iconbtn bar-side" tabIndex={editing ? -1 : 0} onClick={() => (view === 'tabs' ? switchTo(activeId) : openTabs())} title={t('browser.openTabs')}>
          <span class={`tabcount ${view === 'tabs' ? 'on' : ''}`}>{tabs.length || 1}</span>
        </button>
      </div>
      {/* second bar: page controls, or the tab list header. It keeps its place across page <-> tab list,
          so the page area never changes size during the zoom (only its content cross-fades) */}
      {!editing && (opened || view === 'tabs' || (tab?.home && tab?.url)) && (
        <div class="bbar2" key="bar2">
          {view === 'tabs' ? (
            <div class="bar2-swap" key="tabs-head">
              <span class="bar2-title">{tn('browser.tabs', tabs.length)}</span>
              <span class="spacer" />
              <Btn kind="secondary" class="sm" disabled={tabs.length >= 10} onClick={() => openInNewTab('')}><Icon name="plus" size={16} /> {t('browser.newTab')}</Btn>
            </div>
          ) : !opened ? (
            <div class="bar2-swap" key="home-ctl">
              <button class="iconbtn" disabled title={t('common.back')}><Icon name="back" size={17} /></button>
              <button class="iconbtn" disabled={!canForward} onClick={forward} title={t('browser.forward')}><Icon name="forward" size={17} /></button>
              <span class="bar2-title muted">{t('browser.startPage')}</span>
            </div>
          ) : (
          <div class="bar2-swap" key="page-ctl">
          <button class="iconbtn" disabled={!canBack} onClick={back} title={t('common.back')}><Icon name="back" size={17} /></button>
          <button class="iconbtn" disabled={!canForward} onClick={forward} title={t('browser.forward')}><Icon name="forward" size={17} /></button>
          <button class="iconbtn" title={t('browser.home')} onClick={home}><Icon name="globe" size={17} /></button>
          <button class="iconbtn" style={{ color: isBookmarked ? 'var(--amber)' : undefined }} title={isBookmarked ? t('browser.unbookmark') : t('browser.bookmark')} onClick={toggleBookmark}><Icon name="star" size={17} /></button>
          <span class="spacer" />
          <button class={`conn ${connected ? 'on' : ''}`} onClick={() => setSheet('cert')}>
            <span class="conn-dot" />{connected ? t('browser.connected') : t('browser.notConnected')}
          </button>
          <button class="chip" onClick={() => setSheet('network')} title={chain.name}><ChainIcon chain={chain} size={18} /><Avatar address={account.address} /></button>
          </div>
          )}
        </div>
      )}
      {!editing && view === 'page' && opened && (tab.loading || (tab.progress > 0 && tab.progress < 100)) && <div class="progress"><div style={{ width: `${Math.max(8, tab.progress || 0)}%` }} /></div>}

      <div class="browser-view" ref={viewRef}>
        {editing && (
          <div class="content">
            {suggestions.length > 0 && (
              <div class="card" style={{ padding: '0.375rem' }}>
                {suggestions.map((sg) => (
                  <button class="item" onClick={() => go(sg.url)}>
                    <Favicon src={sg.favicon} url={sg.url} size={20} />
                    <div class="grow" style={{ minWidth: 0 }}><div class="ellipsis">{sg.title || hostOf(sg.url)}</div><div class="tiny muted ellipsis">{hostOf(sg.url)}{pathOf(sg.url)}</div></div>
                    <span class="muted"><Icon name={sg.kind} size={14} /></span>
                  </button>
                ))}
              </div>
            )}
            {input.trim() && <button class="item card" onClick={() => go(input)}><Icon name="external" /><span class="grow ellipsis">{/^https?:|\./.test(input.trim()) ? t('browser.open', { url: input.trim() }) : t('browser.search', { query: input.trim() })}</span></button>}
          </div>
        )}

        {!editing && view === 'tabs' && (
          <div class={`content tabs-view ${leaving ? 'leaving' : ''}`}>
            <div class="tab-grid">
              {tabs.map((tb) => (
                <div class={`tab-card ${tb.id === activeId ? 'active' : ''} ${closing.has(tb.id) ? 'closing' : ''} ${zoomIn === tb.id ? 'zoom-target' : ''}`} key={tb.id} ref={(el) => { cardRefs.current[tb.id] = el; }}>
                  <button class="tab-shot" onClick={() => switchTo(tb.id)} ref={(el) => { shotRefs.current[tb.id] = el; }}>
                    {tb.home ? <span class="tab-ph"><Icon name="globe" size={28} /></span> : tb.error ? <span class="tab-ph err"><Icon name={ERR_ICON[tb.error.kind] || 'warn'} size={28} /></span> : tb.thumb ? <img src={tb.thumb} alt="" /> : (
                      <span class="tab-ph">{tb.url ? <SiteTile url={tb.url} name={tb.title} favicon={tb.favicon} size={44} /> : <Icon name="globe" size={28} />}</span>
                    )}
                    {tb.url && !tb.home && connectedOrigins.has(originOf(tb.url)) && <span class="tab-conn" title={t('browser.connectedToWallet')} />}
                  </button>
                  <div class="tab-meta">
                    {tb.url && !tb.home ? <Favicon src={tb.favicon} url={tb.url} size={14} /> : null}
                    <span class="ellipsis grow">{tb.url && !tb.home ? (tb.title || hostOf(tb.url)) : t('browser.newTab')}</span>
                    <button class="iconbtn sm" onClick={() => askClose(tb)} title={t('browser.closeTab')}><Icon name="close" size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!editing && view === 'page' && tab?.error && (
          <ErrorPage err={tab.error} onRetry={() => retry()} onBack={errBack} onProceed={proceedUnsafe}
            onEdit={() => { setInput(tab.error.url || tab.url); setEditing(true); }} />
        )}

        {!editing && view === 'page' && !opened && !tab?.error && (
          <div class="content start-page">
            {bookmarks.length > 0 && <>
              <div class="section-title">{t('browser.bookmarks')}</div>
              <div class="bm-grid">
                {bookmarks.map((b) => <BookmarkTile b={b} onOpen={go} onLong={(x) => setSheet({ bookmark: x })} />)}
              </div>
            </>}
            <div class="section-title">{t('browser.popular')}</div>
            <div class="featured">
              {FEATURED.map((d) => (
                <button class="feat" onClick={() => go(d.url)}>
                  <SiteTile url={d.url} name={d.name} color={d.color} size={44} />
                  <span class="feat-name">{d.name}</span>
                  <span class="feat-cat">{t(d.cat)}</span>
                </button>
              ))}
            </div>
            {recent.length > 0 && <>
              <div class="row between section-row">
                <div class="section-title">{t('browser.recent')}</div>
                <button class="link" onClick={clearHistory}>{t('browser.clearHistory')}</button>
              </div>
              <div class="card recent-list">
                {recent.slice(0, 10).map((r) => (
                  <button class="item" onClick={() => go(r.url)}>
                    <Favicon src={r.favicon} url={r.url} size={22} />
                    <div class="grow" style={{ minWidth: 0 }}><div class="ellipsis">{r.title}</div><div class="tiny muted ellipsis">{hostOf(r.url)}{r.t ? ` · ${ago(r.t)}` : ''}</div></div>
                  </button>
                ))}
              </div>
            </>}
            <div class="info small">{t('browser.hint')}</div>
          </div>
        )}
      </div>
      {ghost && <div class="zoom-ghost" ref={ghostRef}
        style={{ left: `${ghost.from.x}px`, top: `${ghost.from.y}px`, width: `${ghost.from.w}px`, height: `${ghost.from.h}px` }}><img src={ghost.src} alt="" /></div>}
      {sheet === 'network' && <NetworkSheet onClose={() => setSheet(null)} />}
      {sheet === 'cert' && tab && <CertSheet tab={tab} onClose={() => setSheet(null)} />}
      {sheet?.bookmark && (
        <Sheet title={sheet.bookmark.title || hostOf(sheet.bookmark.url)} onClose={() => setSheet(null)}>
          <div class="row"><SiteTile url={sheet.bookmark.url} name={sheet.bookmark.title} favicon={sheet.bookmark.favicon} size={40} /><span class="small muted ellipsis grow">{hostOf(sheet.bookmark.url)}{pathOf(sheet.bookmark.url)}</span></div>
          <Btn kind="secondary" onClick={() => { const u = sheet.bookmark.url; setSheet(null); openInNewTab(u); }}><Icon name="plus" size={16} /> {t('browser.openNewTab')}</Btn>
          <Btn kind="danger" onClick={async () => { const u = sheet.bookmark.url; setSheet(null); await saveBookmarks(bookmarks.filter((b) => b.url !== u)); toast(t('browser.bookmarkRemoved')); }}><Icon name="trash" size={16} /> {t('browser.unbookmark')}</Btn>
        </Sheet>
      )}
      {sheet?.perm && <PermissionSheet req={sheet.perm} onDone={() => setSheet(null)} />}
      {sheet?.dl && (
        <Sheet title={t('browser.download.title')} onClose={() => { native()?.answerDownload({ id: sheet.dl.id, save: false }); setSheet(null); }}>
          <div class="perm-head">
            <div class="perm-icons"><span class="perm-ic"><Icon name="receive" size={24} /></span></div>
            <div>{rich('browser.download.ask', { host: <b>{hostOf(sheet.dl.origin)}</b>, name: <b class="ellipsis">{sheet.dl.name}</b> })}</div>
            <div class="small muted">{sheet.dl.size >= 1048576 ? `${(sheet.dl.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(sheet.dl.size / 1024))} KB`}</div>
          </div>
          <Btn onClick={() => { native()?.answerDownload({ id: sheet.dl.id, save: true }); setSheet(null); }}>{t('browser.download.save')}</Btn>
          <Btn kind="secondary" onClick={() => { native()?.answerDownload({ id: sheet.dl.id, save: false }); setSheet(null); }}>{t('common.cancel')}</Btn>
        </Sheet>
      )}
      {sheet?.closeTab && (
        <Sheet title={t('browser.closeConnected.title')} onClose={() => setSheet(null)}>
          <div class="row"><SiteTile url={sheet.closeTab.url} name={sheet.closeTab.title} favicon={sheet.closeTab.favicon} size={40} /><div class="small grow">{rich('browser.closeConnected.text', { host: <b>{hostOf(sheet.closeTab.url)}</b> })}</div></div>
          <Btn kind="secondary" onClick={() => { const id = sheet.closeTab.id; setSheet(null); closeAnimated(id); }}>{t('browser.closeConnected.close')}</Btn>
          <Btn kind="danger" onClick={async () => { const { id, url } = sheet.closeTab; setSheet(null); await bg('disconnectSite', { origin: originOf(url) }); await refresh(); closeAnimated(id); toast(t('browser.disconnected')); }}>{t('browser.closeConnected.disconnect')}</Btn>
          <button class="btn ghost" onClick={() => setSheet(null)}>{t('common.cancel')}</button>
        </Sheet>
      )}
    </div>
  );
}

// Desktop / mobile version of a site. Desktop is the default: many dapps show the in-page wallet only there.
function DesktopToggle({ tab }) {
  const [desktop, setDesktop] = useState(null);
  useEffect(() => { siteModes.isDesktop(tab.url).then(setDesktop); }, [tab.url]);
  if (desktop === null) return null;
  const toggle = async () => {
    await siteModes.choose(tab.url, desktop ? 'mobile' : 'desktop');
    setDesktop(!desktop);
    native()?.navigate({ tabId: tab.id, url: tab.url }).catch(() => {}); // reload with the other version
  };
  return (
    <button class="item card" onClick={toggle} style={{ alignItems: 'flex-start' }}>
      <div class="grow" style={{ textAlign: 'left' }}>
        <div class="bold">{t('browser.desktop.title')}</div>
        <div class="small muted">{t('browser.desktop.sub')}</div>
      </div>
      <Switch on={desktop} onChange={toggle} />
    </button>
  );
}

// Connection details: TLS certificate of the page + wallet connection for this site.
function CertSheet({ tab, onClose }) {
  const { state, refresh, toast } = useApp();
  const [cert, setCert] = useState(null);
  useEffect(() => { native()?.getCertificate({ tabId: tab.id }).then(setCert).catch(() => setCert({ secure: false })); }, [tab.id, tab.url]);
  const origin = originOf(tab.url);
  const perm = state.permissions?.[origin];
  const ton = state.tonSites?.[origin]; // TON Connect session
  const tonAcc = ton && state.accounts.find((x) => x.address === ton.account);
  const sol = state.solSites?.[origin]; // Solana session (Wallet Standard)
  const solAcc = sol && state.accounts.find((x) => x.address === sol.account);
  const now = Date.now();
  const expired = cert?.validTo && cert.validTo < now;
  const name = (x) => [x?.cn, x?.o].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || '—';
  const disconnect = async () => { await bg('disconnectSite', { origin }); await refresh(); toast(t('browser.disconnected')); };
  const [wipe, setWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const clearData = async () => {
    setWiping(true);
    try { await native().clearSiteData({ tabId: tab.id }); toast(t('browser.dataCleared', { host: hostOf(tab.url) })); onClose(); } catch (e) { toast(e.message); setWiping(false); }
  };

  return (
    <Sheet title={hostOf(tab.url)} onClose={onClose}>
      {tab.flagged && <div class="error small"><b>{t('browser.err.unsafe.title')}</b> {t('browser.err.flaggedNote')}</div>}
      {!cert ? <div class="center muted small">{t('browser.readingCert')}</div> : (
        <>
          <div class={`sec-state ${cert.secure && !expired ? 'ok' : 'bad'}`}>
            <Icon name={cert.secure && !expired ? 'lock' : 'warn'} size={20} />
            <div>
              <div class="bold">{cert.secure ? (expired ? t('browser.certExpired') : t('browser.secure')) : t('browser.insecure')}</div>
              <div class="small">{cert.secure ? t('browser.secureInfo') : t('browser.insecureInfo')}</div>
            </div>
          </div>
          {cert.secure && (
            <div class="card kv">
              <span class="k">{t('browser.issuedTo')}</span><span class="v">{name(cert.issuedTo)}</span>
              <span class="k">{t('browser.issuedBy')}</span><span class="v">{name(cert.issuedBy)}</span>
              {cert.validFrom && <><span class="k">{t('browser.validFrom')}</span><span class="v">{fmtDateTime(cert.validFrom)}</span></>}
              {cert.validTo && <><span class="k">{t('browser.expires')}</span><span class={`v ${expired ? 'red' : ''}`}>{fmtDateTime(cert.validTo)}</span></>}
              {cert.serial && <><span class="k">{t('browser.serial')}</span><span class="v mono">{cert.serial}</span></>}
            </div>
          )}
          {cert.sha256 && (
            <div class="field">
              <label>{t('browser.fingerprint')}</label>
              <div class="card flat mono" style={{ fontSize: '0.6875rem', lineHeight: 1.5 }}>{cert.sha256}</div>
              <div><CopyBtn text={cert.sha256} label={` ${t('browser.copyFingerprint')}`} /></div>
            </div>
          )}
        </>
      )}
      <div class="section-title">{t('browser.wallet')}</div>
      {perm || ton || sol ? (
        <div class="card col" style={{ gap: '0.5rem' }}>
          {perm && <div class="small">{tn('browser.seesAccounts', perm.accounts.length)}</div>}
          {perm?.accounts.map((a) => {
            const acc = state.accounts.find((x) => x.address.toLowerCase() === a.toLowerCase());
            return <div class="row"><Avatar address={a} /><span class="bold ellipsis grow">{acc?.name || shortAddr(a)}</span><span class="tiny muted">{shortAddr(a)}</span></div>;
          })}
          {ton && <div class="small">{t('tonconnect.site.sees')}</div>}
          {ton && <div class="row"><Avatar address={ton.account} /><span class="bold ellipsis grow">{tonAcc?.name || shortAddr(ton.display, 6)}</span><span class="tiny muted">{shortAddr(ton.display, 6)}</span></div>}
          {sol && <div class="small">{t('solapp.site.sees')}</div>}
          {sol && <div class="row"><Avatar address={sol.account} /><span class="bold ellipsis grow">{solAcc?.name || shortAddr(sol.address, 6)}</span><span class="tiny muted">{shortAddr(sol.address, 6)}</span></div>}
          <Btn kind="secondary" onClick={disconnect}>{t('browser.disconnect')}</Btn>
        </div>
      ) : <div class="small muted">{t('browser.notConnectedInfo')}</div>}

      <SitePermissions origin={origin} />
      <div class="section-title">{t('browser.desktop.section')}</div>
      <DesktopToggle tab={tab} />

      <div class="section-title">{t('browser.siteData')}</div>
      {!wipe ? (
        <Btn kind="secondary" onClick={() => setWipe(true)}><Icon name="trash" size={16} /> {t('browser.clearData')}</Btn>
      ) : (
        <div class="card col" style={{ gap: '0.625rem' }}>
          <div class="small">{rich('browser.clearInfo', { host: hostOf(tab.url) })}</div>
          <div class="tiny muted">{t('browser.httpCache')}</div>
          <div class="row"><Btn kind="secondary" class="grow" onClick={() => setWipe(false)}>{t('common.cancel')}</Btn><Btn kind="danger" class="grow" loading={wiping} onClick={clearData}>{t('browser.clear')}</Btn></div>
        </div>
      )}
    </Sheet>
  );
}
