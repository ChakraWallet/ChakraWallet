import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpamToken, looksForged, suspectToken } from '../src/shared/portfolio.js';
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

test('token pickers: tokens named like well-known ones with no value are marked as possible spam', () => {
  const R = '0x00000000000000000000000000000000000000a1';
  assert.equal(suspectToken({ ...usdt, price: 1 }, 1), false, 'the real USDT');
  assert.equal(suspectToken({ native: true, symbol: 'ETH' }, 1), false);
  assert.equal(suspectToken({ symbol: 'USDT', name: 'Tether USD', address: RANDOM, price: null }, 1), true, 'a copy of USDT');
  assert.equal(suspectToken({ symbol: 'USDT.e', name: 'Tether', address: R, price: null }, 1), true, 'named like USDT, no price');
  assert.equal(suspectToken({ symbol: 'ETHG', name: 'Ethereum Gold', address: R, price: null }, 1), true);
  assert.equal(suspectToken({ symbol: 'ETHG', name: 'Ethereum Gold', address: R, price: 0.4 }, 1), false, 'it has a market price');
  assert.equal(suspectToken({ symbol: 'PEPE', name: 'Pepe', address: R, price: null }, 1), false, 'not named like a well-known token');
  assert.equal(suspectToken({ symbol: 'USDT', name: 'Tether USD', address: R, price: null, custom: true }, 1), false, 'added by the user');
});
