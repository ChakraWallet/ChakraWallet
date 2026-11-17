// BNB Chain with a NodeReal key: the tokens held come from nr_getTokenHoldings and the history from
// nr_getAssetTransfers (what the address sent and what it received, each with its own page key), instead of
// Etherscan, whose free plan doesn't cover BNB Chain.
import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPortfolio } from '../src/shared/portfolio.js';
import { loadHistory } from '../src/shared/history.js';

const ME = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x00000000000000000000000000000000000000bb';
const CHAIN = {
  id: 990057, name: 'NR Net', native: { symbol: 'NR', decimals: 18 }, rpc: ['https://rpc.test'],
  indexer: { type: 'etherscan', url: 'https://api.etherscan.io/v2/api', needsKey: true, paidPlan: true },
  nodeReal: 'https://nodereal.test/v1',
};
const hex = (n) => '0x' + BigInt(n).toString(16);

const ext = (hash, from, to, value, ts, extra = {}) => ({ id: 1, category: 'external', hash, from, to, value: hex(value), blockTimeStamp: ts, gasPrice: 1000, gasUsed: 21000, receiptsStatus: 1, input: '0x', ...extra });
const bep20 = (hash, from, to, value, ts) => ({ id: 2, category: '20', hash, from, to, value: hex(value), asset: 'TKN', name: 'Token', decimal: '6', contractAddress: TOKEN, blockTimeStamp: ts });

function network({ holdings, sent = [], got = [], pageKeys = {}, nodeRealError } = {}) {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.startsWith('https://nodereal.test/v1/')) {
      assert.equal(u, 'https://nodereal.test/v1/nr-key', 'the key goes in the path, to NodeReal only');
      const { method, params } = JSON.parse(opts.body);
      seen.push({ method, params });
      if (nodeRealError) return json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: nodeRealError } });
      if (method === 'nr_getTokenHoldings') return json({ jsonrpc: '2.0', id: 1, result: holdings });
      const q = params[0];
      const side = q.fromAddress ? 'from' : 'to';
      return json({ jsonrpc: '2.0', id: 1, result: { transfers: side === 'from' ? sent : got, pageKey: pageKeys[side] || '' } });
    }
    if (u.startsWith('https://rpc.test')) {
      const body = JSON.parse(opts.body);
      const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : r.method === 'eth_call' ? '0x' : null });
      return json(Array.isArray(body) ? body.map(one) : one(body));
    }
    if (u.includes('etherscan')) throw new Error('Etherscan must not be asked when the NodeReal key is set');
    return json({ coins: {} }); // prices
  };
  return seen;
}

test('tokens held come from NodeReal: no "add a key" notice', async () => {
  network({ holdings: { totalCount: '0x1', details: [{ tokenAddress: TOKEN.toUpperCase().replace('0X', '0x'), tokenName: 'Token', tokenSymbol: 'TKN', tokenDecimals: '0x6', tokenBalance: hex(2_500_000) }] } });
  const p = await loadPortfolio(CHAIN, ME, { nodeRealKey: 'nr-key', etherscanKey: 'free' });
  assert.equal(p.noIndexer, false);
  assert.equal(p.indexerOk, true);
  const t = p.tokens.find((x) => x.address === TOKEN);
  assert.ok(t, 'the token held is listed');
  assert.equal(t.symbol, 'TKN');
  assert.equal(t.amount, 2.5, 'the balance from NodeReal when the node gives none (decimals in hex)');
});

test('without the NodeReal key BNB Chain still says what it takes', async () => {
  network({});
  const p = await loadPortfolio(CHAIN, ME, {});
  assert.equal(p.noIndexer, true);
});

test('history: sends and receipts, BNB and tokens, one record per transaction', async () => {
  const seen = network({
    // sending a token: my transaction to the token contract (value 0) and the transfer it makes
    sent: [ext('0xa1', ME, OTHER, 10n ** 17n, 1_700_000_200), ext('0xa2', ME, TOKEN, 0, 1_700_000_100, { input: '0xa9059cbb00' }), bep20('0xa2', ME, OTHER, 1_000_000, 1_700_000_100)],
    got: [ext('0xa3', OTHER, ME, 5n * 10n ** 17n, 1_700_000_050, { receiptsStatus: 0 }), bep20('0xa2', ME, OTHER, 1_000_000, 1_700_000_100)],
  });
  const h = await loadHistory(CHAIN, ME, null, { nodeRealKey: 'nr-key', etherscanKey: 'free' });
  assert.equal(h.error, null);
  assert.equal(h.unsupported, false);
  assert.deepEqual(h.items.map((x) => x.hash), ['0xa1', '0xa2', '0xa3'], 'newest first, the token transfer not doubled');
  const [send, token, failed] = h.items;
  assert.equal(send.kind, 'send');
  assert.equal(send.fee, String(21000 * 1000));
  assert.equal(token.transfers.length, 1);
  assert.equal(token.transfers[0].symbol, 'TKN');
  assert.equal(token.transfers[0].decimals, 6);
  assert.equal(failed.status, 'failed');
  const q = seen.filter((s) => s.method === 'nr_getAssetTransfers').map((s) => s.params[0]);
  assert.deepEqual(q.map((x) => [x.fromAddress, x.toAddress, x.category.join()]), [[ME, undefined, 'external,20'], [undefined, ME, 'external,20']]);
  assert.equal(h.next, null, 'short lists: no more pages');
});

test('a token "sent" by me without a transaction of mine is a fake (address poisoning)', async () => {
  network({ sent: [bep20('0xfake', ME, OTHER, 1_000_000, 1_700_000_100)] });
  const h = await loadHistory(CHAIN, ME, null, { nodeRealKey: 'nr-key' });
  assert.equal(h.items.find((x) => x.hash === '0xfake').spam, true);
});

test('history pages: each side goes on with its own page key, a finished side is not asked again', async () => {
  const full = Array.from({ length: 50 }, (_, i) => ext(`0xs${i}`, ME, OTHER, 1, 1_700_000_000 - i));
  network({ sent: full, got: [], pageKeys: { from: 'next-from' } });
  const h = await loadHistory(CHAIN, ME, null, { nodeRealKey: 'nr-key' });
  assert.deepEqual(h.next, { from: 'next-from', to: null, src: 'nodereal' });

  const seen = network({ sent: [ext('0xold', ME, OTHER, 1, 1_600_000_000)] });
  const h2 = await loadHistory(CHAIN, ME, h.next, { nodeRealKey: 'nr-key' });
  const q = seen.filter((s) => s.method === 'nr_getAssetTransfers').map((s) => s.params[0]);
  assert.equal(q.length, 1, 'only the side with more pages');
  assert.equal(q[0].pageKey, 'next-from');
  assert.deepEqual(h2.items.map((x) => x.hash), ['0xold']);
});

test("NodeReal's errors are shown as errors", async () => {
  network({ nodeRealError: 'invalid api key' });
  const h = await loadHistory(CHAIN, ME, null, { nodeRealKey: 'nr-key' });
  assert.match(h.error, /invalid api key/);
  const p = await loadPortfolio(CHAIN, ME, { nodeRealKey: 'nr-key' });
  assert.equal(p.indexerOk, false);
});

test('a token answering garbage to balanceOf is not a balance (no overflow)', async () => {
  network({ holdings: { totalCount: '0x1', details: [{ tokenAddress: TOKEN, tokenName: 'Spam', tokenSymbol: 'SPAM', tokenDecimals: '0x12', tokenBalance: '0x0' }] } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://rpc.test')) {
      const body = JSON.parse(opts.body);
      const garbage = '0x' + 'ff'.repeat(96); // three words
      const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_getBalance' ? '0x0' : garbage });
      return { ok: true, status: 200, json: async () => (Array.isArray(body) ? body.map(one) : one(body)) };
    }
    return inner(url, opts);
  };
  const p = await loadPortfolio(CHAIN, ME, { nodeRealKey: 'nr-key' });
  assert.equal(p.indexerOk, true);
});
