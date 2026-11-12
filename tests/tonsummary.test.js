// TON balances in the accounts' multichain summary: same shape as an EVM portfolio, shown only when there are funds.
import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/ui/hooks.js';
import { TON_CHAINS } from '../src/shared/ton/api.js';

const TON = TON_CHAINS[-239];
const BASE = { id: 8453, name: 'Base', native: { symbol: 'ETH', name: 'Ether', decimals: 18 } };
const evm = { native: { amount: 0.01, usd: 30 }, tokens: [] };
const ton = (gram, usdt) => ({
  native: { amount: gram, usd: gram * 1.2, balance: String(gram * 1e9) },
  tokens: usdt ? [{ address: '0:B113', symbol: 'USD₮', name: 'Tether USD', decimals: 6, amount: usdt, usd: usdt, price: 1, icon: null, balance: String(usdt * 1e6) },
    { address: '0:AAAA', symbol: 'XYZ', name: 'Unknown', decimals: 9, amount: 5, usd: null, price: null, icon: null, balance: '5000000000' }] : [],
  updated: Date.now(),
});

test('TON funds join the summary: total, network chip, holdings', () => {
  const s = summarize([{ chain: BASE, p: evm }, { chain: TON, p: ton(10, 20) }], false);
  assert.equal(s.usd, 30 + 12 + 20);
  assert.deepEqual(s.nets.map((n) => n.chain.id), [-239, 8453]);
  assert.equal(s.nets[0].usd, 32);
  assert.deepEqual(s.holdings.map((h) => h.symbol), ['ETH', 'USD₮', 'GRAM']);
  assert.equal(s.holdings.find((h) => h.symbol === 'GRAM').chain.id, -239);
  assert.equal(s.unpriced, 1, 'a jetton without a price counts as unpriced, like EVM tokens');
  assert.equal(s.loaded, 2);
});

test('no TON chip without TON funds; a TON-only account sums TON alone', () => {
  const s = summarize([{ chain: BASE, p: evm }, { chain: TON, p: ton(0, 0) }], false);
  assert.deepEqual(s.nets.map((n) => n.chain.id), [8453]);
  const only = summarize([{ chain: TON, p: ton(3, 0) }], false);
  assert.ok(Math.abs(only.usd - 3.6) < 1e-9);
  assert.deepEqual(only.nets.map((n) => n.chain.id), [-239]);
  const loading = summarize([{ chain: TON, p: null, pending: true }], false);
  assert.equal(loading.loaded, 0);
  assert.equal(loading.pending, 1);
});
