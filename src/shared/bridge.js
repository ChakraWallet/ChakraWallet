// Cross-chain transfers ("bridge"): queries LI.FI, Relay, Across and deBridge (public APIs, no keys, no fee added by
// Chakra) and ranks routes by net value = value received (+ gas top-up) - costs paid on top (source gas,
// fixed fees not already deducted from the output). Also tracks a sent transfer until it arrives.
import { NATIVE } from './chains.js';
import { erc20 } from './rpc.js';
import { t } from './i18n.js';
import { symbiosisStatus } from './ton/bridge.js';
import { ENDPOINTS } from './endpoints.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const isNative = (a) => String(a).toLowerCase() === NATIVE;
const tok = (a) => (isNative(a) ? ZERO : a);

/** Networks supported by the bridge screen (all the providers support them, except deBridge on Gnosis). */
export const BRIDGE_CHAINS = [1, 8453, 42161, 10, 137, 56, 43114, 100, 59144];
const DEBRIDGE_IDS = { 1: 1, 8453: 8453, 42161: 42161, 10: 10, 137: 137, 56: 56, 43114: 43114, 100: 100000002, 59144: 59144 };

async function fetchJson(url, init = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || json.errorMessage || json.error || `HTTP ${res.status}`);
    return json;
  } finally { clearTimeout(tm); }
}
const num = (x) => (x == null || x === '' ? null : Number(x));

// Each provider returns a route:
// { provider, tool, amountOut, minOut, outUsd, durationSec, spender|null, tx: {to,data,value}, feesUsd, extraCostUsd,
//   gasUsd, refuel: {amount, usd}|null, ref: {...} }   (ref = what the status API needs)
const providers = {
  async 'LI.FI'(p) {
    const q = new URLSearchParams({
      fromChain: p.fromChain.id, toChain: p.toChain.id, fromToken: tok(p.fromToken), toToken: tok(p.toToken),
      fromAmount: p.amount, fromAddress: p.from, toAddress: p.to, slippage: String(p.slippageBps / 10000),
    });
    const r = await fetchJson(`${ENDPOINTS.lifi}/v1/quote?${q}`);
    const e = r.estimate;
    const fees = e.feeCosts || [];
    return {
      tool: r.toolDetails?.name || r.tool,
      amountOut: e.toAmount, minOut: e.toAmountMin, outUsd: num(e.toAmountUSD),
      durationSec: e.executionDuration,
      spender: isNative(p.fromToken) ? null : e.approvalAddress,
      tx: { to: r.transactionRequest.to, data: r.transactionRequest.data, value: r.transactionRequest.value || '0x0' },
      feesUsd: fees.reduce((s, f) => s + (num(f.amountUSD) || 0), 0),
      extraCostUsd: fees.filter((f) => f.included === false).reduce((s, f) => s + (num(f.amountUSD) || 0), 0),
      gasUsd: (e.gasCosts || []).reduce((s, g) => s + (num(g.amountUSD) || 0), 0),
      refuel: null,
      ref: { tool: r.tool },
    };
  },

  async Relay(p) {
    const body = {
      user: p.from, recipient: p.to, originChainId: p.fromChain.id, destinationChainId: p.toChain.id,
      originCurrency: tok(p.fromToken), destinationCurrency: tok(p.toToken), amount: p.amount,
      tradeType: 'EXACT_INPUT', slippageTolerance: String(p.slippageBps),
      ...(p.refuel ? { topupGas: true } : {}),
    };
    const r = await fetchJson(`${ENDPOINTS.relay}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const steps = r.steps || [];
    const deposit = steps.find((s) => s.id === 'deposit') || steps[steps.length - 1];
    const approve = steps.find((s) => s.id === 'approve');
    if (!deposit?.items?.[0]?.data) throw new Error(t('errors.bridgeNoRoute'));
    if (steps.some((s) => s.kind === 'signature')) throw new Error(t('errors.bridgeNoRoute')); // only plain transactions
    let spender = null;
    if (approve?.items?.[0]?.data) {
      try { spender = erc20.decodeFunctionData('approve', approve.items[0].data.data)[0]; } catch { /* no approval needed */ }
    }
    const d = r.details, fee = r.fees || {};
    const out = d.currencyOut;
    const top = d.currencyGasTopup;
    return {
      tool: 'Relay',
      amountOut: out.amount, minOut: out.minimumAmount || out.amount, outUsd: num(out.amountUsd),
      durationSec: d.timeEstimate,
      spender,
      tx: { to: deposit.items[0].data.to, data: deposit.items[0].data.data, value: deposit.items[0].data.value || '0' },
      feesUsd: num(fee.relayer?.amountUsd) || 0,
      extraCostUsd: 0,
      gasUsd: num(fee.gas?.amountUsd) || 0,
      refuel: top && top.amount !== '0' ? { amount: top.amount, usd: num(top.amountUsd), symbol: top.currency?.symbol, decimals: top.currency?.decimals } : null,
      ref: { requestId: deposit.requestId || r.requestId },
    };
  },

  async Across(p) {
    const q = new URLSearchParams({
      tradeType: 'exactInput', amount: p.amount, inputToken: tok(p.fromToken), originChainId: p.fromChain.id,
      outputToken: tok(p.toToken), destinationChainId: p.toChain.id, depositor: p.from, recipient: p.to,
      slippageTolerance: String(p.slippageBps / 100),
    });
    const r = await fetchJson(`${ENDPOINTS.across}/api/swap/approval?${q}`);
    if (!r.swapTx?.to) throw new Error(t('errors.bridgeNoRoute'));
    return {
      tool: 'Across',
      amountOut: r.expectedOutputAmount, minOut: r.minOutputAmount || r.expectedOutputAmount, outUsd: null, // derived below
      durationSec: r.expectedFillTime,
      spender: isNative(p.fromToken) ? null : r.checks?.allowance?.spender || r.swapTx.to,
      tx: { to: r.swapTx.to, data: r.swapTx.data, value: r.swapTx.value || '0' },
      feesUsd: num(r.fees?.total?.amountUsd) || 0,
      extraCostUsd: 0,
      gasUsd: 0,
      refuel: null,
      ref: { depositTxHash: true },
    };
  },

  async deBridge(p) {
    const src = DEBRIDGE_IDS[p.fromChain.id], dst = DEBRIDGE_IDS[p.toChain.id];
    if (!src || !dst) return null;
    const q = new URLSearchParams({
      srcChainId: src, srcChainTokenIn: tok(p.fromToken), srcChainTokenInAmount: p.amount,
      dstChainId: dst, dstChainTokenOut: tok(p.toToken), dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: p.to, senderAddress: p.from,
      srcChainOrderAuthorityAddress: p.from, dstChainOrderAuthorityAddress: p.to, prependOperatingExpenses: 'true',
    });
    const r = await fetchJson(`${ENDPOINTS.debridge}/v1.0/dln/order/create-tx?${q}`);
    const out = r.estimation.dstChainTokenOut;
    // fixed fee paid in the source network's currency on top of the amount
    const fixUsd = p.nativePrice != null && r.fixFee ? (Number(r.fixFee) / 10 ** p.fromChain.native.decimals) * p.nativePrice : 0;
    return {
      tool: 'deBridge',
      amountOut: out.amount, minOut: out.amount, outUsd: num(out.approximateUsdValue),
      durationSec: r.order?.approximateFulfillmentDelay,
      spender: isNative(p.fromToken) ? null : r.tx.to,
      tx: { to: r.tx.to, data: r.tx.data, value: r.tx.value || '0' },
      feesUsd: fixUsd + (num(r.protocolFeeApproximateUsdValue) || 0),
      extraCostUsd: fixUsd,
      gasUsd: 0,
      refuel: null,
      ref: { orderId: r.orderId },
    };
  },
};

/**
 * params: { fromChain, toChain, fromToken, toToken, amount (raw string), from, to, slippageBps, refuel, nativePrice }
 * returns { quotes: [...] best first (each with netUsd), errors: [{provider, error}] }
 */
export async function getBridgeQuotes(params) {
  const SERVICE = { 'LI.FI': 'lifi', Relay: 'relay', Across: 'across', deBridge: 'debridge' };
  const entries = Object.entries(providers).filter(([name]) => ENDPOINTS[SERVICE[name]]); // services switched off: skipped
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn(params)));
  const quotes = [], errors = [];
  settled.forEach((s, i) => {
    const provider = entries[i][0];
    if (s.status === 'fulfilled' && s.value && BigInt(s.value.amountOut || 0) > 0n) {
      const q = { provider, ...s.value };
      q.netUsd = q.outUsd != null ? q.outUsd + (q.refuel?.usd || 0) - (q.gasUsd || 0) - (q.extraCostUsd || 0) : null;
      quotes.push(q);
    } else if (s.status === 'rejected') errors.push({ provider, error: s.reason?.message || String(s.reason) });
  });
  // routes without a USD value (Across): use the unit price of the same output token from the other routes
  const priced = quotes.find((q) => q.outUsd != null && BigInt(q.amountOut) > 0n);
  for (const q of quotes) {
    if (q.outUsd != null || !priced) continue;
    q.outUsd = (Number(q.amountOut) / Number(priced.amountOut)) * priced.outUsd;
    q.netUsd = q.outUsd + (q.refuel?.usd || 0) - (q.gasUsd || 0) - (q.extraCostUsd || 0);
  }
  // best net value first; without prices, the biggest output
  quotes.sort((a, b) => (a.netUsd != null && b.netUsd != null ? b.netUsd - a.netUsd : (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : -1)));
  return { quotes, errors };
}

/** Requote one provider (quotes expire; e.g. after the approval transaction). */
export async function requote(provider, params) {
  const r = await providers[provider](params);
  if (!r) throw new Error(t('errors.bridgeNoRoute'));
  return { provider, ...r };
}

/**
 * Status of a sent transfer: 'pending' | 'done' | 'refunded' | 'failed', plus the destination tx hash when known.
 * entry: { provider, txHash, fromChainId, toChainId, ref }
 */
export async function bridgeStatus(entry) {
  if (entry.provider === 'LI.FI') {
    const q = new URLSearchParams({ txHash: entry.txHash, fromChain: entry.fromChainId, toChain: entry.toChainId, ...(entry.ref?.tool ? { bridge: entry.ref.tool } : {}) });
    const r = await fetchJson(`${ENDPOINTS.lifi}/v1/status?${q}`);
    if (r.status === 'DONE') return { status: r.substatus === 'REFUNDED' ? 'refunded' : 'done', destTxHash: r.receiving?.txHash };
    if (r.status === 'FAILED' || r.status === 'INVALID') return { status: 'failed' };
    return { status: 'pending' };
  }
  if (entry.provider === 'Relay') {
    const r = await fetchJson(`${ENDPOINTS.relay}/intents/status/v2?requestId=${entry.ref.requestId}`);
    if (r.status === 'success') return { status: 'done', destTxHash: r.txHashes?.[r.txHashes.length - 1] };
    if (r.status === 'refund') return { status: 'refunded' };
    if (r.status === 'failure') return { status: 'failed' };
    return { status: 'pending' };
  }
  if (entry.provider === 'Across') {
    const r = await fetchJson(`${ENDPOINTS.across}/api/deposit/status?originChainId=${entry.fromChainId}&depositTxHash=${entry.txHash}`);
    if (r.status === 'filled') return { status: 'done', destTxHash: r.fillTx || r.fillTxHash };
    if (r.status === 'refunded' || r.status === 'expired') return { status: 'refunded' };
    return { status: 'pending' };
  }
  if (entry.provider === 'Symbiosis') return symbiosisStatus(entry); // EVM <-> TON (Android app)
  if (entry.provider === 'deBridge') {
    try {
      const r = await fetchJson(`${ENDPOINTS.debridge}/v1.0/dln/order/${entry.ref.orderId}/status`);
      if (['Fulfilled', 'SentUnlock', 'ClaimedUnlock'].includes(r.status)) return { status: 'done' };
      if (['OrderCancelled', 'SentOrderCancel', 'ClaimedOrderCancel'].includes(r.status)) return { status: 'refunded' };
      return { status: 'pending' };
    } catch { return { status: 'pending' }; } // not indexed yet
  }
  return { status: 'pending' };
}

/**
 * Any bridge transaction (also one not made with Chakra, e.g. from a site or another wallet): asks the
 * services that know it (Relay, LI.FI, deBridge) where it went. Only the transaction hash is sent.
 * Returns { provider, fromChainId, toChainId, status, destTxHash, tool } or null if none of them knows it.
 */
const DEBRIDGE_BACK = Object.fromEntries(Object.entries(DEBRIDGE_IDS).map(([k, v]) => [String(v), Number(k)]));
export async function lookupBridge(chainId, hash) {
  try {
    const r = await fetchJson(`${ENDPOINTS.relay}/requests/v2?hash=${hash}`, {}, 12000);
    const q = r.requests?.[0];
    if (q) {
      const out = q.data?.outTxs?.[0];
      const st = { success: 'done', refund: 'refunded', failure: 'failed' }[q.status] || 'pending';
      return { provider: 'Relay', fromChainId: chainId, toChainId: out?.chainId ?? q.data?.currencyOut?.currency?.chainId ?? null, status: st, destTxHash: out?.hash || null };
    }
  } catch { /* next */ }
  try {
    const r = await fetchJson(`${ENDPOINTS.lifi}/v1/status?txHash=${hash}&fromChain=${chainId}`, {}, 12000);
    if (r.status && r.status !== 'NOT_FOUND') {
      const st = r.status === 'DONE' ? (r.substatus === 'REFUNDED' ? 'refunded' : 'done') : r.status === 'FAILED' ? 'failed' : 'pending';
      return { provider: 'LI.FI', tool: r.tool, fromChainId: chainId, toChainId: r.receiving?.chainId ?? r.toChain ?? null, status: st, destTxHash: r.receiving?.txHash || null };
    }
  } catch { /* next */ }
  try {
    const r = await fetchJson(`${ENDPOINTS.across}/api/deposit/status?originChainId=${chainId}&depositTxHash=${hash}`, {}, 12000);
    if (r.status && r.destinationChainId) {
      const st = r.status === 'filled' ? 'done' : r.status === 'refunded' || r.status === 'expired' ? 'refunded' : 'pending';
      return { provider: 'Across', fromChainId: chainId, toChainId: Number(r.destinationChainId), status: st, destTxHash: r.fillTx || null };
    }
  } catch { /* next */ }
  try {
    const ids = await fetchJson(`${ENDPOINTS.debridgeStats}/api/Transaction/${hash}/orderIds`, {}, 12000);
    const id = ids.orderIds?.[0]?.stringValue || ids.orderIds?.[0];
    if (id) {
      const o = await fetchJson(`${ENDPOINTS.debridgeStats}/api/Orders/${id}`, {}, 12000);
      const dst = o.takeOfferWithMetadata?.chainId?.bigIntegerValue ?? o.takeOfferWithMetadata?.chainId;
      const st = /Fulfilled|Unlock/.test(o.state) ? 'done' : /Cancel/.test(o.state) ? 'refunded' : 'pending';
      return { provider: 'deBridge', fromChainId: chainId, toChainId: DEBRIDGE_BACK[String(dst)] ?? Number(dst) ?? null, status: st };
    }
  } catch { /* unknown */ }
  return null;
}
