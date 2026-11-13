// Demo replacement of src/shared/portfolio.js: loadPortfolio returns invented balances, the rest is the real module.
export * from '../../../src/shared/portfolio.js';
import { HOLDINGS, PRICES, accountIndex } from './data.js';
import { POPULAR_TOKENS } from '../../../src/shared/tokens.js';

export async function loadPortfolio(chain, address) {
  await new Promise((r) => setTimeout(r, 150));
  const h = HOLDINGS[await accountIndex(address)]?.[chain.id] || { native: 0, tokens: [] };
  const nativePrice = chain.testnet ? null : PRICES[chain.native.priceId] ?? null;
  const tokens = h.tokens.map((t) => {
    const balance = BigInt(Math.round(t.amount * 10 ** Math.min(t.decimals, 8))) * 10n ** BigInt(Math.max(0, t.decimals - 8));
    const icon = (POPULAR_TOKENS[chain.id] || []).find((p) => p.address === t.address)?.icon || '';
    return { ...t, icon, balance: balance.toString(), usd: t.amount * t.price, spam: false, custom: false };
  }).sort((a, b) => b.usd - a.usd);
  const nativeUsd = nativePrice != null ? h.native * nativePrice : null;
  const nativeRaw = BigInt(Math.round(h.native * 1e8)) * 10n ** 10n;
  return {
    native: { balance: nativeRaw.toString(), amount: h.native, price: nativePrice, usd: nativeUsd },
    tokens,
    totalUsd: (nativeUsd || 0) + tokens.reduce((s, t) => s + t.usd, 0),
    indexerOk: true, indexerError: '', noIndexer: false, updated: Date.now(),
  };
}
