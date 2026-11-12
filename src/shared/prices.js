// USD prices from DefiLlama (free, no API key). In-memory cache of 60s.
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
      const res = await fetch(`https://coins.llama.fi/prices/current/${chunk.join(',')}?searchWidth=6h`);
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
