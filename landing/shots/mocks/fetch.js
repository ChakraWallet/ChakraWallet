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

// ---------------------------------------------------------------- price history (token details chart)
function llamaChart(u) {
  const key = decodeURIComponent(u.pathname.split('/').pop());
  const TOKENS = { '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 97240.15, '0x514910771af9ca656af840dff83e8264ecf986ca': 18.42, '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 11.37 };
  const base = PRICES[key] ?? TOKENS[key.split(':').pop().toLowerCase()] ?? (/0xa0b8|0x833589|0xaf88|0x3c499|0xdac17|0x6b1754|B113A994|EQCxE6/i.test(key) ? 1 : 18.4);
  const span = Number(u.searchParams.get('span') || 60), start = Number(u.searchParams.get('start')), now = Date.now() / 1000;
  const prices = Array.from({ length: span }, (_, i) => {
    const x = i / (span - 1), stable = base === 1;
    const wave = stable ? Math.sin(x * 9) * 0.0004 + Math.sin(x * 23) * 0.0002 : Math.sin(x * 5.2) * 0.045 + Math.sin(x * 13) * 0.018 + (x - 0.6) * 0.06;
    return { timestamp: Math.round(start + (now - start) * x), price: base * (1 + wave) };
  });
  return { coins: { [key]: { prices } } };
}

// ---------------------------------------------------------------- TON (invented wallet: GRAM, USD₮, NOT)
const USDT_TON = '0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE';
const NOT_TON = '0:2F956143C461769579BAEF2E32CC2D7BC18283F40D20BB03E432CD603AC33FFC';
const TON_META = {
  [USDT_TON]: { symbol: 'USD₮', name: 'Tether USD', decimals: 6, image: 'https://assets.coingecko.com/coins/images/325/small/Tether.png', price: 1.0002 },
  [NOT_TON]: { symbol: 'NOT', name: 'Notcoin', decimals: 9, image: null, price: 0.0021 },
};
const PEER_TON = 'UQBvW8Z5juBkMJY8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw-';
function toncenter(u) {
  const p = u.pathname, me = u.searchParams.get('account') || u.searchParams.get('address') || u.searchParams.get('owner_address');
  if (p === '/api/v3/walletInformation') return { balance: '184250000000', status: 'active', seqno: 12, wallet_type: 'wallet v4 r2' };
  if (p === '/api/v3/addressInformation') return { status: 'active', balance: '0' };
  if (p === '/api/v3/jetton/wallets') return { jetton_wallets: [
    { address: '0:' + '1'.repeat(64), jetton: USDT_TON, balance: '612450000' },
    { address: '0:' + '2'.repeat(64), jetton: NOT_TON, balance: '48000000000000' },
  ] };
  if (p === '/api/v3/metadata') {
    return Object.fromEntries(u.searchParams.getAll('address').map((a) => [a, { token_info: [{ type: 'jetton_masters', symbol: TON_META[a]?.symbol, name: TON_META[a]?.name, image: TON_META[a]?.image, extra: { decimals: String(TON_META[a]?.decimals ?? 9) } }] }]));
  }
  if (p === '/api/v3/actions') {
    const now = Math.floor(Date.now() / 1000) - 2 * 86400;
    const meta = Object.fromEntries(Object.entries(TON_META).map(([k, v]) => [k, { token_info: [{ type: 'jetton_masters', symbol: v.symbol, image: v.image, extra: { decimals: String(v.decimals) } }] }]));
    const act = (i, type, details, t) => ({ action_id: `a${i}`, trace_id: `t${i}`, type, success: true, start_utime: String(now - t), transactions: [btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, k) => (k * 7 + i * 31) % 256)))], details });
    return { address_book: {}, metadata: meta, next_cursor: null, actions: [
      act(1, 'jetton_swap', { dex: 'stonfi', asset_in: null, asset_out: USDT_TON, dex_incoming_transfer: { amount: '20000000000' }, dex_outgoing_transfer: { amount: '62310000' } }, 3600),
      act(2, 'ton_transfer', { source: PEER_TON, destination: me, value: '45000000000', comment: 'Thanks for dinner!' }, 5 * 3600),
      act(3, 'jetton_transfer', { sender: me, receiver: PEER_TON, asset: USDT_TON, amount: '150000000' }, 30 * 3600),
      act(4, 'jetton_transfer', { sender: PEER_TON, receiver: me, asset: NOT_TON, amount: '48000000000000' }, 50 * 3600),
      act(5, 'ton_transfer', { source: me, destination: PEER_TON, value: '12500000000' }, 72 * 3600),
    ] };
  }
  if (p === '/api/v3/traces') return { traces: [] };
  if (p === '/api/v3/estimateFee') return { source_fees: { in_fwd_fee: '1500000', storage_fee: '120000', gas_fee: '2900000', fwd_fee: '400000' }, destination_fees: [] };
  return null;
}
function ston(u) {
  const id = decodeURIComponent(u.pathname.split('/').pop());
  const raw = id === 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' ? USDT_TON : id === 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT' ? NOT_TON : null;
  const m = TON_META[raw];
  return m ? { asset: { dex_usd_price: String(m.price), image_url: m.image, symbol: m.symbol, display_name: m.name, decimals: m.decimals } } : null;
}

// ---------------------------------------------------------------- router
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input); // a string or a URL object
  const u = new URL(url, location.href);
  if (u.origin === location.origin) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, 40));
  if (init.method === 'POST' && init.body && /rpc|publicnode|base\.org|arbitrum|optimism|llamarpc|cloudflare-eth|avax|gnosis|bnbchain|sepolia/.test(u.host + u.pathname)) {
    const body = JSON.parse(init.body);
    const one = async (r) => { try { return { jsonrpc: '2.0', id: r.id, result: await rpcAnswer(r) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code || -32000, message: e.message } }; } };
    return json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
  }
  if (u.host === 'coins.llama.fi' && u.pathname.startsWith('/chart/')) return json(llamaChart(u));
  if (u.host === 'api.relay.link' && u.pathname === '/quote') { // TON <-> EVM route (GRAM): an invented quote
    const b = JSON.parse(init.body), amt = BigInt(b.amount), TON = 224235520, fromTon = b.originChainId === TON;
    // GRAM ($3.108) <-> ETH ($3,412.58); between two EVM networks the same coin, minus 0.2%
    const out = fromTon ? (amt * 3108n * 10n ** 9n) / 3412580n : b.destinationChainId === TON ? (amt * 3412580n) / (3108n * 10n ** 9n) : (amt * 998n) / 1000n;
    const data = fromTon ? { messages: [{ to: 'EQ' + 'A'.repeat(46), value: String(amt + 30000000n), bounce: true, mode: 1 }] } : { to: '0x' + 'a5'.repeat(20), data: '0x', value: String(amt) };
    return json({ steps: [{ id: 'deposit', kind: 'transaction', requestId: '0xr1', items: [{ data }] }],
      details: { timeEstimate: 25, currencyOut: { amount: String(out), minimumAmount: String((out * 99n) / 100n), amountUsd: fromTon ? String(Number(amt) / 1e9 * 3.108) : null } },
      fees: { relayer: { amountUsd: '0.21' }, gas: { amountUsd: '0.04' } } });
  }
  if (u.host === 'toncenter.com') { const r = toncenter(u); return r ? json(r) : json({ error: 'not found' }, 404); }
  if (u.host === 'api.ston.fi') { const r = ston(u); return r ? json(r) : json({}, 404); }
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
// WebSockets: Omniston (TON swaps) answers with an invented quote; the rest (live Polymarket prices) fails
globalThis.WebSocket = class {
  constructor(url) {
    this.omni = String(url).includes('omni-ws.ston.fi');
    setTimeout(() => (this.omni ? this.onopen?.() : this.onerror?.()), 30);
  }
  send(text) {
    if (!this.omni) return;
    const m = JSON.parse(text);
    if (!/QuoteRpc\.Quote$/.test(m.method)) return;
    const reply = (x) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(x) }), 120);
    reply({ jsonrpc: '2.0', id: m.id, result: 7 });
    const units = BigInt(m.params.input_units);
    const native = !!m.params.input_asset.ton?.native;
    const out = native ? (units * 3118n) / 1000000n : (units * 1000000000n) / 3132000n; // GRAM <-> USD₮ around $3.12
    reply({ jsonrpc: '2.0', method: 'event', params: { result: { quote_updated: { quote: {
      quote_id: 'q1', input_units: String(units), output_units: String(out), gas_budget: '180000000', resolver_name: 'Omniston',
      swap: { min_output_amount: String((out * 99n) / 100n), price_impact_pips: 1800, routes: [{ steps: [{ chunks: [{ protocol: 'StonFiV2' }, { protocol: 'DeDust' }] }] }] },
    } } } } });
  }
  close() {}
};
