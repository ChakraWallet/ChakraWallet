// What an NFT is worth: the floor price of its collection (the cheapest one for sale), and how its price moved.
//   EVM - OpenSea with a key (any collection it lists: floor + sales for the chart), else CoinGecko without a key
//         (the larger collections, floor only).
//   TON - Getgems with a key (floor + sales); none without.
// OpenSea key: the user's own (Settings > Data), or one the app gets for them - OpenSea gives free keys at once, with
// no sign-up and nothing personal sent, valid 7 days - renewed before it expires (settings.nftHistory === 'auto').
// Every floor read is also kept on the device (one point every few hours): without sales data, that is the chart.
// Only contract / collection addresses are sent, never the owner's.
import { ENDPOINTS } from './endpoints.js';
import { getPrices } from './prices.js';
import { local } from './ext.js';

const OPENSEA_CHAINS = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'matic', 43114: 'avalanche' };
const COINGECKO_PLATFORMS = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum-one', 10: 'optimistic-ethereum', 137: 'polygon-pos', 43114: 'avalanche', 56: 'binance-smart-chain' };
const FLOOR_TTL = 30 * 60e3, MISS_TTL = 6 * 3600e3, LOG_EVERY = 4 * 3600e3, LOG_MAX = 500;
const RENEW_BEFORE = 24 * 3600e3; // renew the automatic key a day before it expires

const lc = (a) => String(a || '').toLowerCase();
/** The collection an NFT belongs to, as cache key: EVM contract (lower case), TON collection address. */
export const collectionKey = (chain, nft) => (chain.kind === 'ton' ? nft.contract : lc(nft.contract));
/** NFTs of the same collection share a price. */
export const nftValueKey = (chain, nft) => `${chain.id}:${collectionKey(chain, nft)}`;

async function req(url, { headers = {}, method = 'GET', timeout = 15000 } = {}) {
  const res = await fetch(url, { method, headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// ------------------------------------------------------------ OpenSea key
/** Is a stored automatic key still good (not expiring within `margin`)? */
export const autoKeyUsable = (a, now = Date.now(), margin = RENEW_BEFORE) => !!a?.key && Date.parse(a.expires) - now > margin;

let minting = null;
/** A new free OpenSea key (nothing is sent but the request itself); kept on the device. */
async function mintOpenseaKey(prev) {
  minting ??= (async () => {
    try {
      const j = await req(`${ENDPOINTS.opensea}/api/v2/auth/keys`, { method: 'POST' });
      if (!j?.api_key) throw new Error('no key');
      const v = { key: j.api_key, expires: j.expires_at || new Date(Date.now() + 7 * 86400e3).toISOString(), at: Date.now() };
      await local.set('openseaAuto', v);
      return v.key;
    } catch { return autoKeyUsable(prev, Date.now(), 0) ? prev.key : null; } finally { minting = null; }
  })();
  return minting;
}

/** The OpenSea key to use: the user's own, else (automatic mode) the app's, renewed when due; null = none. */
export async function openseaKey(settings = {}) {
  if (!ENDPOINTS.opensea) return null;
  if (settings.openseaKey?.trim()) return settings.openseaKey.trim();
  if (settings.nftHistory !== 'auto') return null;
  const a = await local.get('openseaAuto', null);
  return autoKeyUsable(a) ? a.key : mintOpenseaKey(a);
}
/** When the automatic key expires (ISO), or null. */
export const openseaAutoExpiry = async () => (await local.get('openseaAuto', null))?.expires || null;

/** OpenSea's collection slug of a contract (kept: it doesn't change). */
async function openseaSlug(chain, contract, key) {
  const ck = `osSlug:${chain.id}:${lc(contract)}`;
  const hit = await local.get(ck, undefined);
  if (hit !== undefined && (hit.slug || Date.now() - hit.at < MISS_TTL)) return hit.slug;
  const j = await req(`${ENDPOINTS.opensea}/api/v2/chain/${OPENSEA_CHAINS[chain.id]}/contract/${contract}`, { headers: { 'x-api-key': key } });
  const slug = j?.collection || null;
  await local.set(ck, { slug, at: Date.now() });
  return slug;
}

// ------------------------------------------------------------ parsers (pure: tested)
/** OpenSea /collections/:slug/stats -> { native, symbol } | null */
export function floorFromOpensea(j) {
  const f = Number(j?.total?.floor_price);
  return f > 0 ? { native: f, symbol: j.total.floor_price_symbol || 'ETH' } : null;
}
/** CoinGecko /nfts/:platform/contract/:address -> { native, symbol, usd } | null */
export function floorFromCoingecko(j) {
  const n = Number(j?.floor_price?.native_currency), u = Number(j?.floor_price?.usd);
  return n > 0 ? { native: n, symbol: String(j.native_currency_symbol || 'ETH').toUpperCase(), usd: u > 0 ? u : null } : null;
}
/** Getgems /v1/collection/stats -> { native, symbol } | null */
export function floorFromGetgems(j) {
  const f = Number(j?.response?.floorPrice ?? (j?.response?.floorPriceNano != null ? Number(j.response.floorPriceNano) / 1e9 : NaN));
  return f > 0 ? { native: f, symbol: 'GRAM' } : null;
}
const isEthLike = (s) => ['ETH', 'WETH'].includes(String(s).toUpperCase());
/** OpenSea sale events -> points [{ t (ms), p }] in the most common currency, oldest first; + that symbol. */
export function salesFromOpensea(events) {
  const sales = (events || []).filter((e) => e?.payment?.quantity && e.event_timestamp);
  const count = {};
  for (const e of sales) { const s = isEthLike(e.payment.symbol) ? 'ETH' : e.payment.symbol; count[s] = (count[s] || 0) + 1; }
  const symbol = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || 'ETH';
  const points = sales.filter((e) => (isEthLike(e.payment.symbol) ? 'ETH' : e.payment.symbol) === symbol)
    .map((e) => ({ t: Number(e.event_timestamp) * 1000, p: Number(e.payment.quantity) / 10 ** Number(e.payment.decimals ?? 18) / Math.max(1, Number(e.quantity || 1)) }))
    .filter((x) => x.p > 0).sort((a, b) => a.t - b.t);
  return { points, symbol };
}
/** Getgems history items (type sold) -> points [{ t (ms), p (GRAM) }], oldest first. */
export function salesFromGetgems(items) {
  return (items || []).filter((x) => x?.typeData?.type === 'sold' && (x.typeData.price != null || x.typeData.priceNano != null))
    .filter((x) => !x.typeData.currency || /^TON$/i.test(x.typeData.currency))
    .map((x) => ({ t: x.timestamp ? Number(x.timestamp) * (Number(x.timestamp) < 1e12 ? 1000 : 1) : Date.parse(x.time), p: x.typeData.price != null ? Number(x.typeData.price) : Number(x.typeData.priceNano) / 1e9 }))
    .filter((x) => x.p > 0 && x.t > 0).sort((a, b) => a.t - b.t);
}
/** Adds a floor reading to a device log: at most one every LOG_EVERY, LOG_MAX kept. */
export function addReading(log, r, every = LOG_EVERY) {
  const l = Array.isArray(log) ? log : [];
  const last = l[l.length - 1];
  if (last && r.t - last.t < every) return [...l.slice(0, -1), r]; // the latest reading of the period
  return [...l, r].slice(-LOG_MAX);
}

// ------------------------------------------------------------ floor price
/** USD price of the floor's currency (ETH, the network's coin, GRAM). */
async function unitUsd(chain, symbol) {
  const s = String(symbol).toUpperCase();
  const key = isEthLike(s) ? 'coingecko:ethereum'
    : s === String(chain.native.symbol).toUpperCase() || `W${chain.native.symbol}`.toUpperCase() === s || (s === 'GRAM' && chain.kind === 'ton') ? chain.native.priceId : null;
  if (!key) return null;
  return (await getPrices([key]))[key] ?? null;
}

/**
 * Floor price of the NFT's collection: { native, symbol, usd, source, at } | null (unknown with the keys at hand).
 * Cached on the device (30 min; "unknown" 6 h), and logged for the chart.
 */
export async function nftFloor(chain, nft, settings = {}) {
  const ck = collectionKey(chain, nft);
  const os = chain.kind !== 'ton' && OPENSEA_CHAINS[chain.id] ? await openseaKey(settings) : null;
  const gg = chain.kind === 'ton' && ENDPOINTS.getgems ? settings.getgemsKey?.trim() : null;
  const cacheKey = `nftFloor:${chain.id}:${ck}:${os ? 'os' : gg ? 'gg' : 'free'}`;
  const hit = await local.get(cacheKey, null);
  if (hit && Date.now() - hit.at < (hit.v ? FLOOR_TTL : MISS_TTL)) return hit.v;
  let v = null;
  try {
    if (chain.kind === 'ton') {
      if (gg) v = floorFromGetgems(await req(`${ENDPOINTS.getgems}/v1/collection/stats/${ck}`, { headers: { authorization: gg } }));
      if (v) v.source = 'getgems';
    } else {
      if (os) {
        const slug = await openseaSlug(chain, ck, os);
        if (slug) v = floorFromOpensea(await req(`${ENDPOINTS.opensea}/api/v2/collections/${slug}/stats`, { headers: { 'x-api-key': os } }));
        if (v) v.source = 'opensea';
      }
      if (!v && COINGECKO_PLATFORMS[chain.id] && ENDPOINTS.coingecko) {
        v = floorFromCoingecko(await req(`${ENDPOINTS.coingecko}/api/v3/nfts/${COINGECKO_PLATFORMS[chain.id]}/contract/${ck}`));
        if (v) v.source = 'coingecko';
      }
    }
    if (v) {
      if (v.usd == null) { const u = await unitUsd(chain, v.symbol); v.usd = u != null ? v.native * u : null; }
      v.at = Date.now();
      await local.update(`nftLog:${chain.id}:${ck}`, [], (l) => addReading(l, { t: v.at, p: v.native, usd: v.usd, symbol: v.symbol }));
    }
  } catch (e) {
    if (e.status === 429 || !e.status) return hit?.v ?? null; // busy or offline: try again later, keep what we had
  }
  await local.set(cacheKey, { v, at: Date.now() });
  return v;
}

// ------------------------------------------------------------ price history
/** Floor readings kept by this device: [{ t, p, usd, symbol }]. */
export const floorLog = (chain, nft) => local.get(`nftLog:${chain.id}:${collectionKey(chain, nft)}`, []);

/** Can sales be read with the keys at hand? 'opensea' | 'getgems' | null */
export function salesSource(chain, settings = {}) {
  if (chain.kind === 'ton') return ENDPOINTS.getgems && settings.getgemsKey?.trim() ? 'getgems' : null;
  if (!OPENSEA_CHAINS[chain.id] || !ENDPOINTS.opensea) return null;
  return settings.openseaKey?.trim() || settings.nftHistory === 'auto' ? 'opensea' : null;
}

/** Sales of the NFT's collection over the last `days`: { points: [{ t, p }], symbol, source } | null (no source). */
export async function nftSales(chain, nft, settings = {}, days = 90) {
  const source = salesSource(chain, settings);
  if (!source) return null;
  const ck = collectionKey(chain, nft), after = Math.floor(Date.now() / 1000) - days * 86400;
  if (source === 'getgems') {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 4; page++) {
      const q = new URLSearchParams({ types: 'sold', minTime: String(after), limit: '100', ...(cursor ? { after: cursor } : {}) });
      const j = await req(`${ENDPOINTS.getgems}/v1/collection/history/${ck}?${q}`, { headers: { authorization: settings.getgemsKey.trim() } });
      items.push(...(j?.response?.items || []));
      cursor = j?.response?.cursor;
      if (!cursor) break;
    }
    return { points: salesFromGetgems(items), symbol: 'GRAM', source };
  }
  const key = await openseaKey(settings);
  if (!key) return null;
  const slug = await openseaSlug(chain, ck, key);
  if (!slug) return { points: [], symbol: chain.native.symbol, source };
  const events = [];
  let next = null;
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ event_type: 'sale', after: String(after), limit: '200', ...(next ? { next } : {}) });
    const j = await req(`${ENDPOINTS.opensea}/api/v2/events/collection/${slug}?${q}`, { headers: { 'x-api-key': key } });
    events.push(...(j?.asset_events || []));
    next = j?.next;
    if (!next) break;
  }
  return { ...salesFromOpensea(events), source };
}
