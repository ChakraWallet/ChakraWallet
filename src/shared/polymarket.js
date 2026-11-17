// Polymarket, read-only (phase 1): region check, markets (Gamma), price history, live prices (CLOB websocket),
// positions of an address (Data API). Public endpoints, no account and no keys.
// Amounts are USD (Polymarket's pUSD is 1:1 with USD); prices are 0..1 (= probability, shown in ¢ / %).
import { getJson } from './http.js';

const SITE = 'https://polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export const MARKET_URL = (slug) => `${SITE}/event/${slug}`;
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const list = (r) => (Array.isArray(r) ? r : r?.items || r?.data || r?.events || r?.markets || []);
const arr = (v) => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ------------------------------------------------------------ region
/**
 * 'ok' | 'blocked' | 'unreachable'. Unreachable = no answer at all: offline, or a network that blocks
 * Polymarket's domains (some countries do it by DNS, so the request fails instead of answering "blocked").
 */
export async function regionStatus() {
  try {
    const r = await getJson(`${SITE}/api/geoblock`, { timeout: 10000, label: 'Polymarket' });
    if (!r) return { state: 'unreachable' };
    return { state: r.blocked ? 'blocked' : 'ok', country: r.country || '' };
  } catch (e) {
    return { state: 'unreachable', error: e?.message || String(e) };
  }
}

// ------------------------------------------------------------ markets
export function normMarket(m) {
  const outcomes = arr(m.outcomes), prices = arr(m.outcomePrices).map(Number), tokens = arr(m.clobTokenIds);
  return {
    id: String(m.id), slug: m.slug, question: m.question || m.title || '', label: m.groupItemTitle || '',
    image: m.image || m.icon || '', conditionId: m.conditionId,
    outcomes: outcomes.map((name, i) => ({ name, price: prices[i] ?? null, token: tokens[i] || null })),
    closed: !!m.closed, active: m.active !== false, acceptingOrders: m.acceptingOrders !== false,
    endDate: m.endDate || m.endDateIso || null, description: m.description || '', resolutionSource: m.resolutionSource || '',
    volume: num(m.volumeNum ?? m.volume), volume24h: num(m.volume24hr), liquidity: num(m.liquidityNum ?? m.liquidity),
    change24h: num(m.oneDayPriceChange), bestBid: num(m.bestBid), bestAsk: num(m.bestAsk), last: num(m.lastTradePrice),
    negRisk: !!m.negRisk,
    // taker fee per share = rate × (p(1−p))^exponent (Gamma "feeSchedule"); null when the market has no fee
    fee: m.feesEnabled && m.feeSchedule ? { rate: Number(m.feeSchedule.rate) || 0, exponent: Number(m.feeSchedule.exponent) || 1 } : null,
  };
}
/** Probability of the first outcome ("Yes"): last price / midpoint, else the listed price. */
export const yesPrice = (m) => m.outcomes[0]?.price ?? m.last ?? null;

export function normEvent(e) {
  const markets = (e.markets || []).map(normMarket);
  // grouped events (e.g. "Who will win?"): open markets first, most likely first
  const open = markets.filter((m) => !m.closed);
  const sorted = [...(open.length ? open : markets)].sort((a, b) => (yesPrice(b) ?? 0) - (yesPrice(a) ?? 0));
  return {
    id: String(e.id), slug: e.slug, title: e.title || markets[0]?.question || '', image: e.image || e.icon || markets[0]?.image || '',
    description: e.description || markets[0]?.description || '', resolutionSource: e.resolutionSource || markets[0]?.resolutionSource || '',
    endDate: e.endDate || markets[0]?.endDate || null, closed: !!e.closed,
    volume: num(e.volume) ?? markets.reduce((s, m) => s + (m.volume || 0), 0), volume24h: num(e.volume24hr), liquidity: num(e.liquidity),
    markets: sorted, binary: markets.length === 1,
    tags: (e.tags || []).filter((t) => t.slug || t.label).map((t) => t.label || t.slug),
    tagSlugs: (e.tags || []).filter((t) => t.slug || t.label).map((t) => String(t.slug || t.label).toLowerCase()), // same order as tags
  };
}

/**
 * Events for the "Per te" feed, one page at a time: { events, next }. For now the trending ones; this is the one
 * place to change for personalised suggestions (e.g. from the user's history), the feed UI only calls this.
 */
export function suggestions({ cursor } = {}) {
  return listEvents({ category: 'trending', cursor });
}

/** Categories: Polymarket tag slugs, resolved to ids once. */
export const CATEGORIES = ['trending', 'new', 'politics', 'sports', 'crypto', 'finance', 'geopolitics', 'tech', 'pop-culture', 'world', 'economy'];
const tagIds = {};
async function tagId(slug) {
  if (slug in tagIds) return tagIds[slug];
  const t = await getJson(`${GAMMA}/tags/slug/${slug}`, { label: 'Polymarket' }).catch(() => null);
  return (tagIds[slug] = t?.id ?? null);
}

/** One page of open events for a category: { events, next } (next = cursor for the following page). */
export async function listEvents({ category = 'trending', cursor, limit = 20 } = {}) {
  const p = { limit, closed: false, active: true, archived: false, after_cursor: cursor }; // the cursor only works with the same query
  if (category === 'new') Object.assign(p, { order: 'startDate', ascending: false });
  else Object.assign(p, { order: 'volume24hr', ascending: false });
  if (!['trending', 'new'].includes(category)) {
    const id = await tagId(category);
    if (id == null) return { events: [], next: null };
    p.tag_id = id;
  }
  const r = await getJson(`${GAMMA}/events/keyset?${qs(p)}`, { label: 'Polymarket' });
  const events = list(r).map(normEvent).filter((e) => e.markets.length);
  return { events, next: r?.next_cursor || r?.nextCursor || null };
}

export async function searchEvents(q) {
  const r = await getJson(`${GAMMA}/public-search?${qs({ q, limit_per_type: 20, events_status: 'active' })}`, { label: 'Polymarket' });
  return (r?.events || []).map(normEvent).filter((e) => e.markets.length);
}

export async function getEvent(slug) {
  const r = await getJson(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`, { label: 'Polymarket' });
  return r ? normEvent(r) : null;
}

// ------------------------------------------------------------ price history
export const INTERVALS = ['1d', '1w', '1m', 'max'];
const FIDELITY = { '1d': 10, '1w': 60, '1m': 240, max: 1440 }; // minutes per point
/** [{ t (ms), p (0..1) }] for one outcome token. */
export async function priceHistory(token, interval = '1w') {
  const norm = (r) => (Array.isArray(r) ? r : r?.history || r?.data || r?.items || []).map((x) => ({ t: Number(x.t ?? x.timestamp) * (Number(x.t ?? x.timestamp) < 1e12 ? 1000 : 1), p: Number(x.p ?? x.price) })).filter((x) => isFinite(x.t) && isFinite(x.p));
  try {
    const r = norm(await getJson(`${CLOB}/prices-history?${qs({ market: token, interval, fidelity: FIDELITY[interval] })}`, { label: 'Polymarket' }));
    if (r.length) return r;
  } catch { /* try the newer endpoint */ }
  return norm(await getJson(`${DATA}/v2/prices-history?${qs({ token_id: token, interval: interval === '1d' ? '1d' : interval === '1w' ? '1w' : interval === '1m' ? '1m' : 'max' })}`, { label: 'Polymarket' }));
}

// ------------------------------------------------------------ live prices
/**
 * Live midpoint / last-trade updates for some outcome tokens. onPrice(token, price). Returns stop().
 * Reconnects with backoff; keep-alive "PING" every 10 s.
 */
export function watchPrices(tokens, onPrice) {
  let ws = null, stopped = false, ping = 0, retry = 0, timer = 0;
  const ids = [...new Set(tokens.filter(Boolean))];
  if (!ids.length || typeof WebSocket === 'undefined') return () => {};
  const handle = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.event_type === 'price_change' || m.price_changes) {
      for (const c of m.price_changes || m.changes || []) {
        const id = c.asset_id || m.asset_id, bid = num(c.best_bid), ask = num(c.best_ask);
        if (id && bid != null && ask != null && ask - bid <= 0.1) onPrice(id, (bid + ask) / 2);
      }
    } else if (m.event_type === 'last_trade_price' && m.asset_id && m.price != null) onPrice(m.asset_id, Number(m.price));
    else if (m.event_type === 'book' && m.asset_id) {
      const bid = Math.max(...(m.bids || []).map((x) => Number(x.price)), 0), ask = Math.min(...(m.asks || []).map((x) => Number(x.price)), 1);
      if (bid > 0 && ask < 1 && ask - bid <= 0.1) onPrice(m.asset_id, (bid + ask) / 2);
    }
  };
  const open = () => {
    if (stopped) return;
    try { ws = new WebSocket(WS); } catch { return; }
    ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ type: 'market', assets_ids: ids })); ping = setInterval(() => { try { ws.send('PING'); } catch { /* closing */ } }, 10000); };
    ws.onmessage = (ev) => { if (ev.data === 'PONG') return; try { const d = JSON.parse(ev.data); (Array.isArray(d) ? d : [d]).forEach(handle); } catch { /* not json */ } };
    ws.onclose = () => { clearInterval(ping); if (!stopped) timer = setTimeout(open, Math.min(30000, 1000 * 2 ** retry++)); };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  };
  open();
  return () => { stopped = true; clearInterval(ping); clearTimeout(timer); try { ws?.close(); } catch { /* ignore */ } };
}

// ------------------------------------------------------------ portfolio (read-only)
/** The Polymarket account of an address: users of polymarket.com hold positions in a proxy wallet. */
/** Proxy wallet (polymarket.com account) of an address, or null; throws if Polymarket doesn't answer. */
async function proxyOf(address) {
  const prof = await getJson(`${GAMMA}/public-profile?${qs({ address })}`, { label: 'Polymarket' });
  return prof?.proxyWallet?.toLowerCase() || null;
}
export async function accountsOf(address) {
  const own = address.toLowerCase();
  const proxy = await proxyOf(address).catch(() => null);
  return [...new Set([own, proxy].filter(Boolean))];
}

export function normPosition(p) {
  const pick = (...k) => { for (const x of k) if (p[x] !== undefined && p[x] !== null) return p[x]; return null; };
  return {
    token: String(pick('token_id', 'asset', 'tokenId') ?? ''), conditionId: pick('condition_id', 'conditionId'),
    title: pick('title') || '', icon: pick('icon') || '', slug: pick('event_slug', 'eventSlug', 'slug') || '', outcome: pick('outcome') || '',
    size: num(pick('current_size', 'size')) || 0, avgPrice: num(pick('avg_price', 'avgPrice')), price: num(pick('current_price', 'curPrice')),
    // pnl: whole result of the position (trades included); unrealized: what is still held, the base of pnlPct
    value: num(pick('current_value', 'currentValue')) || 0, pnl: num(pick('total_pnl', 'cashPnl', 'unrealized_pnl')),
    unrealized: num(pick('unrealized_pnl', 'cashPnl')),
    pnlPct: num(pick('percent_pnl', 'percentPnl')), realized: num(pick('realized_pnl', 'realizedPnl')),
    redeemable: !!pick('redeemable'), endDate: pick('end_date', 'endDate'), lastAt: num(pick('last_event_at')),
    totalSize: num(pick('total_size')), cost: num(pick('total_cost_usdc', 'initialValue')), negRisk: !!pick('negative_risk', 'negativeRisk'),
  };
}

/**
 * status: OPEN | REDEEMABLE | CLOSED. Positions of every account of the address.
 * OPEN also returns the positions of resolved markets until they are redeemed (the losing ones stay there for good).
 * Resolved and closed ones come newest first (by default Polymarket sorts them by profit).
 */
export async function positions(address, status = 'OPEN') {
  const accounts = await accountsOf(address);
  const sort_by = status === 'OPEN' ? undefined : 'TIMESTAMP';
  const pages = await Promise.all(accounts.map((user) => getJson(`${DATA}/v2/positions?${qs({ user, status, sort_by, limit: 100 })}`, { label: 'Polymarket' })
    .catch(() => [])));
  return pages.flatMap(list).map(normPosition).filter((p) => p.size > 0 || status === 'CLOSED');
}

/**
 * Strict reading for the wallet's totals: { proxy: the separate Polymarket account or null, value: open positions
 * of the address and of that account }. Throws as soon as one request fails: never a partial figure.
 */
export async function openValueOf(address) {
  const own = address.toLowerCase();
  const proxy = await proxyOf(address);
  const users = [...new Set([own, proxy].filter(Boolean))];
  const pages = await Promise.all(users.map((user) => getJson(`${DATA}/v2/positions?${qs({ user, status: 'OPEN', limit: 100 })}`, { label: 'Polymarket' })));
  const value = pages.flatMap(list).map(normPosition).filter((p) => p.size > 0).reduce((s, p) => s + p.value, 0);
  return { proxy: proxy && proxy !== own ? proxy : null, value };
}

/** Main Polymarket account of an address: its proxy wallet when it has one (polymarket.com users), else itself. */
export async function mainAccount(address) {
  const a = await accountsOf(address);
  return a[a.length - 1];
}

const PNL_FIDELITY = { '1d': '1h', '1w': '3h', '1m': '12h', max: '1d' };
/** Cumulative profit/loss over time: [{ t (ms), p (USD) }]. */
export async function userPnl(user, interval = '1m') {
  const r = await getJson(`${DATA}/v2/user-pnl?${qs({ user, interval, fidelity: PNL_FIDELITY[interval] })}`, { label: 'Polymarket' });
  const pts = r?.data?.points || r?.points || [];
  return pts.map((x) => {
    const v = x.economic_pnl ?? ((Number(x.realized_pnl) || 0) + (Number(x.unrealized_pnl) || 0));
    return { t: Number(x.timestamp) * (Number(x.timestamp) < 1e12 ? 1000 : 1), p: Number(v) };
  }).filter((x) => isFinite(x.t) && isFinite(x.p));
}

/**
 * { trades, biggestWin, joined (ms), pnl, income }. income: all-time totals credited by Polymarket, maker and taker
 * rebates kept apart: { maker, taker, rewards, referral, yield, fees (paid: refunds minus charges, ≤ 0) }; a null
 * field = not covered by Polymarket's books (not zero).
 */
export async function userStats(user) {
  const r = await getJson(`${DATA}/v2/user-stats?${qs({ user })}`, { label: 'Polymarket' });
  const d = r && typeof r === 'object' && 'data' in r ? r.data : r; // { data: null }: no stats yet (new account)
  if (!d) return null;
  const a = d.all_time_pnl;
  return {
    trades: num(d.trades), biggestWin: num(d.biggest_win), joined: d.join_date ? Number(d.join_date) * 1000 : null,
    pnl: a ? Number(a.economic_pnl ?? ((Number(a.realized_pnl) || 0) + (Number(a.unrealized_pnl) || 0))) : null,
    income: a ? {
      maker: num(a.maker_rebate), taker: num(a.taker_rebate), rewards: num(a.reward_income), referral: num(a.referral_income),
      yield: num(a.yield_income), fees: num(a.fees_paid),
    } : null,
  };
}

// ------------------------------------------------------------ activity (history)
/** Activity kinds as Polymarket names them, for the history filters. Rebates and rewards are paid in pUSD. */
export const INCOME_TYPES = ['MAKER_REBATE', 'TAKER_REBATE', 'REWARD', 'REFERRAL_REWARD', 'YIELD'];
export const TRADE_TYPES = ['TRADE', 'REDEEM', 'SPLIT', 'MERGE', 'CONVERSION'];
const CASH_OUT = ['SPLIT', 'DIRECTIONAL_SPLIT', 'WITHDRAWAL']; // cash leaves the account (and a buy)
const NO_CASH = ['CONVERSION', 'MIGRATION', 'THRESHOLD_COMPOSE', 'THRESHOLD_DECOMPOSE']; // positions only

/**
 * One activity row: { type, side, at (ms), usd (≥ 0), flow (+1 cash in, −1 cash out, 0 none), market (condition id), shares, price,
 * title, icon, slug, outcome, tx, income }. Rebates and rewards come without a market (empty title).
 */
export function normActivity(a) {
  const type = String(a.type || '').toUpperCase(), side = String(a.side || '').toUpperCase();
  const ts = Number(a.timestamp) || 0;
  return {
    type, side, at: ts < 1e12 ? ts * 1000 : ts, usd: Math.abs(Number(a.usdc_size ?? a.usdcSize) || 0),
    flow: type === 'TRADE' ? (side === 'BUY' ? -1 : 1) : CASH_OUT.includes(type) ? -1 : NO_CASH.includes(type) ? 0 : 1,
    market: a.condition_id || a.conditionId || '', shares: num(a.size), price: num(a.price) || null, title: a.title || '', icon: a.icon || '',
    slug: a.event_slug || a.eventSlug || a.slug || '', outcome: a.outcome || '', tx: a.transaction_hash || a.transactionHash || '',
    income: INCOME_TYPES.includes(type),
  };
}

/**
 * One page of an account's activity, newest first: { rows, next (cursor for the following page, or null) }.
 * filter: 'all' (deposits and withdrawals included) | 'trades' | 'income' (rebates and rewards).
 */
export async function activity(user, { filter = 'all', cursor, limit = 50 } = {}) {
  const type = filter === 'trades' ? TRADE_TYPES.join(',') : filter === 'income' ? INCOME_TYPES.join(',') : undefined;
  const r = await getJson(`${DATA}/v2/activity?${qs({
    user, type, cursor, limit, start: 1, exclude_deposits_withdrawals: filter === 'all' ? false : undefined,
  })}`, { label: 'Polymarket' });
  const p = r?.pagination;
  return { rows: list(r).map(normActivity), next: p?.has_more && p.next_cursor ? p.next_cursor : null };
}

// ------------------------------------------------------------ rebate tiers
// Two separate ladders, each on its own 30-day weighted volume: taker fills count only for the taker tier, maker
// fills only for the maker tier. Polymarket changes both on 20 Nov 2026 at 23:59 UTC (docs.polymarket.com,
// fee-and-rebate-changes-november-2026): Bronze and Silver go, new rates, maker tiers replace the daily pools.
export const TIER_SWITCH = Date.UTC(2026, 10, 20, 23, 59);
const TIERS = {
  takerOld: [['None', 0, 0], ['Bronze', 2e3, 3], ['Silver', 2e4, 8], ['Gold', 2e5, 18], ['Platinum', 1e6, 32], ['Diamond', 4e6, 44], ['Obsidian', 1e7, 50]],
  taker: [['None', 0, 0], ['Gold', 2e5, 10], ['Platinum', 1e6, 25], ['Diamond', 4e6, 40], ['Obsidian', 1e7, 50], ['Onyx', 75e6, 60]],
  maker: [['None', 0, 0], ['Tier 1', 2e5, 3], ['Tier 2', 1e6, 7], ['Tier 3', 4e6, 10], ['Tier 4', 1e7, 15]],
};
/** The ladder in force: kind 'taker' | 'maker' -> [{ name, min (weighted volume), rate (%) }] (no maker ladder before the switch). */
export function tierTable(kind, now = Date.now()) {
  const rows = kind === 'maker' ? (now < TIER_SWITCH ? null : TIERS.maker) : now < TIER_SWITCH ? TIERS.takerOld : TIERS.taker;
  return rows ? rows.map(([name, min, rate]) => ({ name, min, rate })) : null;
}

/**
 * Where an account stands on a ladder: { name, none, rate (% or null), volume, next: { name, min, rate } | null }.
 * The tier is Polymarket's (its name decides, the volume may lag a day); the table only adds the rate and the next
 * step. A name the table doesn't know (a tier added later) is shown as it is, without a rate.
 */
export function placeInTiers(table, { name, volume }) {
  const rows = table || [];
  const n = String(name || '').trim().toLowerCase();
  let i = rows.findIndex((x) => x.name.toLowerCase() === n);
  if (i < 0 && rows.length && (!n || n === 'none' || n === 'tier 0')) i = 0;
  const known = i >= 0 ? rows[i] : null;
  const v = Number(volume) || 0;
  const next = rows.find((x, j) => (known ? j > i : x.min > v)) || null;
  return { name: known ? known.name : String(name || ''), none: i === 0, rate: known ? known.rate : null, volume: num(volume), next };
}

/** Rebate tiers of an address, from its public profile: { taker: { name, volume } | null, maker: … | null } or null. */
export async function rebateTiers(address) {
  const p = await getJson(`${GAMMA}/public-profile?${qs({ address })}`, { label: 'Polymarket' });
  if (!p) return null;
  const tier = (name, level, volume) => (name == null && level == null ? null : { name: name ?? `Tier ${level}`, volume: num(volume) });
  return {
    taker: tier(p.takerTierName, p.takerTier, p.takerWeightedVolume ?? p.weightedVolume),
    // not published yet: maker tiers start on 20 Nov 2026; read under the names the taker fields suggest
    maker: tier(p.makerTierName, p.makerTier, p.makerWeightedVolume),
  };
}
