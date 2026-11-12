import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpamToken, looksForged } from '../src/shared/portfolio.js';
import { POPULAR_TOKENS, LEGIT_VARIANTS } from '../src/shared/tokens.js';

const usdt = POPULAR_TOKENS[1].find((t) => t.symbol === 'USDT');
const RANDOM = '0x00000000000000000000000000000000deadbeef';

test('real popular token is not spam', () => {
  assert.equal(isSpamToken({ symbol: 'USDT', name: 'Tether USD', address: usdt.address }, 1), false);
});
test('popular symbol at another address is a fake', () => {
  assert.equal(isSpamToken({ symbol: 'USDT', name: 'Tether USD', address: RANDOM }, 1), true);
});
test('...unless the indexer prices it, or it is a known legitimate variant', () => {
  assert.equal(isSpamToken({ symbol: 'USDT', name: 'Tether USD', address: RANDOM, indexerPrice: 1 }, 1), false);
  const variant = [...LEGIT_VARIANTS][0];
  if (variant) assert.equal(isSpamToken({ symbol: 'USDC', name: 'USD Coin', address: variant }, 1), false);
});
test('forged names: invisible characters and look-alike letters', () => {
  assert.equal(looksForged('U⁯S⁯DT'), true);
  assert.equal(looksForged('USDΤ'), true); // Greek Tau
  assert.equal(looksForged('USDT'), false);
  assert.equal(isSpamToken({ symbol: 'USDΤ', name: 'Tether', address: RANDOM }), true);
});
test('advertising names', () => {
  for (const name of ['Visit claim-usdc.com', 'Airdrop reward', '$5000 voucher', 'go to www.x.io'])
    assert.equal(isSpamToken({ symbol: 'X', name }), true, name);
  assert.equal(isSpamToken({ symbol: 'PEPE', name: 'Pepe' }), false);
  assert.equal(isSpamToken({ symbol: 'A'.repeat(21), name: 'Long' }), true);
});
