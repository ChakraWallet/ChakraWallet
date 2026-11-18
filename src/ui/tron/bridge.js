// Bridges between EVM networks and Tron: Relay, deBridge and LI.FI, quoted together and ranked like the other routes
// (public APIs, no keys, no fee added by Chakra). On Tron only TRX and USDT. Out of Tron the services describe a
// contract call, which is checked (the account's own, to the expected contract) and built here with a fresh block
// reference, after an approval of the exact amount when a token leaves (Relay's USDT needs none: a plain transfer to
// its depository); into Tron an EVM transaction, after an approval of the exact amount when the source is a token.
// The routes were checked with real quotes (both directions) before writing this.
import { t } from '../../shared/i18n.js';
import { NATIVE, isEvm } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { ENDPOINTS } from '../../shared/endpoints.js';
import { BRIDGE_CHAINS } from '../../shared/bridge.js';
import { erc20 } from '../../shared/rpc.js';
import { toBase58, fromEvmAddress } from '../../shared/tron/core.js';
import { decodeRawData, encodeRawData } from '../../shared/tron/proto.js';
import { TRON_CHAINS, TRON_MAINNET, isTron, constantCall, trc20Data, trc20Read, chainParams } from '../../shared/tron/api.js';
import { USDT } from '../../shared/tron/tokens.js';
import { resourceState, costOf, bandwidthBytes, feeLimitFor } from '../../shared/tron/fees.js';
import { approvalStep, txStep } from '../chains/evm.js';
import { sendContract } from './tx.js';

export const TRON_ID = 728126428; // Relay and LI.FI
export const DEBRIDGE_TRON = 100000026;
const TRX_ID = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // TRX in the three services
const ZERO = '0x0000000000000000000000000000000000000000';
const DEBRIDGE_IDS = { 1: 1, 8453: 8453, 42161: 42161, 10: 10, 137: 137, 56: 56, 43114: 43114, 100: 100000002, 59144: 59144 };
const LIFI_DIAMOND = 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt'; // LI.FI's contract on Tron (its chains list)
const num = (x) => (x == null || x === '' ? null : Number(x));
const NO_REF = { ref_block_bytes: '0000', ref_block_hash: '0000000000000000' };

async function fetchJson(url, init = {}, timeout = 25000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.errorMessage || json.error || `HTTP ${res.status}`);
  return json;
}

/** What a route can move on Tron: TRX and USDT. */
export const tronBridgeTokens = () => [
  { address: NATIVE, symbol: 'TRX', name: 'Tron', decimals: 6, native: true },
  { address: USDT, symbol: 'USDT', name: 'Tether USD', decimals: 6, known: true },
];

/** p (internal): { out (Tron -> EVM), evmChain, trToken, evmToken, amount, trAddress, evmAddress, slippageBps, refuel, trxPrice } */
const sides = (p) => {
  const trCur = p.trToken.native ? TRX_ID : p.trToken.address;
  const evmCur = p.evmToken.native || p.evmToken.address === NATIVE ? ZERO : p.evmToken.address;
  return p.out ? { fromCur: trCur, toCur: evmCur, from: p.trAddress, to: p.evmAddress } : { fromCur: evmCur, toCur: trCur, from: p.evmAddress, to: p.trAddress };
};

/** A contract call a service describes on Tron (addresses in any form) -> the app's contract, checked to be the account's own. */
function tronCall(param, me) {
  const owner = toBase58(param.owner_address);
  if (owner && owner !== me) throw new Error(t('errors.bridgeNoRoute'));
  return {
    type: 'TriggerSmartContract',
    parameter: { owner_address: me, contract_address: toBase58(param.contract_address), call_value: BigInt(param.call_value || 0), data: String(param.data || '').replace(/^0x/, '') },
  };
}

const providers = {
  async Relay(p) {
    const s = sides(p);
    const body = {
      user: s.from, recipient: s.to, originChainId: p.out ? TRON_ID : p.evmChain.id, destinationChainId: p.out ? p.evmChain.id : TRON_ID,
      originCurrency: s.fromCur, destinationCurrency: s.toCur, amount: p.amount, tradeType: 'EXACT_INPUT', slippageTolerance: String(p.slippageBps),
      // USDT out of Tron: one transfer to Relay's depository with the order id appended (no approval)
      ...(p.out && !p.trToken.native ? { explicitDeposit: false } : {}),
      ...(p.refuel && p.out ? { topupGas: true } : {}),
    };
    const r = await fetchJson(`${ENDPOINTS.relay}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const steps = r.steps || [];
    if (steps.some((x) => x.kind === 'signature')) throw new Error(t('errors.bridgeNoRoute'));
    const deposit = steps.find((x) => x.id === 'deposit') || steps[steps.length - 1];
    const data = deposit?.items?.[0]?.data;
    if (!data) throw new Error(t('errors.bridgeNoRoute'));
    let exec;
    if (p.out) {
      const contract = tronCall(data.parameter || {}, p.trAddress);
      const approveStep = steps.find((x) => x.id === 'approve')?.items?.[0]?.data?.parameter;
      // without an approval a token leaves with a transfer: a call to that very token (TRX goes to Relay's depository)
      if (!p.trToken.native && !approveStep && contract.parameter.contract_address !== p.trToken.address) throw new Error(t('errors.bridgeNoRoute'));
      exec = { kind: 'tron', contract, approve: approveStep ? approvalOf(approveStep, p) : null };
    } else {
      let spender = null;
      const approve = steps.find((x) => x.id === 'approve');
      if (approve?.items?.[0]?.data) { try { spender = erc20.decodeFunctionData('approve', approve.items[0].data.data)[0]; } catch { /* none */ } }
      exec = { kind: 'evm', tx: { to: data.to, data: data.data, value: data.value || '0' }, spender };
    }
    const d = r.details || {}, out = d.currencyOut || {}, top = d.currencyGasTopup;
    return {
      tool: 'Relay', amountOut: out.amount, minOut: out.minimumAmount || out.amount, outUsd: num(out.amountUsd), durationSec: d.timeEstimate,
      feesUsd: (num(r.fees?.relayer?.amountUsd) || 0) + (num(r.fees?.gas?.amountUsd) || 0), extraCostUsd: 0, gasUsd: 0,
      refuel: top && top.amount && top.amount !== '0' ? { amount: top.amount, usd: num(top.amountUsd), symbol: top.currency?.symbol, decimals: top.currency?.decimals } : null,
      ref: { requestId: deposit.requestId || r.requestId }, exec,
    };
  },

  async deBridge(p) {
    const s = sides(p);
    const evmId = DEBRIDGE_IDS[p.evmChain.id];
    if (!evmId) return null;
    const q = new URLSearchParams({
      srcChainId: p.out ? DEBRIDGE_TRON : evmId, srcChainTokenIn: s.fromCur, srcChainTokenInAmount: p.amount,
      dstChainId: p.out ? evmId : DEBRIDGE_TRON, dstChainTokenOut: s.toCur, dstChainTokenOutAmount: 'auto', dstChainTokenOutRecipient: s.to,
      senderAddress: s.from, srcChainOrderAuthorityAddress: s.from, dstChainOrderAuthorityAddress: s.to, prependOperatingExpenses: 'true',
    });
    const r = await fetchJson(`${ENDPOINTS.debridge}/v1.0/dln/order/create-tx?${q}`);
    const out = r.estimation?.dstChainTokenOut;
    if (!out || !r.tx?.data) throw new Error(t('errors.bridgeNoRoute'));
    const srcDecimals = p.out ? 6 : p.evmChain.native.decimals;
    const srcPrice = p.out ? p.trxPrice : p.evmPrice;
    const fixUsd = srcPrice != null && r.fixFee ? (Number(r.fixFee) / 10 ** srcDecimals) * srcPrice : 0;
    let exec;
    if (p.out) {
      // an EVM-style { to, data, value }: the same call on Tron (value: TRX, fixed fee included)
      const to = fromEvmAddress(r.tx.to);
      const contract = { type: 'TriggerSmartContract', parameter: { owner_address: p.trAddress, contract_address: to, call_value: BigInt(r.tx.value || 0), data: String(r.tx.data).replace(/^0x/, '') } };
      // the token taken is the amount with deBridge's operating costs added (prependOperatingExpenses)
      const pulled = BigInt(r.estimation?.srcChainTokenIn?.amount || p.amount);
      exec = { kind: 'tron', contract, approve: p.trToken.native ? null : { token: p.trToken.address, spender: to, amount: pulled }, energyHint: Number(r.estimatedTransactionFee?.details?.gasLimit || 0) || null };
    } else {
      exec = { kind: 'evm', tx: { to: r.tx.to, data: r.tx.data, value: r.tx.value || '0' }, spender: p.evmToken.native ? null : r.tx.to };
    }
    return {
      tool: 'deBridge', amountOut: out.amount, minOut: out.amount, outUsd: num(out.approximateUsdValue), durationSec: r.order?.approximateFulfillmentDelay,
      feesUsd: fixUsd + (num(r.protocolFeeApproximateUsdValue) || 0), extraCostUsd: fixUsd, gasUsd: 0, refuel: null, ref: { orderId: r.orderId }, exec,
    };
  },

  async 'LI.FI'(p) {
    if (p.out && p.trToken.native) return null; // LI.FI moves no TRX out of Tron
    const s = sides(p);
    const q = new URLSearchParams({
      fromChain: p.out ? TRON_ID : p.evmChain.id, toChain: p.out ? p.evmChain.id : TRON_ID, fromToken: s.fromCur, toToken: s.toCur,
      fromAmount: p.amount, fromAddress: s.from, toAddress: s.to, slippage: String(p.slippageBps / 10000),
    });
    const r = await fetchJson(`${ENDPOINTS.lifi}/v1/quote?${q}`);
    const e = r.estimate, tr = r.transactionRequest;
    if (!e || !tr?.data) throw new Error(t('errors.bridgeNoRoute'));
    const fees = e.feeCosts || [];
    let exec;
    if (p.out) {
      // LI.FI builds the whole Tron transaction: read from its bytes, checked, and rebuilt here with a fresh reference
      const raw = tr.customData?.tronTransaction?.raw_data_hex || String(tr.data).replace(/^0x/, '');
      const d = decodeRawData(raw);
      const c = d.contracts[0];
      if (d.contracts.length !== 1 || c.type !== 'TriggerSmartContract' || c.parameter.owner_address !== p.trAddress || c.parameter.contract_address !== LIFI_DIAMOND) throw new Error(t('errors.bridgeNoRoute'));
      exec = { kind: 'tron', contract: tronCall(c.parameter, p.trAddress), approve: { token: p.trToken.address, spender: e.approvalAddress || LIFI_DIAMOND, amount: BigInt(p.amount) } };
    } else {
      exec = { kind: 'evm', tx: { to: tr.to, data: tr.data, value: tr.value || '0x0' }, spender: p.evmToken.native ? null : e.approvalAddress };
    }
    return {
      tool: r.toolDetails?.name || r.tool, amountOut: e.toAmount, minOut: e.toAmountMin, outUsd: num(e.toAmountUSD), durationSec: e.executionDuration,
      feesUsd: fees.reduce((x, f) => x + (num(f.amountUSD) || 0), 0), extraCostUsd: fees.filter((f) => f.included === false).reduce((x, f) => x + (num(f.amountUSD) || 0), 0),
      gasUsd: p.out ? 0 : (e.gasCosts || []).reduce((x, g) => x + (num(g.amountUSD) || 0), 0), refuel: null,
      ref: { tool: r.tool, lifiFrom: p.out ? TRON_ID : p.evmChain.id, lifiTo: p.out ? p.evmChain.id : TRON_ID }, exec,
    };
  },
};

/** Relay's approve step on Tron (when it asks one): { token, spender, amount } from its calldata. */
function approvalOf(param, p) {
  try {
    const [spender, amount] = erc20.decodeFunctionData('approve', `0x${String(param.data).replace(/^0x/, '')}`);
    return { token: toBase58(param.contract_address), spender: fromEvmAddress(spender), amount: BigInt(amount) };
  } catch { return { token: p.trToken.address, spender: null, amount: BigInt(p.amount) }; }
}

const SERVICE = { Relay: 'relay', deBridge: 'debridge', 'LI.FI': 'lifi' };

/** Every service's route, best net value first: { quotes, errors }. */
export async function tronBridgeQuotes(p) {
  const entries = Object.entries(providers).filter(([name]) => ENDPOINTS[SERVICE[name]]);
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn(p)));
  const quotes = [], errors = [];
  settled.forEach((s, i) => {
    const provider = entries[i][0];
    if (s.status === 'fulfilled' && s.value && BigInt(s.value.amountOut || 0) > 0n) {
      const q = { provider, ...s.value };
      q.netUsd = q.outUsd != null ? q.outUsd + (q.refuel?.usd || 0) - (q.gasUsd || 0) - (q.extraCostUsd || 0) : null;
      quotes.push(q);
    } else if (s.status === 'rejected') errors.push({ provider, error: s.reason?.message || String(s.reason) });
  });
  quotes.sort((a, b) => (a.netUsd != null && b.netUsd != null ? b.netUsd - a.netUsd : (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : -1)));
  return { quotes, errors };
}

/** What a contract call costs the account now: { cost, feeLimit }. */
async function costNow(chain, me, contract, energy) {
  const [res, params] = await Promise.all([resourceState(chain, me), chainParams(chain)]);
  const draft = encodeRawData({ contract, ref: NO_REF, expiration: Date.now(), timestamp: Date.now(), fee_limit: 100_000_000 });
  return { cost: costOf({ res, params, bytes: bandwidthBytes(draft), energy }), feeLimit: feeLimitFor(energy, res, params) };
}
const feeView = (c, extraRows = []) => ({ kind: 'fixed', amount: c.cost.total, decimals: 6, symbol: 'TRX', label: t('tron.fee.label'), extraRows });
const trx = (sun) => `${(Number(sun) / 1e6).toFixed(2)} TRX`;

/** Out of Tron: an approval of the exact amount when needed, then the service's contract call (renewed after it). */
async function tronSteps(quote, p, internal) {
  const chain = p.fromChain;
  const me = p.fromAddr.raw;
  const exec = quote.exec;
  const steps = [];
  const approve = exec.approve;
  if (approve?.spender) {
    const allowance = (await trc20Read(chain, approve.token, 'allowance', [me, approve.spender], me).catch(() => 0n)) ?? 0n;
    if (allowance < approve.amount) {
      const contract = { type: 'TriggerSmartContract', parameter: { owner_address: me, contract_address: approve.token, data: trc20Data('approve', [approve.spender, approve.amount]) } };
      let c;
      steps.push({
        key: 'approve', title: t('swap.step1'), note: t('tron.bridge.approveNote', { provider: quote.provider }), waitBeforeNext: true,
        async prepare() {
          const sim = await constantCall(chain, { owner: me, contract: approve.token, data: contract.parameter.data });
          c = await costNow(chain, me, contract, sim.energy || 30_000);
          const trxBal = BigInt((await resourceState(chain, me)).account?.balance || 0);
          const problem = !sim.ok ? t('tron.send.simFailed', { reason: sim.message }) : c.cost.total > trxBal ? t('tron.send.noTrxFee', { amount: trx(c.cost.total) }) : null;
          return { fee: feeView(c), problem: () => problem };
        },
        send: (review, { auth }) => sendContract(chain, { account: p.account, contract, feeLimit: c.feeLimit, auth: (fn) => auth(fn), title: p.title }),
      });
    }
  }
  let latest = null, c = null;
  steps.push({
    key: 'bridge', title: t('bridge.confirm'),
    async prepare() {
      // after an approval the quote may have expired: a fresh one from the same service
      if (steps.length > 1) {
        const fresh = await providers[quote.provider](internal).catch(() => null);
        if (fresh?.exec?.contract) latest = { provider: quote.provider, ...fresh };
      }
      const contract = (latest || quote).exec.contract;
      const sim = await constantCall(chain, { owner: me, contract: contract.parameter.contract_address, data: contract.parameter.data, callValue: contract.parameter.call_value });
      const energy = sim.ok && sim.energy ? sim.energy : exec.energyHint || 300_000;
      c = await costNow(chain, me, contract, energy);
      const trxBal = BigInt((await resourceState(chain, me)).account?.balance || 0);
      const value = BigInt(contract.parameter.call_value || 0);
      let problem = null;
      if (!sim.ok && steps.length === 1) problem = t('tron.bridge.simFailed', { reason: sim.message || '' });
      else if (c.cost.total + value > trxBal) problem = t('tron.send.noTrxFee', { amount: trx(c.cost.total + value) });
      const rows = value && !p.fromToken.native ? [{ k: t('sol.bridge.fixFee'), v: trx(value) }] : [];
      return { fee: feeView(c, rows), problem: () => problem };
    },
    async send(review, { auth }) {
      const contract = (latest || quote).exec.contract;
      const r = await sendContract(chain, { account: p.account, contract, feeLimit: c.feeLimit, auth: (fn) => auth(fn), title: p.title });
      return { ...r, quote: latest || quote };
    },
  });
  return steps;
}

/** The shared bridge screen's interface for routes with Tron on one side (driver.d.md, "Bridge"). */
export const tronBridge = {
  chains: () => [TRON_CHAINS[TRON_MAINNET]],
  supports: (a, b) => isTron(a) !== isTron(b) && (isEvm(a) || isEvm(b)) && !a.testnet && !b.testnet && BRIDGE_CHAINS.includes(isTron(a) ? b.id : a.id),
  freeRecipient: true, // any address on the other side
  refuel: (p) => isTron(p.fromChain), // gas on arrival on the EVM network (Relay)
  /** On Tron only TRX and USDT, both ways. */
  onlyTokens: (chain) => isTron(chain),
  tokens(chain) {
    if (isTron(chain)) return tronBridgeTokens();
    return [{ address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals, native: true }, ...(POPULAR_TOKENS[chain.id] || [])];
  },
  /** TRX kept for the energy of the bridge call (and deBridge's fixed fee) when bridging TRX with Max. */
  reserve: async (chain, token, balance) => (isTron(chain) && token.native ? (balance > 60_000_000n ? balance - 60_000_000n : 0n) : balance),
  note: (p) => (isTron(p.fromChain) ? t('tron.bridge.energyNote') : null),
  async quotes(p) {
    return tronBridgeQuotes(this.internal(p));
  },
  internal(p) {
    const out = isTron(p.fromChain);
    const evmChain = out ? p.toChain : p.fromChain;
    return {
      out, evmChain, trToken: out ? p.fromToken : p.toToken, evmToken: out ? p.toToken : p.fromToken, amount: p.amount,
      trAddress: (out ? p.fromAddr : p.toAddr).raw, evmAddress: (out ? p.toAddr : p.fromAddr).raw, slippageBps: 100, refuel: out && p.refuel,
      trxPrice: out ? p.nativePrice : null, evmPrice: out ? null : p.nativePrice,
    };
  },
  async steps(quote, p) {
    if (quote.exec.kind === 'tron') return tronSteps(quote, p, this.internal(p));
    // into Tron: an EVM transaction, after an approval of the exact amount when the source is a token
    const from = p.fromAddr.raw;
    const approve = await approvalStep({ chain: p.fromChain, from, token: p.fromToken, spender: quote.exec.spender, amount: BigInt(p.amount), provider: quote.provider });
    let latest = null;
    const send = txStep({
      key: 'bridge', title: t('bridge.confirm'), chain: p.fromChain, from, sentTitle: p.title,
      build: async () => {
        if (!approve) return quote.exec.tx;
        latest = (await this.quotes(p)).quotes.find((q) => q.provider === quote.provider) || null; // quotes expire
        return latest?.exec.tx || quote.exec.tx;
      },
      valueWei: p.fromToken.native ? BigInt(p.amount) : 0n,
    });
    const step = { ...send, send: async (...a) => ({ ...(await send.send(...a)), quote: latest || quote }) };
    return [approve, step].filter(Boolean);
  },
};
