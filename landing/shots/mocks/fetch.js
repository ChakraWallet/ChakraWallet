// Demo network: every fetch() of the app is answered here with invented data (JSON-RPC, prices, Polymarket);
// anything else fails like an offline request. Loaded before the app.
import { Interface, Mnemonic } from 'ethers';
import { sha256 } from '@noble/hashes/sha256';
import { seedOfPhrase, hdAccountPublic, branchAddress } from '../../../src/shared/btc/keys.js';
import { PRICES, HOLDINGS, CARD, accountIndex } from './data.js';
import { MULTICALL3 } from '../../../src/shared/rpc.js';

// Linea: balances and the MetaMask Card's limits (shared/mmcard.js reads them in one multicall)
const mc = new Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const erc = new Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
async function lineaCall(data) {
  const [calls] = mc.decodeFunctionData('aggregate3', data);
  const out = await Promise.all(calls.map(async (c) => {
    const f = erc.parseTransaction({ data: c.callData }), tok = String(c.target).toLowerCase();
    const idx = await accountIndex(f.args[0]);
    if (f.name === 'balanceOf') {
      const x = HOLDINGS[idx]?.[59144]?.tokens.find((y) => y.address === tok);
      return [true, word(x ? BigInt(Math.round(x.amount * 1e6)) * 10n ** BigInt(x.decimals - 6) : 0n)];
    }
    const global = String(f.args[1]).toLowerCase() === '0x9dd23a4a0845f10d65d293776b792af1131c7b30';
    return [true, word(idx === 0 && global ? CARD[tok] || 0n : 0n)];
  }));
  return mc.encodeFunctionResult('aggregate3', [out]);
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const hex = (n) => '0x' + BigInt(n).toString(16);
const GWEI = 1_000_000_000n;

// ---------------------------------------------------------------- JSON-RPC
async function rpcAnswer({ method, params = [] }, host = '') {
  if (method === 'eth_call' && host.includes('linea') && String(params[0]?.to).toLowerCase() === MULTICALL3.toLowerCase()) return lineaCall(params[0].data);
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

// ---- NFTs (home screen): invented generative artworks (inline SVG), one spam airdrop
const rng = (seed) => { let x = seed * 9301 + 49297; return () => ((x = (x * 9301 + 49297) % 233280) / 233280); };
const artSvg = (body, bg) => 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${bg}"/>${body}</svg>`);
const ART = {
  // soft light fields, like long exposures
  drift(seed, [a, b, c]) {
    const r = rng(seed); let g = '';
    for (let i = 0; i < 5; i++) g += `<circle cx="${40 + r() * 320}" cy="${40 + r() * 320}" r="${90 + r() * 120}" fill="${[a, b, c][i % 3]}" opacity=".75" filter="url(#b)"/>`;
    let l = ''; for (let i = 0; i < 26; i++) l += `<path d="M0 ${60 + i * 12} Q200 ${20 + i * 12 + r() * 60} 400 ${60 + i * 12}" stroke="#fff" stroke-opacity=".16" fill="none"/>`;
    return artSvg(`<defs><filter id="b" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="45"/></filter></defs>${g}${l}`, '#0d1424');
  },
  // concentric orbits on a night sky
  orbits(seed, [a, b]) {
    const r = rng(seed); let o = '';
    for (let i = 1; i <= 7; i++) { const rad = i * 26; const t = r() * 6.28; o += `<circle cx="200" cy="200" r="${rad}" fill="none" stroke="${a}" stroke-opacity="${.18 + i * .04}"/><circle cx="${200 + rad * Math.cos(t)}" cy="${200 + rad * Math.sin(t)}" r="${3 + r() * 7}" fill="${i % 3 ? a : b}"/>`; }
    return artSvg(`<circle cx="200" cy="200" r="22" fill="${b}"/>${o}`, '#0b1020');
  },
  // paper-cut geometry, Bauhaus colours
  paper(seed, pal) {
    const r = rng(seed); let g = '';
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const x = i * 100, y = j * 100, c = pal[Math.floor(r() * pal.length)], k = Math.floor(r() * 4);
      g += k === 0 ? `<path d="M${x} ${y + 100} A100 100 0 0 1 ${x + 100} ${y}L${x + 100} ${y + 100}Z" fill="${c}"/>`
        : k === 1 ? `<circle cx="${x + 50}" cy="${y + 50}" r="38" fill="${c}"/>`
          : k === 2 ? `<path d="M${x} ${y}L${x + 100} ${y + 100}L${x} ${y + 100}Z" fill="${c}"/>` : `<rect x="${x + 18}" y="${y + 18}" width="64" height="64" fill="${c}"/>`;
    }
    return artSvg(g, '#f2ebdd');
  },
  // tide lines
  tide(seed, [a, b]) {
    const r = rng(seed); let w = '';
    for (let i = 0; i < 22; i++) { const y = 30 + i * 16, amp = 6 + r() * 18; w += `<path d="M0 ${y} C100 ${y - amp} 150 ${y + amp} 200 ${y} S300 ${y - amp} 400 ${y}" stroke="${i % 4 ? a : b}" stroke-width="${i % 4 ? 2 : 5}" fill="none" stroke-linecap="round"/>`; }
    return artSvg(w, '#e9f1f2');
  },
  // grain and stripes
  grain(seed, [a, b, c]) {
    const r = rng(seed); let s = '';
    for (let i = 0; i < 40; i++) s += `<rect x="${i * 10}" y="0" width="${4 + r() * 6}" height="400" fill="${[a, b, c][Math.floor(r() * 3)]}" opacity="${.35 + r() * .6}"/>`;
    return artSvg(`${s}<circle cx="200" cy="210" r="96" fill="#f6efe2"/><circle cx="200" cy="210" r="96" fill="none" stroke="${a}" stroke-width="3"/>`, '#1c1a17');
  },
};
const EVM_NFTS = [
  { col: 'Lumen Drift', name: 'Lumen Drift #214', art: ART.drift(214, ['#ff7a59', '#7c5cff', '#22d3ee']), desc: 'Long exposures of light that never existed. Each Lumen Drift is rendered once from the block it was minted in, then left to drift.', traits: [['Palette', 'Ember'], ['Fields', '5'], ['Exposure', 'Long'], ['Edition', '214 / 512']] },
  { col: 'Lumen Drift', name: 'Lumen Drift #87', art: ART.drift(87, ['#34d399', '#3b82f6', '#f472b6']), desc: 'Long exposures of light that never existed.', traits: [['Palette', 'Aurora'], ['Fields', '5'], ['Exposure', 'Short']] },
  { col: 'Quiet Orbits', name: 'Orbit 12', art: ART.orbits(12, ['#9fb4ff', '#ffd27a']), desc: 'Seven orbits and a small sun. A study in patience, one of 48.', traits: [['Bodies', '7'], ['Sun', 'Gold']] },
  { col: 'Paper Foxes', name: 'Fox #1031', art: ART.paper(1031, ['#e4572e', '#29335c', '#f3a712', '#669bbc']), desc: 'Paper-cut geometry in four colours.', traits: [['Grid', '4×4'], ['Mood', 'Bold']] },
  { col: 'Tidal Marks', name: 'Mark 3/50', art: ART.tide(3, ['#2b6f77', '#e07a5f']), desc: 'What the sea writes when nobody reads.', traits: [['Lines', '22'], ['Tide', 'Rising']] },
  { col: 'Paper Foxes', name: 'Fox #77', art: ART.paper(77, ['#3d405b', '#81b29a', '#f2cc8f', '#e07a5f']), desc: 'Paper-cut geometry in four colours.', traits: [['Grid', '4×4'], ['Mood', 'Calm']] },
  { col: 'Grain Studies', name: 'Study IV', art: ART.grain(4, ['#c8553d', '#f28f3b', '#588b8b']), desc: 'Stripes, grain and a single moon.', traits: [['Series', 'IV']] },
];
function blockscoutNfts() {
  const items = EVM_NFTS.map((n, i) => ({
    id: /#(\d+)/.exec(n.name)?.[1] || String(100 + i * 37), value: '1', token_type: 'ERC-721', image_url: n.art,
    metadata: { name: n.name, description: n.desc, attributes: n.traits.map(([trait_type, value]) => ({ trait_type, value })) },
    token: { address_hash: '0x' + (i + 10).toString(16).padStart(2, '0').repeat(20), name: n.col, type: 'ERC-721', reputation: 'ok', holders_count: String(800 + i * 91) },
  }));
  items.push({ id: '1', value: '1', token_type: 'ERC-1155', image_url: null, metadata: { name: 'Claim 5,000 USDT at usdt-bonus.xyz' }, token: { address_hash: '0x' + 'ee'.repeat(20), name: 'Reward Pass', type: 'ERC-1155', reputation: 'ok', holders_count: '40211' } });
  return { items, next_page_params: null };
}
function tonNfts() {
  const col = '0:' + 'c1'.repeat(32), col2 = '0:' + 'c2'.repeat(32);
  const list = [
    ['0:' + 'a1'.repeat(32), 'Night Tram #19', col, ART.orbits(19, ['#7dd3fc', '#fda4af']), [['Line', '19'], ['Hour', '02:40']]],
    ['0:' + 'a2'.repeat(32), 'Night Tram #4', col, ART.orbits(4, ['#c4b5fd', '#fde68a']), [['Line', '4'], ['Hour', '23:15']]],
    ['0:' + 'a3'.repeat(32), 'Harbor Light', col2, ART.tide(8, ['#1d4e89', '#f4a259']), [['Weather', 'Fog']]],
  ];
  return {
    nft_items: list.map(([a, , c], i) => ({ address: a, index: String(i), collection_address: c, on_sale: false })),
    metadata: Object.fromEntries([...list.map(([a, n, , img, tr]) => [a, { token_info: [{ type: 'nft_items', name: n, image: img, description: `${n}, from a city that sleeps late.`, extra: { attributes: tr.map(([trait_type, value]) => ({ trait_type, value })) } }] }]),
      [col, { token_info: [{ type: 'nft_collections', name: 'Night Trams' }] }], [col2, { token_info: [{ type: 'nft_collections', name: 'Harbor' }] }]]),
  };
}

// ---- NFT prices: invented floors (CoinGecko without a key, OpenSea with one) and 90 days of sales
const FLOORS = { 'Lumen Drift': 4.2, 'Quiet Orbits': 0.425, 'Paper Foxes': 0.064, 'Tidal Marks': 31.5, 'Grain Studies': 0.0042 }; // from a few dollars to six figures
const nftContract = (addr) => { const i = EVM_NFTS.findIndex((_, k) => '0x' + (k + 10).toString(16).padStart(2, '0').repeat(20) === addr.toLowerCase()); return i >= 0 ? EVM_NFTS[i] : null; };
const slugOf = (col) => col.toLowerCase().replace(/\s+/g, '-');
function nftSalesMock(slug) {
  const col = Object.keys(FLOORS).find((c) => slugOf(c) === slug), f = FLOORS[col] || 0.1, r = rng(slug.length * 97), now = Math.floor(Date.now() / 1000);
  const out = []; let p = f * 0.72;
  for (let d = 90; d >= 0; d--) {
    p = Math.max(f * 0.4, p * (1 + (r() - 0.44) * 0.07)); // a slow climb with noise
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) out.push({ event_type: 'sale', event_timestamp: now - d * 86400 - Math.floor(r() * 80000), quantity: 1, payment: { quantity: String(BigInt(Math.round(p * (0.94 + r() * 0.12) * 1e6)) * 10n ** 12n), decimals: 18, symbol: r() < 0.3 ? 'WETH' : 'ETH' } });
  }
  out.push({ event_type: 'sale', event_timestamp: now - 3600, quantity: 1, payment: { quantity: String(BigInt(Math.round(f * 1e6)) * 10n ** 12n), decimals: 18, symbol: 'ETH' } });
  return out.sort((a, b) => b.event_timestamp - a.event_timestamp);
}
function nftPriceMock(u, init) {
  const cg = /^\/api\/v3\/nfts\/ethereum\/contract\/(0x[0-9a-f]+)$/i.exec(u.pathname);
  if (u.host === 'api.coingecko.com' && cg) { const n = nftContract(cg[1]); if (!n || !FLOORS[n.col]) return [null, 404]; const f = FLOORS[n.col]; return [{ floor_price: { native_currency: f, usd: f * PRICES['coingecko:ethereum'] }, native_currency_symbol: 'eth' }]; }
  if (u.host !== 'api.opensea.io') return null;
  if (u.pathname === '/api/v2/auth/keys' && init.method === 'POST') return [{ api_key: 'demo-free-key', expires_at: new Date(Date.now() + 7 * 86400e3).toISOString() }];
  const c = /^\/api\/v2\/chain\/ethereum\/contract\/(0x[0-9a-f]+)$/i.exec(u.pathname);
  if (c) { const n = nftContract(c[1]); return n ? [{ collection: slugOf(n.col) }] : [null, 404]; }
  const st = /^\/api\/v2\/collections\/([^/]+)\/stats$/.exec(u.pathname);
  if (st) { const col = Object.keys(FLOORS).find((x) => slugOf(x) === st[1]); return col ? [{ total: { floor_price: FLOORS[col], floor_price_symbol: 'ETH' } }] : [null, 404]; }
  const ev = /^\/api\/v2\/events\/collection\/([^/]+)$/.exec(u.pathname);
  if (ev) { const after = Number(u.searchParams.get('after') || 0); return [{ asset_events: nftSalesMock(ev[1]).filter((e) => e.event_timestamp >= after), next: null }]; }
  return [null, 404];
}

function toncenter(u) {
  const p = u.pathname, me = u.searchParams.get('account') || u.searchParams.get('address') || u.searchParams.get('owner_address');
  if (p === '/api/v3/nft/items') return tonNfts();
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

// ---------------------------------------------------------------- Tron (TronGrid): TRX, USDT, some TRX staked for energy
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', PEER_TRON = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
function trongrid(u, init) {
  const p = u.pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  const me = body.address || body.owner_address || decodeURIComponent((/^\/v1\/accounts\/([^/]+)/.exec(p) || [])[1] || '');
  const now = Date.now();
  const account = { address: me, balance: 2_431_250_000, create_time: now - 400 * 86400e3, latest_consume_time: now - 3 * 3600e3,
    frozenV2: [{}, { type: 'ENERGY', amount: 30_000_000_000 }, { type: 'TRON_POWER' }], votes: [{ vote_address: 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH', vote_count: 30000 }],
    account_resource: { latest_consume_time_for_energy: now - 3 * 3600e3, energy_window_size: 28800, energy_usage: 65000 },
    owner_permission: { keys: [{ address: me, weight: 1 }] }, active_permission: [{ keys: [{ address: me, weight: 1 }] }] };
  if (p === `/v1/accounts/${me}`) return { success: true, data: [{ ...account, trc20: [{ [USDT_TRON]: '1250500000' }] }] };
  if (p === `/v1/accounts/${me}/transactions`) {
    return { success: true, meta: {}, data: [
      { txID: 'a1'.repeat(32), block_timestamp: now - 5 * 3600e3, ret: [{ contractRet: 'SUCCESS', fee: 0 }], raw_data: { timestamp: now - 5 * 3600e3, contract: [{ type: 'TransferContract', parameter: { value: { owner_address: PEER_TRON, to_address: me, amount: 150_000_000 } } }] } },
      { txID: 'a2'.repeat(32), block_timestamp: now - 30 * 3600e3, ret: [{ contractRet: 'SUCCESS', fee: 0 }], raw_data: { timestamp: now - 30 * 3600e3, contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: me, frozen_balance: 30_000_000_000, resource: 'ENERGY' } } }] } },
    ] };
  }
  if (p === `/v1/accounts/${me}/transactions/trc20`) {
    return { success: true, meta: {}, data: [
      { transaction_id: 'b1'.repeat(32), block_timestamp: now - 2 * 3600e3, from: me, to: PEER_TRON, type: 'Transfer', value: '85000000', token_info: { address: USDT_TRON, symbol: 'USDT', decimals: 6, name: 'Tether USD' } },
      { transaction_id: 'b2'.repeat(32), block_timestamp: now - 50 * 3600e3, from: PEER_TRON, to: me, type: 'Transfer', value: '500000000', token_info: { address: USDT_TRON, symbol: 'USDT', decimals: 6, name: 'Tether USD' } },
    ] };
  }
  if (p === '/v1/trc20/info') return { success: true, data: [] };
  if (p === '/wallet/getaccount') return account;
  if (p === '/wallet/getaccountresource') {
    return { freeNetLimit: 600, freeNetUsed: 120, EnergyLimit: 289680, EnergyUsed: 65000, TotalEnergyLimit: 180000000000, TotalEnergyWeight: 18642090639,
      TotalNetLimit: 43200000000, TotalNetWeight: 26601598388, tronPowerLimit: 30000, tronPowerUsed: 30000 };
  }
  if (p === '/wallet/getchainparameters') {
    const P = { getTransactionFee: 1000, getEnergyFee: 100, getCreateAccountFee: 100000, getCreateNewAccountFeeInSystemContract: 1000000, getMemoFee: 1000000, getUnfreezeDelayDays: 14, getMaxFeeLimit: 15000000000, getWitnessPayPerBlock: 8000000, getWitness127PayPerBlock: 128000000 };
    return { chainParameter: Object.entries(P).map(([key, value]) => ({ key, value })) };
  }
  if (p === '/wallet/triggerconstantcontract' && body.contract_address === 'TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd') { // JustLend's energy market: its terms as read on mainnet, no rental
    const w = (h) => h.padStart(64, '0');
    const out = { '21620ec2': w('1538297b3'), '24ec7590': w('1312d00'), '41744dd4': w('48c273950000'), fdcb648c: w('0'), '58d0a4db': w('0'), '3193fada': w('196b8b9f1'), '195d0f08': w('0').repeat(3), c449d2a9: w('0').repeat(3) }[String(body.data || '').slice(0, 8)];
    return { result: { result: true }, constant_result: [out ?? ''], energy_used: 92_000 };
  }
  if (p === '/wallet/getReward') return { reward: 3_210_000 };
  if (p === '/wallet/listwitnesses') return { witnesses: [{ address: 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH', voteCount: 4890607406, url: 'https://poloniex.com' }] };
  if (p === '/wallet/getBrokerage') return { brokerage: 20 };
  if (p === '/wallet/getcandelegatedmaxsize') return { max_size: 5_000_000_000 };
  if (p === '/wallet/getdelegatedresourceaccountindexv2') return { account: me };
  return null;
}

// ---------------------------------------------------------------- Bitcoin (mempool.space): the demo account's coins
// The first account of the demo phrase (capture.mjs): its SegWit and Taproot addresses, derived here the same way. Coins
// on several addresses, a payment sent (with its change), one on its way in, a small coin, an inscription and runes
// (recognised from the transactions that created them: the protection without services).
let btcDemo = null;
function btcWorld() {
  if (btcDemo) return btcDemo;
  const entropy = sha256(new TextEncoder().encode('chakra-landing-demo-v1')).subarray(0, 16);
  const acc = hdAccountPublic(seedOfPhrase(Mnemonic.fromEntropy(entropy).phrase), 0, 0, ['p2wpkh', 'p2tr', 'p2sh-p2wpkh', 'p2pkh']);
  const NET = { bech32: 'bc', pubKeyHash: 0, scriptHash: 5, wif: 128 };
  const S = (c, i) => branchAddress(acc.branches[0], c, i, NET), T = (i) => branchAddress(acc.branches[1], 0, i, NET);
  const PEER = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', SHOP = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  const now = Math.floor(Date.now() / 1000), h = (n) => now - n * 3600;
  const id = (k) => k.repeat(32);
  const tx = (k, { vin, vout, time, fee = 1420, witness = [] }) => ({
    txid: id(k), fee, weight: 564, status: time ? { confirmed: true, block_height: 870000, block_time: time } : { confirmed: false },
    vin: vin.map(([txid, vout, address, value]) => ({ txid, vout, prevout: { scriptpubkey_address: address, value }, witness })),
    vout: vout.map(([address, value, script]) => ({ scriptpubkey_address: address, scriptpubkey: script || '0014' + '11'.repeat(20), value })),
  });
  const txs = [
    tx('a1', { vin: [[id('f1'), 0, PEER, 5_100_000]], vout: [[S(0, 0), 5_000_000], [PEER, 98_200]], time: h(400) }),
    tx('a2', { vin: [[id('f2'), 1, PEER, 3_500_000]], vout: [[S(0, 0), 3_420_000], [PEER, 78_400]], time: h(260) }),
    tx('a3', { vin: [[id('f3'), 0, PEER, 3_000_000]], vout: [[S(0, 1), 3_000_000]], time: h(190), fee: 1100 }),
    tx('a4', { vin: [[id('a3'), 0, S(0, 1), 3_000_000]], vout: [[SHOP, 2_670_000], [S(1, 0), 318_200]], time: h(150), fee: 11_800 }), // a payment, its change
    tx('a5', { vin: [[id('f4'), 0, PEER, 1_250_000]], vout: [[S(0, 2), 1_200_000], [PEER, 48_600]], time: h(70) }),
    tx('a6', { vin: [[id('f5'), 2, PEER, 20_000]], vout: [[T(0), 546]], time: h(48), witness: ['aa'.repeat(32), '20' + '11'.repeat(32) + 'ac0063036f7264010118'] }), // an inscription
    tx('a7', { vin: [[id('f6'), 0, PEER, 15_000]], vout: [['', 0, '6a5d09160200c0a233036401'], [T(1), 546]], time: h(30) }), // runes
    tx('a8', { vin: [[id('f7'), 1, PEER, 9_000]], vout: [[S(0, 2), 2_100]], time: h(20) }), // a small coin
    tx('a9', { vin: [[id('f8'), 0, PEER, 420_000]], vout: [[S(0, 3), 400_000], [PEER, 18_900]] }), // on its way in
  ];
  btcDemo = { txs, byId: Object.fromEntries(txs.map((t) => [t.txid, t])) };
  return btcDemo;
}
function esplora(u) {
  const { txs, byId } = btcWorld();
  const p = u.pathname.replace(/^\/api/, '');
  const spent = (txid, vout) => txs.some((t) => t.vin.some((v) => v.txid === txid && v.vout === vout));
  const touches = (t, a) => t.vout.some((o) => o.scriptpubkey_address === a) || t.vin.some((v) => v.prevout.scriptpubkey_address === a);
  let m;
  if (p === '/v1/fees/recommended') return { fastestFee: 9, halfHourFee: 5, hourFee: 3, economyFee: 2, minimumFee: 1 };
  if ((m = /^\/address\/([^/]+)$/.exec(p))) {
    const s = { chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } };
    for (const t of txs) {
      if (!touches(t, m[1])) continue;
      const k = t.status.confirmed ? s.chain_stats : s.mempool_stats;
      k.tx_count++;
      for (const o of t.vout) if (o.scriptpubkey_address === m[1]) k.funded_txo_sum += o.value;
      for (const v of t.vin) if (v.prevout.scriptpubkey_address === m[1]) k.spent_txo_sum += v.prevout.value;
    }
    return { address: m[1], ...s };
  }
  if ((m = /^\/address\/([^/]+)\/utxo$/.exec(p))) {
    const out = [];
    for (const t of txs) t.vout.forEach((o, i) => { if (o.scriptpubkey_address === m[1] && !spent(t.txid, i)) out.push({ txid: t.txid, vout: i, value: o.value, status: t.status }); });
    return out;
  }
  if ((m = /^\/address\/([^/]+)\/txs$/.exec(p))) return txs.filter((t) => touches(t, m[1])).sort((a, b) => (b.status.block_time || 9e9) - (a.status.block_time || 9e9));
  if (/^\/address\/[^/]+\/txs\/chain\//.test(p)) return [];
  if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(p))) return byId[m[1]] || null;
  if ((m = /^\/v1\/tx\/([0-9a-f]{64})\/rbf$/.exec(p))) return { replacements: null, replaces: null };
  return null;
}

// ---------------------------------------------------------------- router
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input); // a string or a URL object
  const u = new URL(url, location.href);
  if (u.origin === location.origin) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, 40));
  if (init.method === 'POST' && init.body && /rpc|publicnode|base\.org|arbitrum|optimism|llamarpc|cloudflare-eth|avax|gnosis|bnbchain|sepolia|linea/.test(u.host + u.pathname)) {
    const body = JSON.parse(init.body);
    const one = async (r) => { try { return { jsonrpc: '2.0', id: r.id, result: await rpcAnswer(r, u.host) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code || -32000, message: e.message } }; } };
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
  if (u.host === 'api.trongrid.io') { const r = trongrid(u, init); return r ? json(r) : json({ Error: 'not found' }, 404); }
  if (u.host === 'mempool.space' || u.host === 'blockstream.info') { const r = esplora(u); return r ? json(r) : json({ error: 'not found' }, 404); }
  if (/blockscout\.com$/.test(u.host) && /\/nft$/.test(u.pathname)) return json(blockscoutNfts());
  { const r = nftPriceMock(u, init); if (r) return r[0] === null ? json({}, r[1]) : json(r[0], r[1] || 200); }
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
