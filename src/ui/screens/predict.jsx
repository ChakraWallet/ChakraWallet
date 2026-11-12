// Predictions tab (Android app): Polymarket markets, live probabilities, charts and the user's positions.
// Phase 1 is read-only: nothing here signs or sends anything.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, Sheet, TokenIcon, Avatar, useApp, Guilloche, cardStyle } from '../components.jsx';
import { shortAddr } from '../../shared/format.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { t, tn, locale } from '../../shared/i18n.js';
import { BUILTIN_CHAINS } from '../../shared/chains.js';
import { ethCall, erc20 } from '../../shared/rpc.js';
import {
  regionStatus, listEvents, searchEvents, getEvent, priceHistory, watchPrices, positions, accountsOf, mainAccount, userPnl, userStats, suggestions,
  CATEGORIES, INTERVALS, MARKET_URL,
} from '../../shared/polymarket.js';
import { TradeSheet, CashSheet, OpenOrders, RelayerSheet, EmergencySheet, usePolyAccount } from './predictTrade.jsx';
import { redeem, balances, autoRedeemOn } from '../polyClient.js';
import { CASH_TOKENS } from '../polyBalance.js';
import { createFeed, signal, signalCategory, seen as markSeenTaste } from '../predictTaste.js';
import { useSaved, savedList, toggleSaved } from '../predictSaved.js';

// Polymarket cash on Polygon: pUSD (current collateral) and USDC.e (the previous one), both 6 decimals
const POLYGON = BUILTIN_CHAINS.find((c) => c.id === 137);

// ------------------------------------------------------------ formatting (Polymarket is in USD)
const usd = (n, compact) => (n == null || !isFinite(n) ? '–' : n.toLocaleString(locale(), { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 2, minimumFractionDigits: compact ? 0 : 2 }));
const signed = (n) => (n == null ? '–' : `${n > 0.004 ? '+' : n < -0.004 ? '−' : ''}${usd(Math.abs(n))}`);
const tone = (n) => (n > 0.004 ? 'up' : n < -0.004 ? 'down' : '');
const pct = (p) => (p == null ? '–' : p < 0.005 ? '<1%' : p > 0.995 ? '>99%' : `${Math.round(p * 100)}%`);
const cents = (p) => (p == null ? '–' : `${(p * 100).toFixed(p < 0.01 || p > 0.99 ? 1 : 0)}¢`);
const day = (d) => (d ? new Date(d).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: new Date(d).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }) : '');
const outcomeName = (n) => ({ Yes: t('predict.yes'), No: t('predict.no') }[n] || n);
const priceOf = (o, live) => (o?.token && live[o.token] != null ? live[o.token] : o?.price);

function Img({ src, size = 44, round }) {
  const [ok, setOk] = useState(true);
  const st = { width: `${size / 16}rem`, height: `${size / 16}rem` };
  return src && ok
    ? <img class={`pm-img ${round ? 'round' : ''}`} src={src} alt="" loading="lazy" style={st} onError={() => setOk(false)} />
    : <span class={`pm-img ph ${round ? 'round' : ''}`} style={st}><Icon name="predict" size={size * 0.45} /></span>;
}

/** A number that flashes green / red for a moment when it changes (live prices). */
function Live({ value, children, class: cls = '' }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before == null || value == null || Math.abs(value - before) < 0.001) return undefined;
    setFlash(value > before ? 'flash-up' : 'flash-down');
    const id = setTimeout(() => setFlash(''), 900);
    return () => clearTimeout(id);
  }, [value]);
  return <span class={`${cls} ${flash}`}>{children}</span>;
}

function usePageVisible() {
  const [vis, setVis] = useState(!document.hidden);
  useEffect(() => {
    const f = () => setVis(!document.hidden);
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  return vis;
}

/** Live prices for the given outcome tokens: { token: price }. Connected only while shown and the app is in the foreground. */
function useLivePrices(tokens, active = true) {
  const [live, setLive] = useState({});
  const pageVisible = usePageVisible();
  const key = active && pageVisible ? tokens.filter(Boolean).sort().join(',') : '';
  useEffect(() => {
    if (!key) return undefined;
    const pending = {}; let raf = 0;
    const stop = watchPrices(key.split(','), (tok, p) => {
      pending[tok] = p;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setLive((x) => ({ ...x, ...pending })); });
    });
    return () => { stop(); cancelAnimationFrame(raf); };
  }, [key]);
  return live;
}

// ------------------------------------------------------------ root
export function Predict({ visible, onDeep, openReq }) {
  const [geo, setGeo] = useState(null);
  const [stack, setStack] = useState([]); // screens over the home (which stays mounted: list and scroll are kept)
  const [dir, setDir] = useState('nav-fwd');
  const top = stack[stack.length - 1];
  // the same screen already on top is not pushed again (a quick double tap would stack it twice)
  const open = (v) => { setDir('nav-fwd'); setStack((s) => { const t = s[s.length - 1]; return t && t.name === v.name && t.slug === v.slug ? s : [...s, v]; }); };
  // the "Per te" feed takes the first back itself (to the top with fresh cards); the next one closes it
  const fyBack = useRef(null);
  const back = () => {
    if (!stack.length) return false;
    if (stack[stack.length - 1].name === 'foryou' && fyBack.current?.()) return true;
    setDir('nav-back'); setStack((s) => s.slice(0, -1)); return true;
  };
  const check = () => { setGeo(null); regionStatus().then(setGeo); };

  useEffect(() => { if (visible && !geo) check(); }, [visible]);
  // opened from the wallet (e.g. the Polymarket row of the home or of an account): straight to that screen
  useEffect(() => { if (openReq) { setDir('nav-fwd'); setStack([{ name: openReq.name }]); } }, [openReq]);
  useEffect(() => { if (!visible) setDir(''); }, [visible]);
  useEffect(() => { onDeep?.(stack.length > 0); }, [stack.length]); // shown again: no replay of the last screen's slide
  useEffect(() => { globalThis.__CK_predictBack = back; return () => { delete globalThis.__CK_predictBack; }; }, [stack.length]);

  if (!geo) return <div class="screen pm" style={{ display: visible ? 'flex' : 'none' }}><div class="pm-center"><Spinner lg /></div></div>;
  if (geo.state !== 'ok') return <div class="screen pm" style={{ display: visible ? 'flex' : 'none' }}><RegionGate geo={geo} onRetry={check} /></div>;
  return (
    <div class="screen pm" style={{ display: visible ? 'flex' : 'none' }}>
      <div class="screen" style={{ display: top ? 'none' : 'flex' }}>
        <Home active={visible && !top} onOpen={(ev) => open({ name: 'event', slug: ev.slug, event: ev })} onPortfolio={() => open({ name: 'portfolio' })} onForYou={() => open({ name: 'foryou' })} />
      </div>
      {/* the feed stays mounted under the events opened from it: coming back, it is still on the same card */}
      {stack.some((x) => x.name === 'foryou') && (
        <div class={`screen ${top.name === 'foryou' ? dir : ''}`} style={{ display: top.name === 'foryou' ? 'flex' : 'none' }}>
          <ForYou onBack={back} backRef={fyBack} active={visible && top.name === 'foryou'} onOpen={(ev) => open({ name: 'event', slug: ev.slug, event: ev })} />
        </div>
      )}
      {top && top.name !== 'foryou' && (
        <div class={`screen ${dir}`} key={stack.length + top.name + (top.slug || '')}>
          {top.name === 'event' ? <EventView slug={top.slug} initial={top.event} onBack={back} active={visible} />
            : <Portfolio onBack={back} onOpen={(slug) => open({ name: 'event', slug })} />}
        </div>
      )}
    </div>
  );
}

function RegionGate({ geo, onRetry }) {
  const blocked = geo.state === 'blocked';
  let country = geo.country || '';
  try { if (country) country = new Intl.DisplayNames([locale()], { type: 'region' }).of(country) || country; } catch { /* code only */ }
  return (
    <div class="pm-gate">
      <span class="pm-gate-ic"><Icon name={blocked ? 'globe' : 'wifiOff'} size={34} stroke={1.6} />{blocked && <i />}</span>
      <h2>{blocked ? t('predict.blocked.title') : t('predict.unreachable.title')}</h2>
      <p class="muted">{blocked ? (country ? t('predict.blocked.bodyCountry', { country }) : t('predict.blocked.body')) : t('predict.unreachable.body')}</p>
      {!blocked && <Btn kind="secondary" onClick={onRetry}><Icon name="refresh" size={16} /> {t('predict.retry')}</Btn>}
    </div>
  );
}

// ------------------------------------------------------------ portfolio summary (home pill + portfolio hero)
async function cashOf(accounts) {
  const calls = accounts.flatMap((a) => CASH_TOKENS.map((tok) => ethCall(POLYGON, tok, erc20.encodeFunctionData('balanceOf', [a])).then((r) => Number(BigInt(r)) / 1e6).catch(() => 0)));
  return (await Promise.all(calls)).reduce((s, x) => s + x, 0);
}
/**
 * Cash on the user's Polymarket accounts + positions. value counts the winnings not redeemed yet too (they are money);
 * open and pnl only the markets still trading: resolved positions are in the redeem banner or in the history.
 */
function useSummary(address, tick = 0) {
  const [sum, setSum] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [accounts, all] = await Promise.all([accountsOf(address), positions(address, 'OPEN').catch(() => [])]);
      const cash = await cashOf(accounts);
      const open = all.filter((p) => !p.redeemable);
      const value = all.reduce((s, p) => s + p.value, 0), pnl = open.reduce((s, p) => s + (p.unrealized || 0), 0);
      if (alive) setSum({ cash, value, pnl, total: cash + value, open });
    })().catch(() => alive && setSum({ error: true }));
    return () => { alive = false; };
  }, [address, tick]);
  return sum;
}

// ------------------------------------------------------------ home: categories, search, market list
function Home({ active, onOpen, onPortfolio, onForYou }) {
  const { account } = useApp();
  const [cat, setCat] = useState('trending');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState({ events: [], next: null, loading: true, error: '' });
  const [reload, setReload] = useState(0);
  const sentinel = useRef(null);
  const scroller = useRef(null);
  const sum = useSummary(account.address);
  const [catSheet, setCatSheet] = useState(false);
  const saved = useSaved(account.address);
  const savedKey = saved.map((x) => x.id).join(); // the "Salvati" list follows what is saved / removed
  // "back to top": shown after about a screen and a half; tapping the Predictions tab again does the same
  const [showTop, setShowTop] = useState(false);
  const onScroll = (e) => { const el = e.currentTarget; setShowTop(el.scrollTop > el.clientHeight * 1.5); };
  const toTop = () => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
  useEffect(() => {
    const f = (e) => { if (e.detail === 'predict' && active) toTop(); };
    window.addEventListener('ck-tab-reselect', f);
    return () => window.removeEventListener('ck-tab-reselect', f);
  }, [active]);

  useEffect(() => { const id = setTimeout(() => setQuery(q.trim()), 350); return () => clearTimeout(id); }, [q]);
  useEffect(() => {
    let alive = true;
    setData({ events: [], next: null, loading: true, error: '' });
    scroller.current?.scrollTo({ top: 0 });
    (query ? searchEvents(query).then((events) => ({ events, next: null }))
      : cat === 'saved' ? savedList(account.address).then((l) => Promise.all(l.slice(0, 60).map((x) => getEvent(x.slug).catch(() => null)))).then((evs) => ({ events: evs.filter(Boolean), next: null }))
        : listEvents({ category: cat }))
      .then((r) => alive && setData({ ...r, loading: false, error: '' }))
      .catch((e) => alive && setData({ events: [], next: null, loading: false, error: e.message }));
    return () => { alive = false; };
  }, [cat, query, reload, cat === 'saved' ? savedKey : '']);

  const more = () => {
    if (data.loading || !data.next) return;
    setData((d) => ({ ...d, loading: true }));
    listEvents({ category: cat, cursor: data.next })
      .then((r) => setData((d) => ({ events: [...d.events, ...r.events.filter((e) => !d.events.some((x) => x.id === e.id))], next: r.next, loading: false, error: '' })))
      .catch(() => setData((d) => ({ ...d, loading: false })));
  };
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !active) return undefined;
    const io = new IntersectionObserver((en) => en[0].isIntersecting && more(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [active, data, cat]);

  // live prices for what's on screen (first outcome of the first markets); paused while another screen is open
  const tokens = useMemo(() => data.events.slice(0, 40).flatMap((e) => e.markets.slice(0, 3).map((m) => m.outcomes[0]?.token)), [data.events]);
  const live = useLivePrices(tokens, active);
  const [featured, ...rest] = !query && cat === 'trending' ? data.events : [null, ...data.events];

  return (
    <>
      <div class="pm-top">
        <h1>{t('predict.title')}</h1>
        <button class="pm-port-btn" onClick={onPortfolio}>
          <span class="pm-port-ic"><Icon name="wallet" size={15} /></span>
          <span class="pm-port-txt">
            <small>{t('predict.portfolio')}</small>
            <b>{sum && !sum.error ? usd(sum.total) : '…'}</b>
          </span>
        </button>
      </div>
      <div class="content pm-content" ref={scroller} onScroll={onScroll}>
        <label class="pm-search">
          <Icon name="search" size={18} />
          <input value={q} onInput={(e) => setQ(e.target.value)} placeholder={t('predict.search')} type="search" autoComplete="off" />
          {q && <button onClick={() => setQ('')} title={t('common.close')}><Icon name="close" size={16} /></button>}
        </label>
        {!query && <CategoryRow cat={cat} onPick={(c) => { setCat(c); signalCategory(account.address, c); }} onAll={() => setCatSheet(true)} />}
        {!query && cat !== 'saved' && <ForYouCard events={cat === 'trending' ? data.events : null} onOpen={onForYou} />}
        {data.error && <div class="pm-err"><Icon name="wifiOff" size={18} /><span>{t('predict.loadError')}</span><button class="link" onClick={() => setReload((x) => x + 1)}>{t('predict.retry')}</button></div>}
        {featured && <Featured ev={featured} live={live} onOpen={() => onOpen(featured)} />}
        {rest.map((ev, i) => <EventCard ev={ev} live={live} onOpen={() => onOpen(ev)} style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }} />)}
        {data.loading && [0, 1, 2].map(() => <SkeletonCard />)}
        {!data.loading && !data.error && !data.events.length && <div class="pm-empty"><Icon name={cat === 'saved' && !query ? 'bookmark' : 'search'} size={26} /><span>{query ? t('predict.noResults', { q: query }) : cat === 'saved' ? t('predict.saved.empty') : t('predict.empty')}</span></div>}
        <div ref={sentinel} style={{ height: '1px' }} />
      </div>
      {active && <button class={`pm-totop ${showTop ? 'on' : ''}`} onClick={toTop} title={t('predict.toTop')} tabIndex={showTop ? 0 : -1}><Icon name="arrowUp" size={20} /></button>}
      {catSheet && <CategorySheet cat={cat} savedCount={saved.length} onPick={(c) => { setCat(c); setCatSheet(false); signalCategory(account.address, c); }} onClose={() => setCatSheet(false)} />}
    </>
  );
}

// ------------------------------------------------------------ categories
const CAT_META = {
  trending: { icon: 'flame', color: '#f2683c' }, new: { icon: 'sparkle', color: '#d4a017' }, politics: { icon: 'landmark', color: '#5b7cfa' },
  sports: { icon: 'trophy', color: '#22a06b' }, crypto: { icon: 'bitcoin', color: '#f7931a' }, finance: { icon: 'bars', color: '#14b8a6' },
  geopolitics: { icon: 'flag', color: '#e5484d' }, tech: { icon: 'chip', color: '#8b5cf6' }, 'pop-culture': { icon: 'film', color: '#ec4899' },
  world: { icon: 'globe', color: '#0ea5e9' }, economy: { icon: 'coins', color: '#84a33a' },
  saved: { icon: 'bookmark', color: '#e0a20b' },
};
const MAIN_CATS = ['trending', 'new', 'politics', 'sports'];

const CatTile = ({ c, on, onClick, label, icon, more }) => (
  <button class={`pm-cat ${on ? 'on' : ''}`} style={{ '--c': CAT_META[c]?.color || 'var(--primary)' }} onClick={onClick} role="tab" aria-selected={on}>
    <span class="pm-cat-ic"><Icon name={icon || CAT_META[c].icon} size={18} /></span>
    <span class="pm-cat-name">{label || t(`predict.cat.${c}`)}{more && <Icon name="chevron" size={11} stroke={2.6} />}</span>
  </button>
);

/** The four main categories always at hand; the fifth tile opens all of them (or shows the one picked there). */
function CategoryRow({ cat, onPick, onAll }) {
  const other = !MAIN_CATS.includes(cat);
  return (
    <div class="pm-catrow" role="tablist">
      {MAIN_CATS.map((c) => <CatTile key={c} c={c} on={cat === c} onClick={() => onPick(c)} />)}
      {other ? <CatTile c={cat} on onClick={onAll} more /> : <CatTile c="all" icon="grid" label={t('predict.cat.all')} onClick={onAll} />}
    </div>
  );
}

function CategorySheet({ cat, savedCount, onPick, onClose }) {
  return (
    <Sheet title={t('predict.cat.title')} onClose={onClose}>
      <div class="pm-catgrid">
        {['saved', ...CATEGORIES].map((c) => (
          <button key={c} class={`pm-catbig ${cat === c ? 'on' : ''}`} style={{ '--c': CAT_META[c].color }} onClick={() => onPick(c)}>
            <span class="pm-cat-ic"><Icon name={CAT_META[c].icon} size={22} /></span>
            <span>{t(`predict.cat.${c}`)}{c === 'saved' && savedCount > 0 ? ` · ${savedCount}` : ''}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------ "For you": vertical feed, one big card per screen
/** Entry card on the home: three event images fanned out, opens the feed. */
function ForYouCard({ events, onOpen }) {
  const [list, setList] = useState(events?.length ? events : null);
  useEffect(() => { if (events?.length) setList(events); else if (!list) suggestions().then((r) => setList(r.events)).catch(() => setList([])); }, [events]);
  const pics = (list || []).filter((e) => e.image).slice(0, 3);
  return (
    <button class="pm-fy-card" onClick={onOpen}>
      <span class="pm-fy-stack" aria-hidden="true">
        {pics.length ? pics.map((e, i) => <img key={e.id} src={e.image} alt="" style={{ '--k': i }} />) : [0, 1, 2].map((i) => <span key={i} class="skeleton" style={{ '--k': i }} />)}
      </span>
      <span class="pm-fy-txt"><b>{t('predict.forYou.title')}</b><small>{t('predict.forYou.sub')}</small></span>
      <span class="pm-fy-go"><Icon name="forward" size={18} /></span>
    </button>
  );
}

const HINT_KEY = 'ew_fy_hint';
const SNAP = 'transform .44s cubic-bezier(.2, .9, .25, 1)';
const STILL = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SNAP_ALL = 'transform .44s cubic-bezier(.2, .9, .25, 1), opacity .44s cubic-bezier(.2, .9, .25, 1)';

/**
 * The feed pages itself (not CSS snapping, which feels loose on Android): the card follows the finger and, past
 * a distance or a flick, the next one slides in; otherwise it springs back. Only the cards around the current one
 * are mounted, so a long feed stays light.
 */
function ForYou({ onBack, onOpen, active, backRef }) {
  const { account } = useApp();
  const me = account.address;
  const sum = useSummary(me); // cash to buy with, always in sight
  const saved = useSaved(me);
  // the account's personal feed (shared/recommend.js): trends, its interests and some exploration.
  // gen: a new, reshuffled feed (first back = back to the top with fresh cards, as on TikTok)
  const [gen, setGen] = useState(0);
  const feed = useMemo(() => createFeed(me), [me, gen]);
  const [data, setData] = useState({ events: [], more: true, loading: true, error: '' });
  const [idx, setIdx] = useState(0);
  const [hint, setHint] = useState(() => { try { return !localStorage.getItem(HINT_KEY); } catch { return false; } });
  const [renew, setRenew] = useState(0);
  const box = useRef(null), track = useRef(null), drag = useRef(null);
  const load = () => {
    const f = feed;
    setData((d) => ({ ...d, loading: true, error: '' }));
    f.next(6)
      .then((evs) => { if (f === feedRef.current) setData((d) => ({ events: [...d.events, ...evs.filter((e) => !d.events.some((x) => x.id === e.id))], more: evs.length > 0, loading: false, error: '' })); })
      .catch((e) => { if (f === feedRef.current) setData((d) => ({ ...d, loading: false, error: e.message })); });
  };
  const feedRef = useRef(feed);
  feedRef.current = feed;
  useEffect(() => { load(); }, [feed]);
  // back: the first one goes to the top with new cards, a second one (without scrolling in between) closes
  const armed = useRef(false);
  useEffect(() => { if (idx > 0) armed.current = false; }, [idx]);
  useEffect(() => {
    if (!backRef) return undefined;
    backRef.current = () => {
      if (armed.current) return false;
      armed.current = true;
      setData({ events: [], more: true, loading: true, error: '' });
      setIdx(0); setGen((g) => g + 1); setRenew((r) => r + 1);
      return true;
    };
    return () => { backRef.current = null; };
  }, [backRef]);
  useEffect(() => { if (!data.loading && data.more && idx >= data.events.length - 3) load(); }, [idx, data.events.length]);
  // taste signals: time spent on each card (a long look counts, a quick swipe away a little against), cards seen
  const enteredAt = useRef(Date.now());
  useEffect(() => {
    const ev = data.events[idx];
    if (ev) markSeenTaste(me, ev.id);
    const at = enteredAt.current; enteredAt.current = Date.now();
    return () => {
      const dt = Date.now() - at;
      if (ev) signal(me, ev, dt > 3000 ? 'dwell' : dt < 900 ? 'skip' : null);
    };
  }, [idx, !!data.events[idx]]);
  // one slot after the last card: the loading card (or the error)
  const count = data.events.length + (data.loading || data.error ? 1 : 0);

  // Parallax: each slide's image and text get a transform from p, the slide's distance from the screen in screen
  // heights (0 = on screen, 1 = the next one below). Only transforms/opacity, with the same transition as the track:
  // the GPU animates them on its own, no style work per frame.
  const move = (dy, anim) => {
    const el = track.current;
    if (!el) return;
    const h = box.current?.clientHeight || 1, tr = anim ? SNAP_ALL : 'none';
    el.style.transition = anim ? SNAP : 'none';
    el.style.transform = `translate3d(0, calc(${-idx * 100}% + ${dy}px), 0)`;
    for (const sl of el.children) {
      const p = STILL ? 0 : Number(sl.dataset.i) - idx + dy / h, a = Math.min(1, Math.abs(p)); // no parallax with reduced motion
      const hero = sl.querySelector('.pm-fy-hero-in'), body = sl.querySelector('.pm-fy-body'), meta = sl.querySelector('.pm-fy-meta');
      if (hero) { hero.style.transition = tr; hero.style.transform = `translate3d(0, ${(p * 22 - 8).toFixed(2)}%, 0) scale(${(1.06 + a * 0.1).toFixed(3)})`; }
      if (body) { body.style.transition = tr; body.style.transform = `translate3d(0, ${(p * 14).toFixed(2)}%, 0)`; }
      if (meta) { meta.style.transition = tr; meta.style.opacity = String(1 - a * 0.9); }
    }
  };
  useLayoutEffect(() => { move(0, true); }, [idx]);
  useLayoutEffect(() => { move(0, false); }, [count]);
  const go = (i) => {
    const n = Math.max(0, Math.min(count - 1, i));
    if (n === idx) move(0, true); else setIdx(n);
    if (n > 0 && hint) { setHint(false); try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ } }
  };
  const [trade, setTrade] = useState(null); // { ev, market, outcome }
  const acc = usePolyAccount();
  const onStart = (e) => {
    if (trade || e.target.closest?.('.overlay')) return; // the buy sheet scrolls on its own
    const y = e.touches[0].clientY; drag.current = { y, t: performance.now(), dy: 0 }; move(0, false);
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    let dy = e.touches[0].clientY - d.y;
    if ((idx === 0 && dy > 0) || (idx >= count - 1 && dy < 0)) dy *= 0.3; // rubber band at the ends
    d.dy = dy; move(dy, false);
  };
  const onEnd = () => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    const h = box.current?.clientHeight || 1, v = d.dy / Math.max(1, performance.now() - d.t); // px/ms
    if (d.dy < -h * 0.18 || (v < -0.45 && d.dy < -24)) go(idx + 1);
    else if (d.dy > h * 0.18 || (v > 0.45 && d.dy > 24)) go(idx - 1);
    else move(0, true);
  };

  const cur = data.events[idx];
  const tokens = useMemo(() => (cur ? cur.markets.slice(0, 3).flatMap((m) => m.outcomes.slice(0, 2).map((o) => o.token)) : []), [cur?.id]);
  const live = useLivePrices(tokens, active);
  const shown = [];
  for (let i = Math.max(0, idx - 1); i <= Math.min(count - 1, idx + 2); i++) shown.push(i);
  return (
    <>
    <div class="pm-fy" ref={box} onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}>
      <div class={`pm-fy-track ${renew ? 'renew' : ''}`} key={`r${renew}`} ref={track}>
        {shown.map((i) => (
          <div class="pm-fy-slide" key={data.events[i]?.id || `slot${i}`} data-i={i} style={{ top: `${i * 100}%` }}>
            {data.events[i] ? <FeedCard ev={data.events[i]} live={i === idx ? live : {}}
              saved={saved.some((x) => x.id === data.events[i].id)} onSave={() => toggleSaved(me, data.events[i])}
              onOpen={() => { signal(me, data.events[i], 'details'); onOpen(data.events[i]); }}
              onBuy={(market, outcome) => { signal(me, data.events[i], 'buyTap'); setTrade({ ev: data.events[i], market, outcome }); }} />
              : data.error ? <div class="pm-fy-item pm-fy-msg"><Icon name="wifiOff" size={26} /><span>{t('predict.loadError')}</span><button class="pm-fy-retry" onClick={() => load()}>{t('predict.retry')}</button></div>
                : <FeedSkeleton />}
          </div>
        ))}
      </div>
      <button class="pm-fy-back" onClick={onBack} title={t('common.back')}><Icon name="back" size={20} /></button>
      <span class="pm-fy-cash" title={t('predict.cash')}><Icon name="wallet" size={14} /><b>{sum && !sum.error ? usd(sum.cash) : '…'}</b></span>
      {hint && data.events.length > 1 && idx === 0 && <div class="pm-fy-hint"><Icon name="arrowUp" size={18} /><span>{t('predict.forYou.hint')}</span></div>}
    </div>
    {/* outside the feed: the feed blocks the browser's own touch handling, the sheet needs it to scroll */}
      {trade && (
        <TradeSheet acc={acc} outcome={trade.outcome} onClose={() => setTrade(null)} onDone={() => signal(me, trade.ev, 'trade')}
          market={{ question: trade.ev.binary ? trade.ev.title : `${trade.ev.title} · ${trade.market.label || trade.market.question}`, conditionId: trade.market.conditionId, fee: trade.market.fee, outcomes: trade.market.outcomes.map((o) => ({ ...o, price: priceOf(o, live) })) }} />
      )}
    </>
  );
}

/** Placeholder while the next cards arrive: the card's layout in shimmering blocks. */
const FeedSkeleton = () => (
  <div class="pm-fy-item pm-fy-sk" aria-hidden="true">
    <span class="pm-fy-meta"><span class="sk w4" /><span class="sk w5" /></span>
    <span class="pm-fy-main"><span class="sk pic" /><span class="sk line" /><span class="sk line" /><span class="sk line short" /></span>
    <span class="pm-fy-odds"><span class="sk num" /><span class="sk chart" /></span>
    <span class="pm-fy-foot"><span class="sk w5" /><span class="sk w4" /></span>
  </div>
);

const OPT_COLORS = ['#7aa2ff', '#f5b94a', '#4fd394'];
const REASON_ICON = { interest: 'star', trend: 'flame', explore: 'sparkle' };

/**
 * One full-screen card: the event image as a poster on top (parallax with the swipe), the question, the odds with
 * the week's line (one line per option for multi-choice events) and buy buttons that open the sheet right away.
 */
function FeedCard({ ev, live, onOpen, onBuy, saved, onSave }) {
  const mk = ev.markets.slice(0, ev.binary ? 1 : 3);
  const [hist, setHist] = useState(null); // one series per shown option
  useEffect(() => {
    let alive = true;
    Promise.all(mk.map((m) => (m.outcomes[0]?.token ? priceHistory(m.outcomes[0].token, '1w').catch(() => []) : [])))
      .then((h) => alive && setHist(h));
    return () => { alive = false; };
  }, [ev.id]);
  const m = mk[0], p = priceOf(m?.outcomes[0], live);
  const delta = ev.binary && hist?.[0]?.length && p != null ? p - hist[0][0].p : null;
  const buy = (e, market, outcome) => { e.stopPropagation(); onBuy(market, outcome); };
  return (
    <div class={`pm-fy-item ${ev.binary ? '' : 'multi'}`} role="button" tabIndex={0} onClick={onOpen}>
      <span class="pm-fy-bg" style={ev.image ? { backgroundImage: `url("${ev.image}")` } : undefined} />
      {ev.image && <span class="pm-fy-hero"><span class="pm-fy-hero-in"><span class="pm-fy-kb" style={{ animationDelay: `${-(Number(ev.id) % 9) * .45}s` }}><img src={ev.image} alt="" /><img class="soft" src={ev.image} alt="" /></span></span></span>}
      <span class="pm-fy-meta">
        {ev._reason && <span class={`pm-fy-chip why ${ev._reason.kind}`}><Icon name={REASON_ICON[ev._reason.kind]} size={12} />{ev._reason.kind === 'interest' ? t('predict.why.interest', { tag: ev._reason.label }) : t(`predict.why.${ev._reason.kind}`)}</span>}
        {ev.tags[0] && ev._reason?.kind !== 'interest' && <span class="pm-fy-chip">{ev.tags[0]}</span>}
        {ev.endDate && <span class="pm-fy-chip"><Icon name="history" size={12} />{day(ev.endDate)}</span>}
      </span>

      <span class="pm-fy-body">
        <span class="pm-fy-title">{ev.title}</span>
        <span class="pm-fy-stats"><span>{t('predict.vol', { v: usd(ev.volume, true) })}</span>{ev.volume24h > 0 && <span>{t('predict.forYou.today', { v: usd(ev.volume24h, true) })}</span>}</span>

        {ev.binary ? (
          <span class="pm-fy-odds">
            <span class="pm-fy-num"><Live value={p} class="pm-fy-pct">{pct(p)}</Live><small>{t('predict.chance')}</small>
              {delta != null && Math.abs(delta) >= 0.005 && <small class={delta > 0 ? 'up' : 'down'}>{delta > 0 ? '▲' : '▼'} {t('predict.points', { n: Math.abs(Math.round(delta * 100)) })} · {t('predict.int.1w')}</small>}
            </span>
            {hist?.[0]?.length > 2 ? <Spark points={p != null ? [...hist[0], { t: Date.now(), p }] : hist[0]} /> : <span class="pm-spark" />}
          </span>
        ) : (
          <span class="pm-fy-multi">{hist && hist.some((h) => h.length > 2) ? <MultiSpark series={hist} colors={OPT_COLORS} /> : <span class="pm-fy-multi-ph" />}</span>
        )}

        {ev.binary ? (
          <span class="pm-fy-buy">
            {m.outcomes.slice(0, 2).map((o, i) => {
              const px = priceOf(o, live);
              return <button key={o.token || i} class={`pm-fy-btn ${i ? 'no' : 'yes'}`} onClick={(e) => buy(e, m, i)}><span>{outcomeName(o.name)}</span><Live value={px}><b>{cents(px)}</b></Live></button>;
            })}
          </span>
        ) : (
          <span class="pm-fy-opts">
            {mk.map((x, i) => {
              const q = priceOf(x.outcomes[0], live);
              return (
                <span class="pm-fy-opt" key={x.id || x.question} style={{ '--oc': OPT_COLORS[i] }}>
                  <span class="head"><i class="dot" /><span class="lbl">{x.label || x.question}</span><b>{pct(q)}</b></span>
                  <span class="btns">
                    {x.outcomes.slice(0, 2).map((o, k) => (
                      <button key={o.token || k} class={`pm-fy-mini ${k ? 'no' : 'yes'}`} onClick={(e) => buy(e, x, k)}>
                        <span>{outcomeName(o.name)}</span><b>{cents(priceOf(o, live))}</b>
                      </button>
                    ))}
                  </span>
                </span>
              );
            })}
            {ev.markets.length > 3 && <small>{tn('predict.forYou.more', ev.markets.length - 3)}</small>}
          </span>
        )}
        <span class="pm-fy-foot2">
          <button class={`pm-fy-save ${saved ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onSave(); }}><Icon name="bookmark" size={16} />{saved ? t('predict.saved.done') : t('predict.saved.add')}</button>
          <span class="pm-fy-open">{t('predict.forYou.open')}<Icon name="forward" size={14} /></span>
        </span>
      </span>
    </div>
  );
}

/** Up to three options' week lines on one scale (multi-choice events). */
function MultiSpark({ series, colors }) {
  const W = 300, H = 72, PAD = 6;
  const all = series.flat();
  if (!all.length) return null;
  const t0 = Math.min(...all.map((x) => x.t)), t1 = Math.max(...all.map((x) => x.t)), top = Math.max(0.05, ...all.map((x) => x.p)) * 1.08;
  return (
    <svg class="pm-fy-mspark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {series.map((pts, i) => {
        if (pts.length < 2) return null;
        const step = Math.max(1, Math.ceil(pts.length / 48));
        const xy = pts.filter((_, k) => k % step === 0 || k === pts.length - 1).map((x) => [((x.t - t0) / Math.max(1, t1 - t0)) * W, PAD + (1 - x.p / top) * (H - PAD * 2)]);
        return <path key={i} d={smooth(xy)} stroke={colors[i]} />;
      })}
    </svg>
  );
}

const SkeletonCard = () => (
  <div class="pm-card pm-sk">
    <div class="pm-card-head"><span class="skeleton" style={{ width: '3rem', height: '3rem', borderRadius: '.75rem' }} /><div class="grow col" style={{ gap: '.5rem' }}><span class="skeleton" style={{ width: '90%' }} /><span class="skeleton" style={{ width: '55%' }} /></div></div>
    <div class="pm-yn"><span class="skeleton" style={{ height: '2.25rem' }} /><span class="skeleton" style={{ height: '2.25rem' }} /></div>
  </div>
);

function ProbBar({ p }) {
  return <span class="pm-bar"><i style={{ width: `${Math.max(2, (p || 0) * 100)}%` }} /></span>;
}

function EventCard({ ev, live, onOpen, style }) {
  const m = ev.markets[0];
  const p = priceOf(m.outcomes[0], live);
  return (
    <button class="pm-card" onClick={onOpen} style={style}>
      <div class="pm-card-head">
        <Img src={ev.image} size={48} />
        <span class="pm-card-title">{ev.title}</span>
        {ev.binary && <Gauge p={p} />}
      </div>
      {ev.binary ? (
        <div class="pm-yn">
          {m.outcomes.slice(0, 2).map((o, i) => {
            const px = priceOf(o, live);
            return <span class={`pm-yn-pill ${i ? 'no' : 'yes'}`}><span>{outcomeName(o.name)}</span><Live value={px}><b>{cents(px)}</b></Live></span>;
          })}
        </div>
      ) : (
        <div class="pm-rows">
          {ev.markets.slice(0, 3).map((x) => {
            const px = priceOf(x.outcomes[0], live);
            return (
              <div class="pm-row">
                <span class="pm-row-label">{x.label || x.question}</span>
                <ProbBar p={px} />
                <Live value={px}><b>{pct(px)}</b></Live>
              </div>
            );
          })}
        </div>
      )}
      <div class="pm-meta">
        <span><Icon name="predict" size={13} />{t('predict.vol', { v: usd(ev.volume, true) })}</span>
        {!ev.binary && ev.markets.length > 3 && <span><Icon name="phrase" size={13} />{tn('predict.moreOutcomes', ev.markets.length - 3)}</span>}
        {ev.endDate && <span><Icon name="history" size={13} />{day(ev.endDate)}</span>}
      </div>
    </button>
  );
}

/** Semicircle gauge of a probability (binary markets). */
function Gauge({ p }) {
  const v = Math.max(0, Math.min(1, p ?? 0));
  return (
    <span class={`pm-gauge ${v >= 0.5 ? 'hi' : 'lo'}`} aria-label={pct(p)}>
      <svg viewBox="0 0 48 28" aria-hidden="true">
        <path d="M4 24a20 20 0 0 1 40 0" pathLength="1" class="track" />
        <path d="M4 24a20 20 0 0 1 40 0" pathLength="1" class="fill" style={{ strokeDasharray: `${v} 1` }} />
      </svg>
      <Live value={p}><b>{pct(p)}</b></Live>
      <small>{t('predict.chance')}</small>
    </span>
  );
}

function Featured({ ev, live, onOpen }) {
  const m = ev.markets[0];
  const o = m.outcomes[0];
  const p = priceOf(o, live);
  const [hist, setHist] = useState(null);
  useEffect(() => { if (o?.token) priceHistory(o.token, '1w').then(setHist).catch(() => setHist([])); }, [o?.token]);
  const weekDelta = hist?.length && p != null ? p - hist[0].p : null;
  return (
    <button class="pm-featured" onClick={onOpen}>
      <span class="pm-feat-bg" style={ev.image ? { backgroundImage: `url("${ev.image}")` } : undefined} />
      <span class="pm-feat-tag"><Icon name="flash" size={13} />{t('predict.featured')}</span>
      <span class="pm-feat-title">{ev.title}</span>
      <span class="pm-feat-row">
        <span class="pm-feat-num">
          <Live value={p} class="pm-feat-pct">{pct(p)}</Live>
          <span class="pm-feat-sub">{ev.binary ? t('predict.chance') : (m.label || m.question)}</span>
          {weekDelta != null && Math.abs(weekDelta) >= 0.005 && <span class={`pm-feat-delta ${weekDelta > 0 ? 'up' : 'down'}`}>{weekDelta > 0 ? '▲' : '▼'} {t('predict.points', { n: Math.abs(Math.round(weekDelta * 100)) })} · {t('predict.int.1w')}</span>}
        </span>
        {hist && hist.length > 2 ? <Spark points={p != null ? [...hist, { t: Date.now(), p }] : hist} /> : <span class="pm-spark" />}
      </span>
      <span class="pm-meta light"><span>{t('predict.vol', { v: usd(ev.volume, true) })}</span>{ev.endDate && <span>{t('predict.ends', { d: day(ev.endDate) })}</span>}</span>
    </button>
  );
}

/** The week's line on the featured card: smoothed, with a soft area and a live dot at the end. */
function Spark({ points }) {
  const W = 200, H = 64, PAD = 6;
  const step = Math.max(1, Math.ceil(points.length / 48)); // at most ~48 points: a smooth line, not every tick
  const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const ps = pts.map((x) => x.p), min = Math.min(...ps), max = Math.max(...ps), span = Math.max(0.04, max - min), mid = (min + max) / 2;
  const xy = pts.map((x, i) => [(i / (pts.length - 1)) * W, PAD + (1 - ((x.p - (mid - span / 2)) / span)) * (H - PAD * 2)]);
  const d = smooth(xy);
  const end = xy[xy.length - 1];
  return (
    <span class="pm-spark" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs><linearGradient id="pm-spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient></defs>
        <path d={`${d}L${W} ${H}L0 ${H}Z`} fill="url(#pm-spark-fill)" />
        <path d={d} class="line" />
      </svg>
      <i style={{ left: `${(end[0] / W) * 100}%`, top: `${(end[1] / H) * 100}%` }} />
    </span>
  );
}

/** Catmull-Rom spline through the points, as cubic Beziers. */
function smooth(xy) {
  let d = `M${xy[0][0].toFixed(1)} ${xy[0][1].toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const [p0, p1, p2, p3] = [xy[i - 1] || xy[i], xy[i], xy[i + 1], xy[i + 2] || xy[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

// ------------------------------------------------------------ event detail
const SHOWN_OUTCOMES = 6;

function EventView({ slug, initial, onBack, active }) {
  const [ev, setEv] = useState(initial || null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(0);
  const [all, setAll] = useState(false);
  const [more, setMore] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [trade, setTrade] = useState(null); // outcome index being traded
  const acc = usePolyAccount();
  const scroller = useRef(null);
  useEffect(() => { getEvent(slug).then((e) => (e ? setEv(e) : setErr(t('predict.notFound')))).catch((e) => !initial && setErr(e.message)); }, [slug]);
  // taste: opening an event says a little about what interests the user (once per visit, with its tags loaded)
  const { account: me } = useApp();
  const opened = useRef(false);
  const savedHere = useSaved(me.address);
  const isSaved = !!ev && savedHere.some((x) => x.id === ev.id);
  useEffect(() => { if (ev?.tagSlugs && !opened.current) { opened.current = true; signal(me.address, ev, 'open'); } }, [ev]);
  const tokens = useMemo(() => (ev ? ev.markets.flatMap((m) => m.outcomes.map((o) => o.token)) : []), [ev]);
  const live = useLivePrices(tokens, active);
  const openSite = () => window.dispatchEvent(new CustomEvent('ck-open-url', { detail: MARKET_URL(slug) }));
  const pick = (i) => { setSel(i); scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }); };

  const bar = (
    // floats over the banner: transparent at the top (the blurred picture shows through), frosted once scrolled
    <div class={`topbar pm-ev-bar ${scrolled ? 'scrolled' : ''}`}>
      <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
      <h1 />
      {ev && <button class={`iconbtn pm-save ${isSaved ? 'on' : ''}`} onClick={() => toggleSaved(me.address, ev)} title={isSaved ? t('predict.saved.remove') : t('predict.saved.add')}><Icon name="bookmark" size={18} /></button>}
      <button class="iconbtn" onClick={openSite} title={t('predict.openSite')}><Icon name="external" size={18} /></button>
    </div>
  );
  if (!ev) return <div class="pm-ev-wrap">{bar}<div class="pm-center">{err ? <div class="pm-err"><span>{err}</span></div> : <Spinner lg />}</div></div>;

  const m = ev.markets[Math.min(sel, ev.markets.length - 1)];
  const list = all ? ev.markets : ev.markets.slice(0, SHOWN_OUTCOMES);
  return (
    <div class="pm-ev-wrap">
      {bar}
      <div class="content pm-content pm-ev" ref={scroller} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 12)}>
        <div class="pm-ev-banner">
          <span class="pm-ev-backdrop" style={ev.image ? { backgroundImage: `url("${ev.image}")` } : undefined} />
          <Img src={ev.image} size={64} />
          <h2>{ev.title}</h2>
          <div class="pm-chips">
            <span><Icon name="history" size={13} />{ev.closed ? t('predict.closed') : ev.endDate ? t('predict.ends', { d: day(ev.endDate) }) : t('predict.open')}</span>
            <span><Icon name="predict" size={13} />{t('predict.vol', { v: usd(ev.volume, true) })}</span>
            {!ev.binary && <span><Icon name="phrase" size={13} />{tn('predict.options', ev.markets.length)}</span>}
          </div>
        </div>

        {/* the chart comes first, for the selected option; the options list follows */}
        <ChartCard market={m} live={live} title={ev.binary ? null : (m.label || m.question)} image={!ev.binary && m.image !== ev.image ? m.image : null} />

        {!ev.closed && m.acceptingOrders !== false ? (
          <div class="pm-trade">
            {m.outcomes.slice(0, 2).map((o, i) => {
              const px = priceOf(o, live);
              return (
                <button class={`pm-trade-tile ${i ? 'no' : 'yes'}`} onClick={() => setTrade(i)}>
                  <span>{t('predict.buyOutcome', { outcome: outcomeName(o.name) })}</span>
                  <Live value={px}><b>{cents(px)}</b></Live>
                </button>
              );
            })}
          </div>
        ) : <div class="pm-soon"><Icon name="lock" size={14} />{t('predict.notTrading')}</div>}

        {!ev.binary && (
          <>
            <div class="section-title">{t('predict.allOptions')}</div>
            <div class="pm-outcomes" role="listbox">
              {list.map((x, i) => {
                const px = priceOf(x.outcomes[0], live);
                return (
                  <button class={`pm-outcome ${i === sel ? 'on' : ''}`} role="option" aria-selected={i === sel} onClick={() => pick(i)}>
                    {x.image && x.image !== ev.image ? <Img src={x.image} size={34} round /> : <span class="pm-rank">{i + 1}</span>}
                    <span class="pm-outcome-main">
                      <span class="pm-outcome-name">{x.label || x.question}</span>
                      <ProbBar p={px} />
                    </span>
                    <Live value={px} class="pm-outcome-pct">{pct(px)}</Live>
                  </button>
                );
              })}
            </div>
            {ev.markets.length > SHOWN_OUTCOMES && (
              <button class={`pm-more ${all ? 'open' : ''}`} onClick={() => setAll(!all)}>
                {all ? t('predict.less') : tn('predict.showAll', ev.markets.length)}<Icon name="chevron" size={16} />
              </button>
            )}
          </>
        )}

        <div class="pm-stats">
          <div><small>{t('predict.volume')}</small><b>{usd(m.volume ?? ev.volume, true)}</b></div>
          <div><small>{t('predict.volume24h')}</small><b>{usd(m.volume24h, true)}</b></div>
          <div><small>{t('predict.liquidity')}</small><b>{usd(m.liquidity, true)}</b></div>
          <div><small>{t('predict.endDate')}</small><b>{m.endDate ? day(m.endDate) : '–'}</b></div>
        </div>

        {(m.description || ev.description) && (
          <div class="pm-rules card">
            <div class="pm-rules-head"><Icon name="approve" size={16} />{t('predict.rules')}</div>
            <p class={more ? '' : 'clamp'}>{m.description || ev.description}</p>
            <button class="link small" onClick={() => setMore(!more)}>{more ? t('predict.less') : t('predict.more')}</button>
            {(m.resolutionSource || ev.resolutionSource) && <div class="small muted pm-src">{t('predict.source')}: {m.resolutionSource || ev.resolutionSource}</div>}
          </div>
        )}
        <div class="tiny muted center">{t('predict.poweredBy')}</div>
      </div>
      {trade != null && (
        <TradeSheet acc={acc} outcome={trade} onClose={() => setTrade(null)} onDone={() => signal(me.address, ev, 'trade')}
          market={{ question: ev.binary ? ev.title : `${ev.title} · ${m.label || m.question}`, conditionId: m.conditionId, fee: m.fee, outcomes: m.outcomes.map((o) => ({ ...o, price: priceOf(o, live) })) }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------ chart: one series (probability of the first outcome)
function ChartCard({ market, live, title, image }) {
  const o = market.outcomes[0];
  const [interval, setIv] = useState('1w');
  const [hist, setHist] = useState(null);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    let alive = true; setHist(null); setHover(null);
    if (!o?.token) { setHist([]); return undefined; }
    priceHistory(o.token, interval).then((h) => alive && setHist(h)).catch(() => alive && setHist([]));
    return () => { alive = false; };
  }, [o?.token, interval]);
  const now = priceOf(o, live);
  const pts = useMemo(() => (hist && now != null && hist.length ? [...hist, { t: Date.now(), p: now }] : hist || []), [hist, now]);
  const first = pts[0]?.p, shown = hover ? hover.p : now;
  const delta = first != null && shown != null ? shown - first : null;

  return (
    <div class="card pm-chart-card">
      {title && <div class="pm-chart-title">{image && <Img src={image} size={22} round />}<span>{title}</span></div>}
      <div class="pm-chart-head">
        <Live value={hover ? null : now} class="pm-chart-val">{pct(shown)}</Live>
        <span class="pm-chart-sub">
          <small>{t('predict.chance')}</small>
          {delta != null && Math.abs(delta) >= 0.005 && <span class={`pm-delta ${delta > 0 ? 'up' : 'down'}`}>{delta > 0 ? '▲' : '▼'} {t('predict.points', { n: Math.abs(Math.round(delta * 100)) })}</span>}
        </span>
      </div>
      {hist === null ? <div class="pm-chart pm-chart-sk"><span class="skeleton" /></div>
        : pts.length < 2 ? <div class="pm-chart pm-chart-empty small muted">{t('predict.noHistory')}</div>
          : <LineChart points={pts} onHover={setHover} label={t('predict.chartLabel', { from: pct(pts[0].p), to: pct(pts[pts.length - 1].p) })} />}
      <div class="tabs pm-intervals">
        {INTERVALS.map((i) => <button class={`tab ${interval === i ? 'active' : ''}`} onClick={() => setIv(i)}>{t(`predict.int.${i}`)}</button>)}
      </div>
    </div>
  );
}

/**
 * Single-series line chart with a touch crosshair. kind 'prob': 0..1 shown as %; 'money': USD with a zero line,
 * green when the last value is above it, red below.
 */
function LineChart({ points, onHover, label, kind = 'prob' }) {
  const box = useRef(null);
  const [w, setW] = useState(320);
  const [hi, setHi] = useState(null);
  const H = 168, PAD = 8;
  useLayoutEffect(() => {
    const el = box.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 320)); ro.observe(el); setW(el.clientWidth || 320);
    return () => ro.disconnect();
  }, []);
  const ps = points.map((x) => x.p);
  let lo, top;
  if (kind === 'prob') { // the data range padded and snapped to 10% steps, never outside 0..100%
    lo = Math.max(0, Math.floor((Math.min(...ps) - 0.03) * 10) / 10); top = Math.min(1, Math.ceil((Math.max(...ps) + 0.03) * 10) / 10);
    if (top - lo < 0.2) { const mid = (lo + top) / 2; lo = Math.max(0, mid - 0.1); top = Math.min(1, lo + 0.2); }
  } else { // money: always include zero
    lo = Math.min(0, ...ps); top = Math.max(0, ...ps);
    const pad = Math.max(1, (top - lo) * 0.12); if (lo < 0) lo -= pad; top += pad;
  }
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const X = (tm) => ((tm - t0) / Math.max(1, t1 - t0)) * w;
  const Y = (p) => PAD + (1 - (p - lo) / (top - lo)) * (H - PAD * 2);
  const step = Math.max(1, Math.ceil(points.length / 160));
  const xy = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((x) => [X(x.t), Y(x.p)]);
  const line = smooth(xy);
  const baseY = kind === 'money' ? Y(0) : H;
  const area = `${line}L${w} ${baseY}L0 ${baseY}Z`;
  const grid = kind === 'prob' ? [lo, (lo + top) / 2, top] : [0];
  const fmt = (v) => (kind === 'prob' ? `${Math.round(v * 100)}%` : usd(v, true));
  const last = points[points.length - 1];
  const neg = kind === 'money' && last.p < 0;
  const id = kind === 'money' ? 'pm-area-money' : 'pm-area';

  const pick = (e) => {
    const r = box.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(w, (e.touches?.[0]?.clientX ?? e.clientX) - r.left));
    const tm = t0 + (x / w) * (t1 - t0);
    let best = 0; for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - tm) < Math.abs(points[best].t - tm)) best = i;
    setHi(best); onHover?.(points[best]);
  };
  const leave = () => { setHi(null); onHover?.(null); };
  const hp = hi != null ? points[hi] : null;

  return (
    <div class={`pm-chart ${kind} ${neg ? 'neg' : ''}`} ref={box} onPointerDown={pick} onPointerMove={(e) => (e.buttons || e.pointerType === 'mouse') && pick(e)} onPointerUp={leave} onPointerLeave={leave} onPointerCancel={leave}
      role="img" aria-label={label}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop-a" /><stop offset="1" class="stop-b" /></linearGradient></defs>
        {grid.map((g) => <line x1="0" x2={w} y1={Y(g)} y2={Y(g)} class={`pm-grid ${kind === 'money' ? 'zero' : ''}`} />)}
        <path d={area} fill={`url(#${id})`} />
        <path d={line} class="pm-line" />
        {hp ? <><line x1={X(hp.t)} x2={X(hp.t)} y1="0" y2={H} class="pm-cross" /><circle cx={X(hp.t)} cy={Y(hp.p)} r="5" class="pm-dot" /></>
          : <circle cx={X(last.t)} cy={Y(last.p)} r="4.5" class="pm-dot live" />}
      </svg>
      {grid.map((g) => <span class="pm-ylab" style={{ top: `${Y(g)}px` }}>{fmt(g)}</span>)}
      {hp && (
        // value / date of the touched point, above the crosshair and kept inside the chart
        <span class="pm-tip" style={{ left: `${Math.max(64, Math.min(w - 64, X(hp.t)))}px` }}>
          {kind === 'money' && <b>{signed(hp.p)} · </b>}
          {new Date(hp.t).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------ portfolio (read-only)
// what can be redeemed isn't a tab: it is an action, shown as a banner above the list
const TABS = [['OPEN', 'predict.pos.positions'], ['ORDERS', 'predict.pos.orders'], ['CLOSED', 'predict.pos.history']];

function Portfolio({ onBack, onOpen }) {
  const { account } = useApp();
  const [tick, setTick] = useState(0);
  const sum = useSummary(account.address, tick);
  const [tab, setTab] = useState('OPEN');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState(null);
  const [sheet, setSheet] = useState(null); // { cash: 'deposit' | 'withdraw' } | { sell: position }
  const [busy, setBusy] = useState('');
  const acc = usePolyAccount();
  const { authorize, toast } = useApp();
  const refreshAll = () => setTick((x) => x + 1);
  const doRedeem = async (p) => {
    setBusy(p.token);
    try { await authorize((password) => redeem(acc, p, password), t('predict.redeem')); toast(t('predict.redeemed')); refreshAll(); } catch (e) {
      if (e.key === 'predict.relayer.needKey') setSheet({ relayer: true }); // Deposit Wallet: link the relayer first
      else if (!e.cancelled) toast(e.message, 'warn');
    }
    setBusy('');
  };
  useEffect(() => { mainAccount(account.address).then(setUser).catch(() => setUser(account.address.toLowerCase())); }, [account.address]);
  useEffect(() => { if (user) userStats(user).then(setStats).catch(() => setStats(null)); }, [user, tick]);
  const openRows = sum?.open;
  // resolved markets: the positions that pay something go to the redeem banner, the losing ones (worth nothing,
  // Polymarket keeps them as "to redeem" for good) to the history
  const [resolved, setResolved] = useState([]);
  useEffect(() => { positions(account.address, 'REDEEMABLE').then(setResolved).catch(() => setResolved([])); }, [account.address, tick]);
  const wins = resolved.filter((p) => p.value > 0.005);
  const lost = resolved.filter((p) => p.value <= 0.005);
  const shown = tab === 'CLOSED' && rows ? [...lost, ...rows].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)) : rows;
  const canAct = acc && acc.mode !== 'readonly' && acc.mode !== 'error';
  // auto-redeem on: Polymarket pays the winnings by itself a few minutes after the market closes
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    let alive = true;
    setAuto(false);
    if (acc?.wallet && acc.mode !== 'error') autoRedeemOn(acc).then((v) => alive && setAuto(v));
    return () => { alive = false; };
  }, [acc?.wallet, tick]);
  const redeemBtn = (p) => <button class="pm-act win" disabled={busy === p.token} onClick={(e) => { e.stopPropagation(); doRedeem(p); }}>{busy === p.token ? <Spinner /> : t('predict.redeem')}</button>;
  useEffect(() => {
    if (tab === 'ORDERS') return undefined;
    if (tab === 'OPEN') { setErr(''); setRows(openRows ?? null); return undefined; }
    let alive = true; setErr(''); setRows(null);
    positions(account.address, tab).then((r) => alive && setRows(r)).catch((e) => { if (alive) { setErr(e.message); setRows([]); } });
    return () => { alive = false; };
  }, [tab, account.address, tick, openRows]);

  return (
    <>
      <div class="topbar">
        <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
        <h1>{t('predict.portfolio')}</h1>
        <button class="iconbtn" onClick={() => setTick((x) => x + 1)} title={t('predict.refresh')}><Icon name="refresh" size={18} /></button>
      </div>
      <div class="content pm-content">
        <div class="hero pm-hero" style={cardStyle(account.address)}>
          <Guilloche seed={account.address} draw key={account.address} />
          <div class="pm-hero-top">
            <div class="label">{t('predict.balance')}</div>
            <span class="pm-chips">
              {acc && acc.mode !== 'error' && <span class="pm-wtype" title={t(`predict.wtype.${walletType(acc)}.hint`)}>{t(`predict.wtype.${walletType(acc)}`)}</span>}
              {auto && <span class="pm-wtype auto" title={t('predict.auto.hint')}><Icon name="check" size={11} stroke={3} />{t('predict.auto.badge')}</span>}
            </span>
          </div>
          <div class="total">{sum && !sum.error ? usd(sum.total) : '…'}</div>
          <div class="pm-hero-row">
            <span><small>{t('predict.cash')}</small><b>{sum?.cash != null ? usd(sum.cash) : '–'}</b></span>
            <span><small>{t('predict.inPositions')}</small><b>{sum?.value != null ? usd(sum.value) : '–'}</b></span>
            <span><small>{t('predict.floating')}</small><b class={sum ? tone(sum.pnl) : ''}>{sum?.pnl != null ? signed(sum.pnl) : '–'}</b></span>
          </div>
        </div>

        {acc && acc.mode !== 'readonly' && acc.mode !== 'error' && (
          <div class="pm-cash-btns">
            <button onClick={() => setSheet({ cash: 'deposit' })}><span><Icon name="receive" size={18} /></span>{t('predict.deposit')}</button>
            <button onClick={() => setSheet({ cash: 'withdraw' })}><span><Icon name="send" size={18} /></span>{t('predict.withdraw')}</button>
          </div>
        )}
        {acc?.mode === 'readonly' && <div class="pm-err"><Icon name="lock" size={18} /><span>{t(acc.reason)}</span></div>}
        {acc && acc.mode !== 'error' && <MoneyMap acc={acc} inPositions={sum?.value} tick={tick} />}

        {user && <PnlCard user={user} tick={tick} />}

        {stats && (
          <div class="pm-stats">
            <div><small>{t('predict.stats.pnl')}</small><b class={tone(stats.pnl)}>{signed(stats.pnl)}</b></div>
            <div><small>{t('predict.stats.biggestWin')}</small><b>{usd(stats.biggestWin)}</b></div>
            <div><small>{t('predict.stats.trades')}</small><b>{stats.trades != null ? stats.trades.toLocaleString(locale()) : '–'}</b></div>
            <div><small>{t('predict.stats.since')}</small><b>{stats.joined ? new Date(stats.joined).toLocaleDateString(locale(), { month: 'short', year: 'numeric' }) : '–'}</b></div>
          </div>
        )}

        {wins.length > 0 && (
          <div class="pm-win">
            <div class="pm-win-row">
              <span class="pm-win-ic"><Icon name="receive" size={20} /></span>
              <span class="grow">
                <small>{wins.length === 1 ? t('predict.win.one') : t('predict.win.many', { n: wins.length })}</small>
                <b>{usd(wins.reduce((x, p) => x + p.value, 0))}</b>
              </span>
              {/* with auto-redeem the button stays as a fallback (small winnings may be left out) */}
              {canAct && <button class={`pm-win-btn${auto ? ' soft' : ''}`} onClick={() => setSheet({ wins: true })}>{t(auto ? 'predict.win.now' : 'predict.redeem')}</button>}
            </div>
            {auto && <div class="pm-win-auto"><Icon name="check" size={12} stroke={3} /><span>{t('predict.win.auto')}</span></div>}
          </div>
        )}
        <div class="seg seg-full pm-seg" role="tablist">
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(l)}</button>)}
        </div>
        {tab === 'ORDERS' && <OpenOrders acc={acc} />}
        {tab !== 'ORDERS' && <>
        {err && <div class="pm-err"><Icon name="wifiOff" size={18} /><span>{t('predict.loadError')}</span><button class="link" onClick={() => setTick((x) => x + 1)}>{t('predict.retry')}</button></div>}
        {rows === null && [0, 1].map(() => <div class="pm-pos"><span class="skeleton" style={{ width: '2.625rem', height: '2.625rem', borderRadius: '.625rem' }} /><div class="grow col" style={{ gap: '.5rem' }}><span class="skeleton" style={{ width: '80%' }} /><span class="skeleton" style={{ width: '40%' }} /></div></div>)}
        {shown && !shown.length && !err && <div class="pm-empty"><Icon name="predict" size={28} /><span>{t(`predict.pos.empty.${tab}`)}</span></div>}
        {shown?.map((p, i) => (
          <PositionRow p={p} closed={tab === 'CLOSED'} onOpen={onOpen} style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}
            action={canAct && tab === 'OPEN' && p.price != null && p.price > 0 && p.price < 1
              ? <button class="pm-act" onClick={(e) => { e.stopPropagation(); setSheet({ sell: p }); }}>{t('predict.sell')}</button>
              : null} />
        ))}
        </>}
        <div class="tiny muted center">{t('predict.usdNote')}</div>
        {/* Deposit Wallet tools, out of the way: the relayer key and the emergency exit */}
        {acc?.mode === 'deposit' && (
          <details class="pm-adv">
            <summary>{t('predict.adv.title')}</summary>
            <button class="pm-adv-row" onClick={() => setSheet({ relayer: true })}><Icon name="key" size={16} /><span>{t('predict.relayer.title')}</span><Icon name="forward" size={14} /></button>
            <button class="pm-adv-row" onClick={() => setSheet({ emergency: true })}><Icon name="warn" size={16} /><span>{t('predict.emergency.title')}</span><Icon name="forward" size={14} /></button>
          </details>
        )}
      </div>
      {sheet?.wins && (
        <Sheet title={t('predict.win.title')} onClose={() => setSheet(null)}>
          <div class="pm-win-list">
            {wins.map((p) => <PositionRow p={p} onOpen={(slug) => { setSheet(null); onOpen(slug); }} action={redeemBtn(p)} />)}
            {!wins.length && <div class="pm-empty"><Icon name="check" size={26} /><span>{t('predict.pos.empty.REDEEMABLE')}</span></div>}
          </div>
        </Sheet>
      )}
      {sheet?.relayer && <RelayerSheet acc={acc} onClose={() => setSheet(null)} />}
      {sheet?.emergency && <EmergencySheet acc={acc} onClose={() => setSheet(null)} onDone={refreshAll} />}
      {sheet?.cash && <CashSheet kind={sheet.cash} acc={acc} onClose={() => setSheet(null)} onDone={refreshAll} />}
      {sheet?.sell && (
        <TradeSheet acc={acc} side="SELL" lockSide onClose={() => setSheet(null)} onDone={refreshAll}
          market={{ question: sheet.sell.title, conditionId: sheet.sell.conditionId, outcomes: [{ name: sheet.sell.outcome, token: sheet.sell.token, price: sheet.sell.price }] }} />
      )}
    </>
  );
}

/** Polymarket wallet type of the account, for the badge: eoa | deposit | safe | safeRo | ro. */
const walletType = (acc) => (acc.mode === 'readonly' ? (acc.reason === 'predict.acc.safeOwners' ? 'safeRo' : 'ro') : acc.mode);

const PUSD_ICON = (POPULAR_TOKENS[137] || []).find((x) => x.symbol === 'pUSD')?.icon;
const USDC_ICON = (POPULAR_TOKENS[137] || []).find((x) => x.symbol === 'USDC')?.icon;

/**
 * Where the money is: the Polymarket account (trading cash + positions) and the user's own address (funds that
 * must be deposited before trading), with what to move where. A direct address is one place for everything.
 */
function MoneyMap({ acc, inPositions, tick }) {
  const { toast } = useApp();
  const [b, setB] = useState(null);
  useEffect(() => { balances(acc).then(setB).catch(() => setB(null)); }, [acc, tick]);
  if (!b) return null;
  const n = (x) => Number(x) / 1e6;
  const own = [['USDC', n(b.usdc), USDC_ICON], ['USDC.e', n(b.usdce), USDC_ICON], ...(b.separate ? [['pUSD', n(b.pusdOwn), PUSD_ICON]] : [])].filter(([, v]) => v >= 0.005);
  const ownTotal = own.reduce((x, [, v]) => x + v, 0);
  const canAct = acc.mode !== 'readonly';
  const row = (key, icon, sym, sub, v) => (
    <div class="mm-row" key={key}>{icon}<span class="grow"><b>{sym}</b>{sub && <small>{sub}</small>}</span><span>{usd(v)}</span></div>
  );
  return (
    <div class="card mm">
      <div class="mm-title">{t('predict.map.title')}</div>
      {b.separate && (
        <div class="mm-place">
          <div class="mm-head"><b>{t('predict.map.account')}</b><span class="mm-tag">{t(`predict.wtype.${walletType(acc)}`)}</span></div>
          {/* the only place in the app where the Polymarket account's address is shown: tap to copy */}
          <button class="mm-addr" title={acc.wallet} onClick={async () => { await navigator.clipboard.writeText(acc.wallet); toast(t('home.addressCopied')); }}>
            {shortAddr(acc.wallet, 6)}<Icon name="copy" size={13} />
          </button>
          {row('cash', <TokenIcon sm symbol="pUSD" icon={PUSD_ICON} />, 'pUSD', t('predict.map.cash'), n(b.pusd))}
          {inPositions > 0 && row('pos', <span class="mm-ic"><Icon name="predict" size={13} /></span>, t('predict.map.positionsTitle'), null, inPositions)}
        </div>
      )}
      <div class="mm-place">
        <div class="mm-head"><b>{t('predict.map.address')}</b>{!b.separate && <span class="mm-tag">{t(`predict.wtype.${walletType(acc)}`)}</span>}</div>
        <div class="mm-addr" title={acc.signer}>{shortAddr(acc.signer, 6)}</div>
        {!b.separate && row('cash', <TokenIcon sm symbol="pUSD" icon={PUSD_ICON} />, 'pUSD', t('predict.map.cash'), n(b.pusd))}
        {own.map(([sym, v, ic]) => row(sym, <TokenIcon sm symbol={sym} icon={ic} />, sym, b.separate ? t('predict.map.toDeposit') : t('predict.map.toConvert'), v))}
        {b.separate && !own.length && <div class="mm-empty">{t('predict.map.nothing')}</div>}
      </div>
      {canAct && (
        <ul class="mm-hints">
          {ownTotal > 0 && <li><Icon name="receive" size={15} /><span>{t(b.separate ? 'predict.map.hintDeposit' : 'predict.map.hintConvert', { v: usd(ownTotal) })}</span></li>}
          <li><Icon name="send" size={15} /><span>{t(b.separate ? 'predict.map.hintWithdraw' : 'predict.map.hintWithdrawDirect')}</span></li>
        </ul>
      )}
    </div>
  );
}

function PositionRow({ p, closed, onOpen, style, action }) {
  // history: the whole result of the position; open: the part still held, the same base as the percentage
  const pnl = closed ? (p.pnl ?? p.realized) : p.unrealized;
  const shares = (closed ? p.totalSize : p.size) || p.size;
  return (
    <button class="pm-pos" onClick={() => p.slug && onOpen(p.slug)} style={style}>
      <Img src={p.icon} size={42} />
      <span class="grow">
        <span class="pm-pos-title">{p.title}</span>
        <span class="pm-pos-sub">
          <span class={`pm-out ${/^(no|down)$/i.test(p.outcome) ? 'no' : 'yes'}`}>{outcomeName(p.outcome)}</span>
          <span>{t('predict.pos.shares', { n: shares.toLocaleString(locale(), { maximumFractionDigits: 2 }), avg: cents(p.avgPrice) })}</span>
        </span>
      </span>
      <span class="pm-pos-right">
        {closed ? <b class={tone(pnl)}>{signed(pnl)}</b> : <b>{usd(p.value)}</b>}
        {closed ? <small class={`pm-badge ${pnl > 0 ? 'won' : 'lost'}`}>{pnl > 0 ? t('predict.pos.won') : t('predict.pos.lost')}</small>
          : pnl != null && <small class={tone(pnl) || 'muted'}>{signed(pnl)}{p.pnlPct != null ? ` · ${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%` : ''}</small>}
        {!closed && p.redeemable && p.value > 0.005 && !action && <small class="pm-badge won">{t('predict.pos.won')}</small>}
        {action}
      </span>
    </button>
  );
}

const PNL_INTERVALS = ['1d', '1w', '1m', 'max'];
function PnlCard({ user, tick }) {
  const [interval, setIv] = useState('1m');
  const [pts, setPts] = useState(null);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    let alive = true; setPts(null); setHover(null);
    userPnl(user, interval).then((r) => alive && setPts(r)).catch(() => alive && setPts([]));
    return () => { alive = false; };
  }, [user, interval, tick]);
  // the series is cumulative: the chart shows the change since the start of the period
  const rel = useMemo(() => (pts?.length > 1 ? pts.map((x) => ({ t: x.t, p: x.p - pts[0].p })) : null), [pts]);
  const change = rel ? (hover ? hover.p : rel[rel.length - 1].p) : null;
  return (
    <div class="card pm-chart-card">
      <div class="pm-chart-title"><span>{t('predict.pnlTitle')}</span></div>
      <div class="pm-chart-head">
        <span class={`pm-chart-val ${tone(change)}`}>{change != null ? signed(change) : '–'}</span>
        <span class="pm-chart-sub"><small>{t(`predict.pnlPeriod.${interval}`)}</small></span>
      </div>
      {pts === null ? <div class="pm-chart pm-chart-sk"><span class="skeleton" /></div>
        : !rel ? <div class="pm-chart pm-chart-empty small muted">{t('predict.noPnl')}</div>
          : <LineChart kind="money" points={rel} onHover={setHover} label={t('predict.pnlTitle')} />}
      <div class="tabs pm-intervals">
        {PNL_INTERVALS.map((i) => <button class={`tab ${interval === i ? 'active' : ''}`} onClick={() => setIv(i)}>{t(`predict.int.${i}`)}</button>)}
      </div>
    </div>
  );
}
