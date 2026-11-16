// NFT values: the floor price of a collection (OpenSea with a key, CoinGecko without, Getgems on TON), the sales for
// the chart, the readings kept on the device and the automatic OpenSea key, renewed before it expires.
import { resetStorage, storage } from './helpers/chrome.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorFromOpensea, floorFromCoingecko, floorFromGetgems, salesFromOpensea, salesFromGetgems, addReading, autoKeyUsable,
  nftFloor, nftSales, openseaKey, salesSource, floorLog,
} from '../src/shared/nftPrices.js';
import { bucketMedian } from '../src/ui/screens/nfts.jsx';

const ETH = { id: 1, name: 'Ethereum', native: { symbol: 'ETH', priceId: 'coingecko:ethereum' } };
const TON = { id: -239, kind: 'ton', name: 'TON', native: { symbol: 'GRAM', priceId: 'coingecko:the-open-network' } };
const NFT = { key: '0xabc:1', contract: '0xAbC0000000000000000000000000000000000001', tokenId: '1' };
const TNFT = { key: '0:11', contract: '0:CC', tokenId: '5' };

let calls, routes;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  await resetStorage();
  calls = []; routes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {} });
    const r = routes.find(([re]) => re.test(u));
    if (!r) return new Response('{}', { status: 404 });
    const [, body, status = 200] = r;
    return new Response(JSON.stringify(typeof body === 'function' ? body(u) : body), { status });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const prices = [/coins\.llama\.fi\/prices/, { coins: { 'coingecko:ethereum': { price: 3000 }, 'coingecko:the-open-network': { price: 3 } } }];

test('parsers: floors and sales from OpenSea, CoinGecko, Getgems', () => {
  assert.deepEqual(floorFromOpensea({ total: { floor_price: 6.06, floor_price_symbol: 'ETH' } }), { native: 6.06, symbol: 'ETH' });
  assert.equal(floorFromOpensea({ total: { floor_price: 0 } }), null);
  assert.deepEqual(floorFromCoingecko({ floor_price: { native_currency: 6.06, usd: 11000 }, native_currency_symbol: 'eth' }), { native: 6.06, symbol: 'ETH', usd: 11000 });
  assert.deepEqual(floorFromGetgems({ response: { floorPrice: 12.5 } }), { native: 12.5, symbol: 'GRAM' });
  assert.deepEqual(floorFromGetgems({ response: { floorPrice: null, floorPriceNano: '2500000000' } }), { native: 2.5, symbol: 'GRAM' });
  const ev = (t, q, symbol = 'ETH', quantity = 1) => ({ event_timestamp: t, quantity, payment: { quantity: String(q), decimals: 18, symbol } });
  const s = salesFromOpensea([ev(200, 2e18), ev(100, 1e18, 'WETH'), ev(150, 5e6, 'USDC'), ev(300, 6e18, 'ETH', 2)]);
  assert.equal(s.symbol, 'ETH', 'ETH and WETH together are the most common');
  assert.deepEqual(s.points, [{ t: 100000, p: 1 }, { t: 200000, p: 2 }, { t: 300000, p: 3 }], 'oldest first, price per item');
  assert.deepEqual(salesFromGetgems([
    { timestamp: 20, typeData: { type: 'sold', price: '4.5' } },
    { timestamp: 10, typeData: { type: 'sold', priceNano: '3000000000' } },
    { timestamp: 15, typeData: { type: 'putUpForSale', price: '9' } },
    { timestamp: 16, typeData: { type: 'sold', price: '100', currency: 'USDT' } },
  ]), [{ t: 10000, p: 3 }, { t: 20000, p: 4.5 }]);
});

test('device readings: one per period (the latest), a bounded log', () => {
  let log = addReading([], { t: 0, p: 1 }, 100);
  log = addReading(log, { t: 50, p: 2 }, 100);
  assert.deepEqual(log, [{ t: 50, p: 2 }], 'same period: replaced');
  log = addReading(log, { t: 200, p: 3 }, 100);
  assert.equal(log.length, 2);
  let big = [];
  for (let i = 0; i < 600; i++) big = addReading(big, { t: i * 1000, p: i }, 1);
  assert.equal(big.length, 500);
  assert.equal(big[0].p, 100);
});

test('sales by period: the median, so one odd sale is no spike', () => {
  const day = 86400e3;
  assert.deepEqual(bucketMedian([{ t: 1, p: 1 }, { t: 2, p: 100 }, { t: 3, p: 2 }, { t: day + 1, p: 4 }, { t: day + 2, p: 6 }], day),
    [{ t: day / 2, p: 2, n: 3 }, { t: day * 1.5, p: 5, n: 2 }]);
});

test('without keys: CoinGecko floor in USD, OpenSea never called, the reading logged', async () => {
  routes.push([/coingecko\.com\/api\/v3\/nfts\/ethereum\/contract\/0xabc0/, { floor_price: { native_currency: 2, usd: 6000 }, native_currency_symbol: 'eth' }]);
  const v = await nftFloor(ETH, NFT, {});
  assert.equal(v.source, 'coingecko'); assert.equal(v.usd, 6000); assert.equal(v.native, 2);
  assert.ok(!calls.some((c) => c.url.includes('opensea')));
  assert.equal((await floorLog(ETH, NFT)).length, 1);
  assert.equal(salesSource(ETH, {}), null, 'no sales without an OpenSea key');
  assert.equal(await nftSales(ETH, NFT, {}), null);
  // cached: no second request
  const n = calls.length;
  await nftFloor(ETH, NFT, {});
  assert.equal(calls.length, n);
});

test('own OpenSea key: slug, floor in ETH converted to USD, sales; only the contract address is sent', async () => {
  routes.push(
    [/opensea\.io\/api\/v2\/chain\/ethereum\/contract\//, { collection: 'things' }],
    [/opensea\.io\/api\/v2\/collections\/things\/stats/, { total: { floor_price: 0.5, floor_price_symbol: 'ETH' } }],
    [/opensea\.io\/api\/v2\/events\/collection\/things/, { asset_events: [{ event_timestamp: 1700000000, quantity: 1, payment: { quantity: '400000000000000000', decimals: 18, symbol: 'ETH' } }, { event_timestamp: 1700086400, quantity: 1, payment: { quantity: '600000000000000000', decimals: 18, symbol: 'WETH' } }], next: null }],
    prices,
  );
  const settings = { openseaKey: 'MY-KEY' };
  const v = await nftFloor(ETH, NFT, settings);
  assert.deepEqual({ native: v.native, usd: v.usd, source: v.source }, { native: 0.5, usd: 1500, source: 'opensea' });
  assert.ok(calls.filter((c) => c.url.includes('opensea')).every((c) => c.headers['x-api-key'] === 'MY-KEY'));
  const sales = await nftSales(ETH, NFT, settings, 30);
  assert.deepEqual(sales.points.map((x) => x.p), [0.4, 0.6]);
  assert.equal(sales.symbol, 'ETH');
  assert.ok(!calls.some((c) => /0x[0-9a-f]{40}/i.test(c.url) && !c.url.toLowerCase().includes('0xabc0')), 'no other address');
});

test('automatic key: minted once, reused, renewed a day before it expires; none unless chosen', async () => {
  let n = 0;
  routes.push([/opensea\.io\/api\/v2\/auth\/keys/, () => ({ api_key: `K${++n}`, expires_at: new Date(Date.now() + 7 * 86400e3).toISOString() })]);
  assert.equal(await openseaKey({}), null, 'not chosen: no key requested');
  assert.equal(calls.length, 0);
  assert.equal(await openseaKey({ nftHistory: 'auto' }), 'K1');
  assert.equal(await openseaKey({ nftHistory: 'auto' }), 'K1', 'kept on the device');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.headers['x-api-key'], undefined);
  await storage.local.set({ openseaAuto: { key: 'K1', expires: new Date(Date.now() + 3600e3).toISOString() } }); // expires within the day
  assert.equal(await openseaKey({ nftHistory: 'auto' }), 'K2', 'renewed');
  assert.equal(await openseaKey({ nftHistory: 'auto', openseaKey: 'MINE' }), 'MINE', 'one\'s own key first');
  assert.equal(autoKeyUsable({ key: 'x', expires: new Date(Date.now() - 1).toISOString() }, Date.now(), 0), false);
  // OpenSea refuses: the old key while it still works, else none
  routes.unshift([/opensea\.io\/api\/v2\/auth\/keys/, { error: 'nope' }, 503]);
  await storage.local.set({ openseaAuto: { key: 'OLD', expires: new Date(Date.now() + 3600e3).toISOString() } });
  assert.equal(await openseaKey({ nftHistory: 'auto' }), 'OLD');
});

test('TON: Getgems with a key (floor in GRAM, sales); nothing without', async () => {
  routes.push(
    [/getgems\.io\/public-api\/v1\/collection\/stats\/0:CC/, { success: true, response: { floorPrice: 10 } }],
    [/getgems\.io\/public-api\/v1\/collection\/history\/0:CC/, { success: true, response: { cursor: null, items: [{ timestamp: 1700000000, typeData: { type: 'sold', price: '9' } }, { timestamp: 1700090000, typeData: { type: 'sold', price: '11' } }] } }],
    prices,
  );
  assert.equal(await nftFloor(TON, TNFT, {}), null);
  assert.equal(calls.length, 0, 'no request without a key');
  const v = await nftFloor(TON, TNFT, { getgemsKey: 'GG' });
  assert.deepEqual({ native: v.native, symbol: v.symbol, usd: v.usd }, { native: 10, symbol: 'GRAM', usd: 30 });
  assert.equal(calls.find((c) => c.url.includes('stats')).headers.authorization, 'GG');
  assert.deepEqual((await nftSales(TON, TNFT, { getgemsKey: 'GG' })).points.map((x) => x.p), [9, 11]);
});

test('a busy service (429) is not remembered as "no price"', async () => {
  routes.push([/coingecko/, { status: { error_code: 429 } }, 429]);
  assert.equal(await nftFloor(ETH, NFT, {}), null);
  routes.length = 0;
  routes.push([/coingecko/, { floor_price: { native_currency: 1, usd: 3000 }, native_currency_symbol: 'eth' }]);
  assert.equal((await nftFloor(ETH, NFT, {})).usd, 3000, 'asked again');
});
