// Demo network: every fetch() of the app is answered here with invented data (JSON-RPC, prices, Polymarket);
// anything else fails like an offline request. Loaded before the app.
import { PRICES, HOLDINGS, accountIndex } from './data.js';

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const hex = (n) => '0x' + BigInt(n).toString(16);
const GWEI = 1_000_000_000n;

// ---------------------------------------------------------------- JSON-RPC
async function rpcAnswer({ method, params = [] }) {
  switch (method) {
    case 'eth_chainId': return '0x1';
    case 'eth_blockNumber': return hex(21_874_512);
    case 'eth_getBlockByNumber': return { number: hex(21_874_512), baseFeePerGas: hex(6n * GWEI), timestamp: hex(Math.floor(Date.now() / 1000)) };
    case 'eth_feeHistory': return { baseFeePerGas: Array(6).fill(hex(6n * GWEI)), reward: Array(5).fill([hex(GWEI / 10n), hex(GWEI / 2n), hex(2n * GWEI)]) };
    case 'eth_maxPriorityFeePerGas': return hex(GWEI / 2n);
    case 'eth_gasPrice': return hex(7n * GWEI);
    case 'eth_estimateGas': return hex(21000);
    case 'eth_getTransactionCount': return hex(42);
    case 'eth_getCode': return '0x';
    case 'eth_getBalance': {
      const h = HOLDINGS[await accountIndex(params[0])]?.[1];
      return hex(BigInt(Math.round((h?.native || 0) * 1e8)) * 10n ** 10n);
    }
    case 'eth_call': return '0x' + '0'.repeat(64);
    default: throw Object.assign(new Error('unsupported'), { code: -32601 });
  }
}

// ---------------------------------------------------------------- Polymarket (invented markets)
const svg = (a, b, glyph) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="80" height="80" fill="url(#g)"/><text x="40" y="52" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text></svg>`);
const end = (days) => new Date(Date.now() + days * 864e5).toISOString();
let tokSeq = 1000;
const market = (q, yes, label = '', vol = 1e6, ch = 0.02) => ({
  id: String(++tokSeq), slug: `m-${tokSeq}`, question: q, groupItemTitle: label,
  outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(yes), String(+(1 - yes).toFixed(3))]),
  clobTokenIds: JSON.stringify([`9${tokSeq}1`, `9${tokSeq}2`]), volumeNum: vol, volume24hr: vol / 18, liquidityNum: vol / 9,
  oneDayPriceChange: ch, bestBid: yes - 0.005, bestAsk: yes + 0.005, lastTradePrice: yes, active: true, closed: false, acceptingOrders: true,
  endDate: end(40), description: 'Demo market for screenshots.',
});
const event = (id, title, image, tags, markets, days = 40) => ({
  id: String(id), slug: `demo-${id}`, title, image, endDate: end(days), closed: false,
  volume: markets.reduce((s, m) => s + m.volumeNum, 0), volume24hr: markets.reduce((s, m) => s + m.volume24hr, 0),
  liquidity: markets.reduce((s, m) => s + m.liquidityNum, 0), markets, tags: tags.map((t) => ({ slug: t.toLowerCase(), label: t })),
});
const EVENTS = [
  event(1, 'Bitcoin above $120k on December 31?', svg('#f7931a', '#b35c00', '₿'), ['Crypto'], [market('Bitcoin above $120k on December 31?', 0.34, '', 8.4e6, 0.03)], 48),
  event(2, 'ETH price at the end of the year', svg('#627eea', '#3346a8', 'Ξ'), ['Crypto'], [
    market('ETH above $4,000?', 0.41, '> $4,000', 3.1e6, 0.02), market('ETH above $3,500?', 0.63, '> $3,500', 2.2e6, 0.04), market('ETH above $5,000?', 0.12, '> $5,000', 1.4e6, -0.01),
  ], 48),
  event(3, 'Central bank cuts rates at the December meeting?', svg('#1f8a5b', '#0d4f33', '%'), ['Economy'], [market('Rate cut in December?', 0.72, '', 5.6e6, 0.05)], 33),
  event(4, 'Warmest year on record?', svg('#ef6c3a', '#a3361a', '°C'), ['World'], [market('Warmest year on record?', 0.81, '', 1.2e6, 0.01)], 50),
  event(5, 'New smartphone launch before March?', svg('#5b5bd6', '#2c2c8a', '◎'), ['Tech'], [market('Launch before March?', 0.27, '', 9.4e5, -0.03)], 110),
  event(6, 'Stablecoin market cap above $350B by June?', svg('#2775ca', '#163f6e', '$'), ['Finance'], [market('Above $350B by June?', 0.58, '', 7.7e5, 0.02)], 200),
];
function history(token) {
  const pts = [], now = Math.floor(Date.now() / 1000);
  let p = 0.3 + (Number(String(token).slice(-3)) % 40) / 100;
  for (let i = 168; i >= 0; i--) { p = Math.min(0.95, Math.max(0.05, p + Math.sin(i / 9 + p * 10) * 0.012)); pts.push({ t: now - i * 3600, p: +p.toFixed(3) }); }
  return { history: pts };
}

function polymarket(u) {
  const p = u.pathname;
  if (p === '/api/geoblock') return { blocked: false, country: 'IT' };
  if (p.startsWith('/events/keyset')) return { events: EVENTS, next_cursor: null };
  if (p.startsWith('/tags/slug/')) return { id: 1 };
  if (p.startsWith('/events/slug/')) return EVENTS.find((e) => e.slug === decodeURIComponent(p.slice(13))) || null;
  if (p.startsWith('/public-search')) return { events: EVENTS.slice(0, 3) };
  if (p.includes('prices-history')) return history(u.searchParams.get('market') || u.searchParams.get('token_id'));
  if (p.startsWith('/public-profile')) return null;
  if (p.includes('/positions')) return [];
  if (p.includes('/user-pnl')) return { points: [] };
  if (p.includes('/user-stats')) return { data: null };
  if (p === '/book') return { bids: [{ price: '0.33', size: '1200' }], asks: [{ price: '0.35', size: '900' }] };
  return null;
}

// ---------------------------------------------------------------- router
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url, location.href);
  if (u.origin === location.origin) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, 40));
  if (init.method === 'POST' && init.body && /rpc|publicnode|base\.org|arbitrum|optimism|llamarpc|cloudflare-eth|avax|gnosis|bnbchain|sepolia/.test(u.host + u.pathname)) {
    const body = JSON.parse(init.body);
    const one = async (r) => { try { return { jsonrpc: '2.0', id: r.id, result: await rpcAnswer(r) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code || -32000, message: e.message } }; } };
    return json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
  }
  if (u.host === 'coins.llama.fi') {
    const keys = decodeURIComponent(u.pathname.split('/').pop()).split(',');
    return json({ coins: Object.fromEntries(keys.filter((k) => PRICES[k]).map((k) => [k, { price: PRICES[k], confidence: 0.99 }])) });
  }
  if (u.host === 'api.frankfurter.dev') return json({ base: 'USD', rates: { EUR: 0.9213, GBP: 0.7841, CHF: 0.8822 } });
  if (/polymarket\.com$/.test(u.host)) {
    const r = polymarket(u);
    return r === null ? json({}, 404) : json(r);
  }
  throw new TypeError('Failed to fetch (demo: offline)');
};
// no live Polymarket prices in the demo
globalThis.WebSocket = class { constructor() { setTimeout(() => this.onerror?.(), 0); } send() {} close() {} };
