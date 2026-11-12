// Balances: native + ERC-20 tokens (auto-discovered through a free indexer when available).
import { rpc, multiCall, erc20 } from './rpc.js';
import { getPrices, tokenPriceKey } from './prices.js';
import { POPULAR_TOKENS, LEGIT_VARIANTS } from './tokens.js';
import { toFloat } from './format.js';

import { getJson as httpJson } from './http.js';

const getJson = (url, timeout = 25000) => httpJson(url, { timeout, label: 'Indexer HTTP' });

export function etherscanUrl(chain, params, key) {
  const u = new URL(chain.indexer.url);
  if (chain.indexer.url.includes('etherscan.io/v2')) u.searchParams.set('chainid', chain.id);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (key && chain.indexer.url.includes('etherscan.io')) u.searchParams.set('apikey', key); // the key goes to Etherscan only
  return u.toString();
}

async function discoverTokens(chain, address, etherscanKey, timeout = 25000) {
  const idx = chain.indexer;
  if (!idx) return [];
  if (idx.type === 'blockscout') {
    const list = (await getJson(`${idx.url}/api/v2/addresses/${address}/token-balances`, timeout)) || [];
    return list
      .filter((x) => (x.token?.type || 'ERC-20') === 'ERC-20')
      .map((x) => ({
        address: String(x.token.address_hash || x.token.address).toLowerCase(),
        symbol: x.token.symbol || '???', name: x.token.name || '', decimals: Number(x.token.decimals ?? 18),
        // the indexer's balance can lag minutes behind (a just-received transfer is missing): it is only a
        // fallback, the balance shown is read on-chain below
        indexerBalance: BigInt(x.value || 0), icon: x.token.icon_url || '',
        indexerPrice: x.token.exchange_rate ? Number(x.token.exchange_rate) : null,
      }));
  }
  if (idx.type === 'etherscan') {
    if (idx.needsKey && !etherscanKey) return [];
    const json = await getJson(etherscanUrl(chain, { module: 'account', action: 'tokentx', address, page: 1, offset: 200, sort: 'desc' }, etherscanKey), timeout);
    const seen = new Map();
    for (const t of Array.isArray(json?.result) ? json.result : []) {
      const a = t.contractAddress.toLowerCase();
      if (!seen.has(a)) seen.set(a, { address: a, symbol: t.tokenSymbol, name: t.tokenName, decimals: Number(t.tokenDecimal || 18) });
    }
    return [...seen.values()]; // balances fetched on-chain below
  }
  return [];
}

// primary indexer; if it fails (or takes > 10 s) and the network has an alternative, that one
async function discoverWithFallback(chain, address, etherscanKey) {
  if (!chain.altIndexer) return discoverTokens(chain, address, etherscanKey);
  try { return await discoverTokens(chain, address, etherscanKey, 10000); } catch {
    return discoverTokens({ ...chain, indexer: chain.altIndexer }, address, etherscanKey);
  }
}

const SPAM_RE = /(https?:|www\.|\.(com|io|net|org|xyz|site|website|online|app|fi|finance|top|live|pro|vip|cc|me|gift|claim|link|club|info|co|to|lat|icu|run)\b|claim|reward|airdrop|visit|voucher|\$\s?\d|[\u{1F300}-\u{1FAFF}✅\u{1F7E2}])/iu;
// Forged names used by address-poisoning tokens: invisible characters, or look-alike letters from other
// alphabets mixed with Latin ones (e.g. "U⁯S⁯DΤ" with a Greek Tau, "ሀЅDT").
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/;
const FOREIGN = /[\u0370-\u03FF\u0400-\u052F\u0530-\u058F\u1200-\u137F\u13A0-\u13FF\u1D00-\u1DBF\uFF00-\uFFEF]/;
const CONFUSABLE = { Α: 'A', Β: 'B', Ε: 'E', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', Ζ: 'Z', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J', ሀ: 'U', а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', ѕ: 's', і: 'i', հ: 'h', г: 'r' };
const plain = (s) => String(s || '').replace(INVISIBLE, '').replace(/[\s\S]/g, (c) => CONFUSABLE[c] || c).replace(/[\u200B-\u206F\uFEFF]/g, '');
export const looksForged = (s) => INVISIBLE.test(s || '') || (/[A-Za-z]/.test(s || '') && FOREIGN.test(s || ''));

/** chainId (optional): a token named like a well-known token of that network but at another address is a fake. */
export function isSpamToken(t, chainId) {
  const text = `${t.symbol || ''} ${t.name || ''}`;
  if (SPAM_RE.test(text) || (t.symbol || '').length > 20 || looksForged(t.symbol) || looksForged(t.name)) return true;
  if (chainId != null && (t.address !== undefined || t.token !== undefined) && !t.indexerPrice) {
    const addr = String(t.address || t.token || '').toLowerCase();
    const sym = plain(t.symbol).toUpperCase();
    const real = (POPULAR_TOKENS[chainId] || []).filter((p) => p.symbol.toUpperCase() === sym);
    if (real.length && !real.some((p) => p.address === addr) && !LEGIT_VARIANTS.has(addr)) return true;
  }
  return false;
}

export async function loadPortfolio(chain, address, { customTokens = [], hiddenTokens = [], etherscanKey = '' } = {}) {
  let indexerOk = true, indexerError = '';
  const [nativeRaw, discovered] = await Promise.all([
    rpc(chain, 'eth_getBalance', [address, 'latest']).then(BigInt),
    discoverWithFallback(chain, address, etherscanKey).catch((e) => { indexerOk = false; indexerError = e?.name === 'TimeoutError' ? 'timeout 25s' : e?.message || String(e); return []; }),
  ]);

  const map = new Map();
  for (const t of discovered) map.set(t.address, t);
  // well-known tokens are always checked on-chain too: public indexers can be incomplete or lagging
  // (e.g. a Blockscout instance answering "no tokens" for an address that holds USDC)
  const extra = [...customTokens, ...(POPULAR_TOKENS[chain.id] || [])];
  for (const t of extra) {
    if (!map.has(t.address)) map.set(t.address, { ...t, custom: customTokens.includes(t) });
    else if (!map.get(t.address).icon && t.icon) map.get(t.address).icon = t.icon; // indexer without an icon
  }
  for (const t of customTokens) if (map.has(t.address)) map.get(t.address).custom = true;

  // on-chain balances for tokens that don't have one yet
  const needBalance = [...map.values()].filter((t) => t.balance === undefined);
  const results = await multiCall(chain, needBalance.map((t) => ({ to: t.address, data: erc20.encodeFunctionData('balanceOf', [address]) })));
  needBalance.forEach((t, i) => { t.balance = results[i] ? BigInt(results[i]) : (t.indexerBalance ?? 0n); });

  const hidden = new Set(hiddenTokens);
  let tokens = [...map.values()].filter((t) => !hidden.has(t.address) && (t.balance > 0n || t.custom));

  // Spam filter: airdropped tokens advertising websites / claims are never priced
  tokens = tokens.map((t) => ({ ...t, spam: !t.custom && isSpamToken(t, chain.id) }));
  // Price source: indexer price (CoinGecko-backed) first; DefiLlama only for tokens without it
  // that are trusted (custom/popular) or when the indexer gives no prices at all (etherscan-type).
  const popular = new Set((POPULAR_TOKENS[chain.id] || []).map((t) => t.address));
  const askLlama = tokens.filter((t) => !t.spam && t.indexerPrice == null && (t.custom || popular.has(t.address) || chain.indexer?.type !== 'blockscout')).slice(0, 200);
  const keys = [chain.native.priceId, ...askLlama.map((t) => tokenPriceKey(chain, t.address))];
  const prices = chain.testnet ? {} : await getPrices(keys);
  const nativePrice = prices[chain.native.priceId] ?? null;
  const nativeAmount = toFloat(nativeRaw, chain.native.decimals);

  tokens = tokens.map(({ indexerBalance, ...t }) => { // no BigInt in the result: it is cached as JSON
    const price = t.spam ? null : t.indexerPrice ?? prices[tokenPriceKey(chain, t.address)] ?? null;
    const amount = toFloat(t.balance, t.decimals);
    return { ...t, balance: t.balance.toString(), price, amount, usd: price !== null ? amount * price : null };
  }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);

  const nativeUsd = nativePrice !== null ? nativeAmount * nativePrice : null;
  const totalUsd = (nativeUsd || 0) + tokens.reduce((s, t) => s + (t.usd || 0), 0);
  return {
    native: { balance: nativeRaw.toString(), amount: nativeAmount, price: nativePrice, usd: nativeUsd },
    tokens,
    totalUsd,
    indexerOk,
    indexerError,
    noIndexer: !chain.indexer || (chain.indexer.needsKey && !etherscanKey),
    updated: Date.now(),
  };
}
