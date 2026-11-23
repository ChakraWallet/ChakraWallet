import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortName, toUrl } from '../src/ui/screens/browser.jsx';
import { SEARCH_ENGINES, searchUrl } from '../src/ui/searchEngines.js';

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

test('address bar: addresses open as typed, the rest is searched on the chosen engine', () => {
  assert.equal(toUrl('  '), null);
  assert.equal(toUrl('https://app.uniswap.org/swap'), 'https://app.uniswap.org/swap');
  assert.equal(toUrl('uniswap.org'), 'https://uniswap.org');
  assert.equal(toUrl('localhost:8545'), 'https://duckduckgo.com/?q=localhost%3A8545', 'no dot: a search');
  assert.equal(toUrl('eth price'), 'https://duckduckgo.com/?q=eth%20price', 'default: DuckDuckGo');
  assert.equal(toUrl('eth price', 'nope'), 'https://duckduckgo.com/?q=eth%20price', 'unknown engine: the default');
  assert.equal(toUrl('a&b?', 'google'), 'https://www.google.com/search?q=a%26b%3F');
  assert.equal(toUrl('x', 'startpage'), 'https://www.startpage.com/sp/search?query=x');
  for (const e of SEARCH_ENGINES) assert.ok(new URL(searchUrl(e.id, 'q')).protocol === 'https:', e.id);
});
