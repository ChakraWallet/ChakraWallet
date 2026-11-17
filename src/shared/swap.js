// Best-price swap: queries several DEX aggregators in parallel (no API keys needed)
// and ranks quotes by net value = output value - estimated network cost.
import { NATIVE } from './chains.js';
import { t } from './i18n.js';
import { ENDPOINTS } from './endpoints.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const isNative = (a) => a.toLowerCase() === NATIVE;

// networks of each aggregator (exported: a test build adds its local networks)
export const KYBER_CHAINS = { 1: 'ethereum', 56: 'bsc', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism', 43114: 'avalanche', 8453: 'base', 59144: 'linea' };
export const PARASWAP_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 100]);
export const OPENOCEAN_CHAINS = { 1: 'eth', 56: 'bsc', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism', 43114: 'avax', 8453: 'base', 100: 'xdai', 59144: 'linea' };
export const LIFI_CHAINS = new Set([1, 10, 56, 100, 137, 8453, 42161, 43114, 59144]);

async function fetchJson(url, init = {}, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || json.error || json.description || `HTTP ${res.status}`);
    return json;
  } finally { clearTimeout(t); }
}

// Each provider returns { provider, amountOut, gas, spender, build(): Promise<{to,data,value}> }
const providers = {
  async KyberSwap({ chainId, tokenIn, tokenOut, amountIn, from, slippageBps }) {
    const slug = KYBER_CHAINS[chainId];
    if (!slug) return null;
    const headers = { 'x-client-id': 'Chakra' };
    const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString(), gasInclude: 'true' });
    const r = await fetchJson(`${ENDPOINTS.kyber}/${slug}/api/v1/routes?${q}`, { headers });
    const d = r.data;
    if (!d?.routeSummary) throw new Error(r.message || t('errors.swapNoRoute'));
    return {
      amountOut: BigInt(d.routeSummary.amountOut), gas: BigInt(d.routeSummary.gas || 0), spender: d.routerAddress,
      async build() {
        const b = await fetchJson(`${ENDPOINTS.kyber}/${slug}/api/v1/route/build`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ routeSummary: d.routeSummary, sender: from, recipient: from, slippageTolerance: slippageBps }),
        });
        if (!b.data?.data) throw new Error(b.message || t('errors.swapBuildFailed'));
        return { to: b.data.routerAddress, data: b.data.data, value: b.data.transactionValue ?? (isNative(tokenIn) ? amountIn.toString() : '0') };
      },
    };
  },

  async 'Velora (ParaSwap)'({ chainId, tokenIn, tokenOut, amountIn, decIn, decOut, from, slippageBps }) {
    if (!PARASWAP_CHAINS.has(chainId)) return null;
    const q = new URLSearchParams({
      srcToken: tokenIn, destToken: tokenOut, amount: amountIn.toString(), srcDecimals: decIn, destDecimals: decOut,
      side: 'SELL', network: chainId, userAddress: from, version: '6.2',
    });
    const r = await fetchJson(`${ENDPOINTS.paraswap}/prices/?${q}`);
    const pr = r.priceRoute;
    if (!pr) throw new Error(r.error || t('errors.swapNoRoute'));
    return {
      amountOut: BigInt(pr.destAmount), gas: BigInt(pr.gasCost || 0), spender: pr.tokenTransferProxy || pr.contractAddress,
      async build() {
        const b = await fetchJson(`${ENDPOINTS.paraswap}/transactions/${chainId}?ignoreChecks=true`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ srcToken: tokenIn, destToken: tokenOut, srcAmount: amountIn.toString(), slippage: slippageBps, priceRoute: pr, userAddress: from, srcDecimals: decIn, destDecimals: decOut }),
        });
        if (!b.data) throw new Error(b.error || t('errors.swapBuildFailed'));
        return { to: b.to, data: b.data, value: b.value || '0' };
      },
    };
  },

  async OpenOcean({ chainId, tokenIn, tokenOut, amountIn, from, slippageBps, gasPrice }) {
    const code = OPENOCEAN_CHAINS[chainId];
    if (!code) return null;
    const q = new URLSearchParams({
      inTokenAddress: tokenIn, outTokenAddress: tokenOut, amountDecimals: amountIn.toString(),
      gasPriceDecimals: (gasPrice || 1n).toString(), slippage: (slippageBps / 100).toString(), account: from,
    });
    const r = await fetchJson(`${ENDPOINTS.openocean}/v4/${code}/swap?${q}`);
    const d = r.data;
    if (!d?.outAmount || !d?.data) throw new Error(r.error || r.message || t('errors.swapNoRoute'));
    return {
      amountOut: BigInt(d.outAmount), gas: BigInt(d.estimatedGas || 0), spender: d.to,
      async build() { return { to: d.to, data: d.data, value: d.value || '0' }; },
    };
  },

  async 'LI.FI'({ chainId, tokenIn, tokenOut, amountIn, from, slippageBps }) {
    if (!LIFI_CHAINS.has(chainId)) return null;
    const q = new URLSearchParams({
      fromChain: chainId, toChain: chainId, fromToken: isNative(tokenIn) ? ZERO : tokenIn, toToken: isNative(tokenOut) ? ZERO : tokenOut,
      fromAmount: amountIn.toString(), fromAddress: from, slippage: (slippageBps / 10000).toString(),
    });
    const r = await fetchJson(`${ENDPOINTS.lifi}/v1/quote?${q}`, {}, 15000);
    if (!r.estimate || !r.transactionRequest) throw new Error(r.message || t('errors.swapNoRoute'));
    const gas = (r.estimate.gasCosts || []).reduce((s, g) => s + BigInt(g.estimate || g.limit || 0), 0n);
    return {
      amountOut: BigInt(r.estimate.toAmount), gas, spender: r.estimate.approvalAddress,
      async build() { const t = r.transactionRequest; return { to: t.to, data: t.data, value: t.value || '0' }; },
    };
  },
};

export function swapSupported(chainId) {
  return !!(KYBER_CHAINS[chainId] || PARASWAP_CHAINS.has(chainId) || OPENOCEAN_CHAINS[chainId] || LIFI_CHAINS.has(chainId));
}

/**
 * params: {chainId, tokenIn, tokenOut, amountIn (bigint), decIn, decOut, from, slippageBps, gasPrice (bigint wei),
 *          priceOut (USD per tokenOut unit|null), nativePrice (USD|null)}
 * returns {quotes: [...sorted best first], errors: [{provider, error}]}
 */
export async function getQuotes(params) {
  const p = { ...params, tokenIn: params.tokenIn.toLowerCase(), tokenOut: params.tokenOut.toLowerCase() };
  const SERVICE = { KyberSwap: 'kyber', 'Velora (ParaSwap)': 'paraswap', OpenOcean: 'openocean', 'LI.FI': 'lifi' };
  const entries = Object.entries(providers).filter(([name]) => ENDPOINTS[SERVICE[name]]); // services switched off: skipped
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn(p)));
  const quotes = [], errors = [];
  settled.forEach((s, i) => {
    const name = entries[i][0];
    if (s.status === 'fulfilled' && s.value) {
      const q = { provider: name, ...s.value };
      const outFloat = Number(q.amountOut) / 10 ** p.decOut;
      q.outUsd = p.priceOut != null ? outFloat * p.priceOut : null;
      q.gasCostWei = q.gas * (p.gasPrice || 0n);
      q.gasUsd = p.nativePrice != null ? (Number(q.gasCostWei) / 1e18) * p.nativePrice : null;
      q.netUsd = q.outUsd != null && q.gasUsd != null ? q.outUsd - q.gasUsd : null;
      q.minOut = (q.amountOut * BigInt(10000 - p.slippageBps)) / 10000n;
      quotes.push(q);
    } else if (s.status === 'rejected') {
      errors.push({ provider: name, error: s.reason?.message || String(s.reason) });
    }
  });
  const allNet = quotes.every((q) => q.netUsd != null);
  quotes.sort((a, b) => (allNet ? b.netUsd - a.netUsd : b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return { quotes, errors };
}
