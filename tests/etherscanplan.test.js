// A key whose Etherscan plan doesn't cover the network (since November 2025 the free plan has no BNB Chain): the
// portfolio shows the "tokens aren't found automatically" notice instead of failing silently, the history says what
// it takes instead of Etherscan's raw message. Any other Etherscan error stays an error.
import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPortfolio, planRefused } from '../src/shared/portfolio.js';
import { loadHistory } from '../src/shared/history.js';
import { BUILTIN_CHAINS } from '../src/shared/chains.js';
import { poolResetAt, etherscanGet } from '../src/shared/indexer.js';

const ME = '0x1234567890abcdef1234567890abcdef12345678';
// a network like BNB Chain, without well-known tokens (no on-chain token reads to fake)
const CHAIN = { id: 990056, name: 'Paid Net', native: { symbol: 'PN', decimals: 18 }, rpc: ['https://rpc.test'], indexer: { type: 'etherscan', url: 'https://api.etherscan.io/v2/api', needsKey: true, paidPlan: true } };
const PLAN = { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis' };

function network(etherscan) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.startsWith('https://rpc.test')) {
      const body = JSON.parse(opts.body);
      const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x' });
      return json(Array.isArray(body) ? body.map(one) : one(body));
    }
    if (u.includes('api.etherscan.io') && etherscan) return json(etherscan);
    return json({ coins: {} }); // prices
  };
}

test('BNB Chain is marked as needing a paid Etherscan plan', () => {
  assert.equal(BUILTIN_CHAINS.find((c) => c.id === 56).indexer.paidPlan, true);
  assert.equal(planRefused(PLAN), true);
  assert.equal(planRefused({ status: '0', message: 'No transactions found', result: [] }), false);
  assert.equal(planRefused({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }), false);
});

test("a free key on a network outside the free plan: the notice, not a silent failure", async () => {
  network(PLAN);
  const p = await loadPortfolio(CHAIN, ME, { etherscanKey: 'free' });
  assert.equal(p.native.amount, 1, 'the balance still comes from the node');
  assert.equal(p.noIndexer, true, 'the notice "tokens aren\'t found automatically" shows');
  assert.equal(p.indexerOk, true, 'not reported as a failure');

  const h = await loadHistory(CHAIN, ME, null, { etherscanKey: 'free' });
  assert.deepEqual([h.unsupported, h.error], [true, null], 'the screen explains what it takes');
});

test('any other Etherscan error is still an error', async () => {
  network({ status: '0', message: 'NOTOK', result: 'Invalid API Key' });
  const h = await loadHistory(CHAIN, ME, null, { etherscanKey: 'wrong' });
  assert.equal(h.unsupported, false);
  assert.equal(h.error, 'Invalid API Key');
});

// Linea (and other networks) since August 2026: the free plan draws from one daily pool shared by every free user.
// When it runs out the screens say when it comes back, instead of "check your connection".
const POOL = { status: '0', message: 'NOTOK', result: 'Community Free API Limit reached. Resets 2026-11-18 00:00:00 UTC. For higher, uninterrupted limits, please upgrade to API Pro: https://etherscan.io/apis' };
const FREE_CHAIN = { ...CHAIN, indexer: { type: 'etherscan', url: 'https://api.etherscan.io/v2/api', needsKey: true } };

test('the shared free pool ran out: history and tokens say when it comes back, no failure', async () => {
  network(POOL);
  const h = await loadHistory(FREE_CHAIN, ME, null, { etherscanKey: 'free' });
  assert.deepEqual([h.error, h.unsupported, h.limitUntil], [null, false, Date.parse('2026-11-18T00:00:00Z')]);
  const p = await loadPortfolio(FREE_CHAIN, ME, { etherscanKey: 'free' });
  assert.equal(p.indexerOk, true, 'not reported as a scan failure');
  assert.equal(p.noIndexer, false);
  assert.equal(p.indexerLimit, Date.parse('2026-11-18T00:00:00Z'));
  assert.equal(poolResetAt({ status: '0', result: 'Community Free API Limit reached.' }), 0, 'no hour given');
});

test('half a page refused by the pool is still the pool (the other half answered)', async () => {
  let n = 0;
  network(null);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('api.etherscan.io')
    ? { ok: true, status: 200, json: async () => (n++ % 2 ? POOL : { status: '1', message: 'OK', result: [] }) }
    : inner(url, opts));
  const h = await loadHistory(FREE_CHAIN, ME, null, { etherscanKey: 'free' });
  assert.equal(h.limitUntil > 0, true);
  assert.equal(h.error, null);
});

test('"max calls per second" is waited out and retried; other error answers are errors, not "no tokens"', async () => {
  const answers = [{ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (3/sec)' }, { status: '0', message: 'No transactions found', result: [] }];
  let calls = 0;
  network(null);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('api.etherscan.io')
    ? { ok: true, status: 200, json: async () => answers[Math.min(calls++, 1)] }
    : inner(url, opts));
  const p = await loadPortfolio(FREE_CHAIN, ME, { etherscanKey: 'free' });
  assert.equal(calls, 2, 'asked again after the rate limit');
  assert.equal(p.indexerOk, true);

  network({ status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)|1' });
  const bad = await loadPortfolio(FREE_CHAIN, ME, { etherscanKey: 'wrong' });
  assert.equal(bad.indexerOk, false, 'reported, not shown as an account without tokens');
  assert.match(bad.indexerError, /Invalid API Key/);
});

test('Etherscan requests take turns: no more than 3 a second', async () => {
  const at = [];
  network(null);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.etherscan.io')) { at.push(Date.now()); return { ok: true, status: 200, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) }; }
    return inner(url, opts);
  };
  await Promise.all([1, 2, 3, 4].map((i) => etherscanGet(FREE_CHAIN, { module: 'account', action: 'txlist', address: ME, page: i }, 'free')));
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.equal(gaps.every((g) => g >= 330), true, `gaps ${gaps}`);
});
