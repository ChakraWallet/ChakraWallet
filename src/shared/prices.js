// USD prices from DefiLlama (free, no API key). In-memory cache of 60s.
import { ENDPOINTS } from './endpoints.js';
const cache = new Map(); // key -> {price, t}
const TTL = 60_000;

/** keys: ["coingecko:ethereum", "base:0xabc..."] -> {key: price} */
export async function getPrices(keys) {
  const out = {}, missing = [];
  const now = Date.now();
  for (const k of new Set(keys.filter(Boolean))) {
    const c = cache.get(k);
    if (c && now - c.t < TTL) out[k] = c.price; else missing.push(k);
  }
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    try {
      const res = await fetch(`${ENDPOINTS.llama}/prices/current/${chunk.join(',')}?searchWidth=6h`);
      const json = await res.json();
      for (const k of chunk) {
        const c = json.coins?.[k];
        // discard low-confidence prices (illiquid / manipulated pools)
        const p = c && (c.confidence === undefined || c.confidence >= 0.9) ? c.price ?? null : null;
        cache.set(k, { price: p, t: now });
        out[k] = p;
      }
    } catch {
      for (const k of chunk) out[k] = cache.get(k)?.price ?? null;
    }
  }
  return out;
}

export const tokenPriceKey = (chain, address) => (chain.llama ? `${chain.llama}:${address.toLowerCase()}` : null);

export async function getNativePrice(chain) {
  if (!chain.native.priceId) return null;
  return (await getPrices([chain.native.priceId]))[chain.native.priceId] ?? null;
}

// ------------------------------------------------------------ price history (token details chart)
/** Chart ranges: how far back, how many points, the step between them (DefiLlama periods). */
export const CHART_RANGES = {
  '1d': { secs: 86400, span: 48, period: '30m' },
  '1w': { secs: 7 * 86400, span: 84, period: '2h' },
  '1m': { secs: 30 * 86400, span: 60, period: '12h' },
  '1y': { secs: 365 * 86400, span: 73, period: '5d' },
};
const chartCache = new Map(); // `${key}|${range}` -> { t, points }

/** USD price history of a price key ("coingecko:ethereum", "base:0x…", "ton:EQ…"): [{ t (ms), p }], oldest first. */
export async function priceChart(key, range = '1w') {
  const r = CHART_RANGES[range];
  if (!key || !r) return [];
  const ck = `${key}|${range}`, hit = chartCache.get(ck);
  if (hit && Date.now() - hit.t < 5 * 60e3) return hit.points;
  const start = Math.floor(Date.now() / 1000) - r.secs;
  const res = await fetch(`${ENDPOINTS.llama}/chart/${encodeURIComponent(key)}?start=${start}&span=${r.span}&period=${r.period}&searchWidth=600`, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  const points = (json.coins?.[key]?.prices || []).map((x) => ({ t: x.timestamp * 1000, p: Number(x.price) })).filter((x) => isFinite(x.p)).sort((a, b) => a.t - b.t);
  chartCache.set(ck, { t: Date.now(), points });
  return points;
}
