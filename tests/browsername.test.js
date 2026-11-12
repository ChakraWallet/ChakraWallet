import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortName } from '../src/ui/screens/browser.jsx';

test('short names for bookmark tiles', () => {
  assert.equal(shortName('Polymarket | Il più grande mercato predittivo al mondo™', 'https://polymarket.com/'), 'Polymarket');
  assert.equal(shortName('Perps – Futures perpetui | Polymarket', 'https://polymarket.com/perps'), 'Polymarket');
  assert.equal(shortName('Uniswap | Trade Crypto on DeFi’s Leading Exchange', 'https://app.uniswap.org/'), 'Uniswap');
  assert.equal(shortName('Uniswap Interface', 'https://app.uniswap.org/'), 'Uniswap Interface');
  assert.equal(shortName('Aave - Open Source Liquidity Protocol', 'https://app.aave.com'), 'Aave');
  assert.equal(shortName('', 'https://www.example.org/x'), 'example.org');
  assert.equal(shortName('Docs: getting started', 'https://foo.dev'), 'Docs');
  assert.equal(shortName('Pay-as-you-go plans', 'https://bar.io'), 'Pay-as-you-go plans', 'a dash inside a word is not a separator');
});
