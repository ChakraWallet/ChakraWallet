// Bridges between EVM networks and Solana: Relay, deBridge and LI.FI, quoted together and ranked like the EVM routes
// (public APIs, no keys, no fee added by Chakra). Out of Solana each service answers with a Solana transaction (or its
// instructions, Relay), simulated before it is signed; into Solana with an EVM transaction, after an approval of the
// exact amount when the source is a token.
import { t } from '../../shared/i18n.js';
import { NATIVE, isEvm } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { ENDPOINTS } from '../../shared/endpoints.js';
import { BRIDGE_CHAINS } from '../../shared/bridge.js';
import { erc20 } from '../../shared/rpc.js';
import { fromBase64, fromHex, sol } from '../../shared/solana/core.js';
import { SOL_CHAINS, simulate, lookupTables, solBalance } from '../../shared/solana/api.js';
import { approvalStep, txStep } from '../chains/evm.js';
import { plan, sendInstructions, freshen, signAndSend, simText, BASE_FEE } from './tx.js';

export const RELAY_SOLANA = 792703809;
export const DEBRIDGE_SOLANA = 7565164;
export const LIFI_SOLANA = 1151111081099710;
const SOL_ID = '11111111111111111111111111111111'; // SOL in the three services
const ZERO = '0x0000000000000000000000000000000000000000';
const DEBRIDGE_IDS = { 1: 1, 8453: 8453, 42161: 42161, 10: 10, 137: 137, 56: 56, 43114: 43114, 100: 100000002, 59144: 59144 };
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const isSol = (c) => c?.kind === 'solana';
const num = (x) => (x == null || x === '' ? null : Number(x));

async function fetchJson(url, init = {}, timeout = 25000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.errorMessage || json.error || `HTTP ${res.status}`);
  return json;
}

/** The tokens a route can move on Solana (SOL, USDC, USDT), as shared tokens. */
export const solBridgeTokens = () => [
  { address: NATIVE, symbol: 'SOL', name: 'Solana', decimals: 9, native: true },
  { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, known: true },
  { address: USDT, symbol: 'USDT', name: 'Tether USD', decimals: 6, known: true },
];

/**
 * p (internal): { out (Solana -> EVM), evmChain, solToken, evmToken, amount, solAddress, evmAddress, slippageBps, refuel }
 * -> route: { provider, tool, amountOut, minOut, outUsd, durationSec, feesUsd, extraCostUsd, gasUsd, refuel, ref, exec }
 *    exec: { kind: 'solana', instructions + tables (Relay) | bytes } or { kind: 'evm', tx, spender }
 */
const sides = (p) => {
  const solCur = p.solToken.native ? SOL_ID : p.solToken.address;
  const evmCur = p.evmToken.native || p.evmToken.address === NATIVE ? ZERO : p.evmToken.address;
  return p.out
    ? { fromCur: solCur, toCur: evmCur, from: p.solAddress, to: p.evmAddress }
    : { fromCur: evmCur, toCur: solCur, from: p.evmAddress, to: p.solAddress };
};

const providers = {
  async Relay(p) {
    const s = sides(p);
    const body = {
      user: s.from, recipient: s.to, originChainId: p.out ? RELAY_SOLANA : p.evmChain.id, destinationChainId: p.out ? p.evmChain.id : RELAY_SOLANA,
      originCurrency: s.fromCur, destinationCurrency: s.toCur, amount: p.amount, tradeType: 'EXACT_INPUT', slippageTolerance: String(p.slippageBps),
      ...(p.refuel && p.out ? { topupGas: true } : {}),
    };
    const r = await fetchJson(`${ENDPOINTS.relay}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const steps = r.steps || [];
    if (steps.some((x) => x.kind === 'signature')) throw new Error(t('errors.bridgeNoRoute'));
    const deposit = steps.find((x) => x.id === 'deposit') || steps[steps.length - 1];
    const data = deposit?.items?.[0]?.data;
    if (!data) throw new Error(t('errors.bridgeNoRoute'));
    let exec;
    if (data.instructions) {
      exec = {
        kind: 'solana', tables: data.addressLookupTableAddresses || [],
        instructions: data.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable })), data: fromHex(ix.data) })),
      };
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
      srcChainId: p.out ? DEBRIDGE_SOLANA : evmId, srcChainTokenIn: s.fromCur, srcChainTokenInAmount: p.amount,
      dstChainId: p.out ? evmId : DEBRIDGE_SOLANA, dstChainTokenOut: s.toCur, dstChainTokenOutAmount: 'auto', dstChainTokenOutRecipient: s.to,
      senderAddress: s.from, srcChainOrderAuthorityAddress: s.from, dstChainOrderAuthorityAddress: s.to, prependOperatingExpenses: 'true',
    });
    const r = await fetchJson(`${ENDPOINTS.debridge}/v1.0/dln/order/create-tx?${q}`);
    const out = r.estimation?.dstChainTokenOut;
    if (!out || !r.tx?.data) throw new Error(t('errors.bridgeNoRoute'));
    // the fixed fee is paid in the source network's coin on top of the amount
    const srcDecimals = p.out ? 9 : p.evmChain.native.decimals;
    const srcPrice = p.out ? p.solPrice : p.evmPrice;
    const fixUsd = srcPrice != null && r.fixFee ? (Number(r.fixFee) / 10 ** srcDecimals) * srcPrice : 0;
    const exec = p.out
      ? { kind: 'solana', bytes: fromHex(r.tx.data), extraLamports: BigInt(r.fixFee || 0) }
      : { kind: 'evm', tx: { to: r.tx.to, data: r.tx.data, value: r.tx.value || '0' }, spender: p.evmToken.native ? null : r.tx.to };
    return {
      tool: 'deBridge', amountOut: out.amount, minOut: out.amount, outUsd: num(out.approximateUsdValue), durationSec: r.order?.approximateFulfillmentDelay,
      feesUsd: fixUsd + (num(r.protocolFeeApproximateUsdValue) || 0), extraCostUsd: fixUsd, gasUsd: 0, refuel: null, ref: { orderId: r.orderId }, exec,
    };
  },

  async 'LI.FI'(p) {
    const s = sides(p);
    const q = new URLSearchParams({
      fromChain: p.out ? LIFI_SOLANA : p.evmChain.id, toChain: p.out ? p.evmChain.id : LIFI_SOLANA, fromToken: s.fromCur, toToken: s.toCur,
      fromAmount: p.amount, fromAddress: s.from, toAddress: s.to, slippage: String(p.slippageBps / 10000),
    });
    const r = await fetchJson(`${ENDPOINTS.lifi}/v1/quote?${q}`);
    const e = r.estimate, tr = r.transactionRequest;
    if (!e || !tr?.data) throw new Error(t('errors.bridgeNoRoute'));
    const fees = e.feeCosts || [];
    const exec = p.out
      ? { kind: 'solana', bytes: fromBase64(tr.data) }
      : { kind: 'evm', tx: { to: tr.to, data: tr.data, value: tr.value || '0x0' }, spender: p.evmToken.native ? null : e.approvalAddress };
    return {
      tool: r.toolDetails?.name || r.tool, amountOut: e.toAmount, minOut: e.toAmountMin, outUsd: num(e.toAmountUSD), durationSec: e.executionDuration,
      feesUsd: fees.reduce((x, f) => x + (num(f.amountUSD) || 0), 0), extraCostUsd: fees.filter((f) => f.included === false).reduce((x, f) => x + (num(f.amountUSD) || 0), 0),
      gasUsd: (e.gasCosts || []).reduce((x, g) => x + (num(g.amountUSD) || 0), 0), refuel: null,
      // the status API knows Solana by LI.FI's own id
      ref: { tool: r.tool, lifiFrom: p.out ? LIFI_SOLANA : p.evmChain.id, lifiTo: p.out ? p.evmChain.id : LIFI_SOLANA }, exec,
    };
  },
};

const SERVICE = { Relay: 'relay', deBridge: 'debridge', 'LI.FI': 'lifi' };

/** Every service's route, best net value first: { quotes, errors }. */
export async function solBridgeQuotes(p) {
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

const fixed = (chain, amount, extra = {}) => ({ kind: 'fixed', amount, decimals: 9, symbol: chain.native.symbol, unknownText: t('sol.send.feeUnknown'), ...extra });

/** The Solana step of a route out of Solana: simulated, then signed and sent. */
function solanaStep(chain, quote, p) {
  const exec = quote.exec;
  let ready = null; // { plan } (instructions) or { bytes }
  return {
    key: 'bridge', title: t('bridge.confirm'),
    async prepare() {
      const lamports = await solBalance(chain, p.fromAddr.raw).catch(() => 0n);
      if (exec.instructions) {
        const tables = await lookupTables(chain, exec.tables);
        const lt = exec.tables.length ? exec.tables.map((key) => ({ key, addresses: tables[key] || [] })) : null;
        const pl = await plan(chain, { payer: p.fromAddr.raw, instructions: exec.instructions, lookupTables: lt });
        ready = { pl, lt };
        const problem = pl.problem || (pl.fee > lamports ? t('sol.err.noSolFee') : null);
        return { fee: fixed(chain, pl.fee), problem: () => problem };
      }
      const { bytes, lastValidBlockHeight } = await freshen(chain, exec.bytes);
      const sim = await simulate(chain, bytes).catch((e) => ({ err: e.message, logs: [] }));
      ready = { bytes, lastValidBlockHeight };
      const extra = exec.extraLamports || 0n;
      const problem = sim.err ? simText(sim.err, sim.logs || []) : null;
      return {
        fee: fixed(chain, BASE_FEE, extra ? { extraRows: [{ k: t('sol.bridge.fixFee'), v: `${sol(extra)} ${chain.native.symbol}` }] } : {}),
        problem: () => problem,
      };
    },
    async send(review, { auth }) {
      if (ready.pl) {
        // instructions that set their own compute budget keep it (sendInstructions adds none then)
        return sendInstructions(chain, { account: p.account, payer: p.fromAddr.raw, instructions: exec.instructions, lookupTables: ready.lt, limit: ready.pl.limit, price: ready.pl.price, auth, title: p.title });
      }
      const { bytes, lastValidBlockHeight } = await freshen(chain, ready.bytes);
      return signAndSend(chain, { account: p.account, bytes, lastValidBlockHeight, auth, title: p.title });
    },
  };
}

/** The shared bridge screen's interface for routes with Solana on one side (driver.d.md, "Bridge"). */
export const solanaBridge = {
  chains: () => Object.values(SOL_CHAINS).filter((c) => !c.testnet),
  supports: (a, b) => isSol(a) !== isSol(b) && (isEvm(a) || isEvm(b)) && !a.testnet && !b.testnet && BRIDGE_CHAINS.includes(isSol(a) ? b.id : a.id),
  freeRecipient: true, // any address on the other side
  /** Arriving on Solana the services can't attach a memo: no exchange deposit that needs one. */
  recipientNote: (chain) => (isSol(chain) ? t('sol.bridge.memoWarn') : null),
  refuel: (p) => isSol(p.fromChain), // gas on arrival on the EVM network (Relay)
  /** On Solana, what can arrive: SOL, USDC, USDT. What can leave: any token held. */
  onlyTokens: (chain, side) => isSol(chain) && side === 'to',
  tokens(chain) {
    if (isSol(chain)) return solBridgeTokens();
    return [{ address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals, native: true }, ...(POPULAR_TOKENS[chain.id] || [])];
  },
  /** SOL kept for the fees (and deBridge's fixed fee) when bridging SOL with Max. */
  reserve: async (chain, token, balance) => (isSol(chain) && token.native ? (balance > 25_000_000n ? balance - 25_000_000n : 0n) : balance),
  async quotes(p) {
    const out = isSol(p.fromChain);
    const evmChain = out ? p.toChain : p.fromChain;
    return solBridgeQuotes({
      out, evmChain, solToken: out ? p.fromToken : p.toToken, evmToken: out ? p.toToken : p.fromToken, amount: p.amount,
      solAddress: (out ? p.fromAddr : p.toAddr).raw, evmAddress: (out ? p.toAddr : p.fromAddr).raw, slippageBps: 100, refuel: out && p.refuel,
      solPrice: out ? p.nativePrice : null, evmPrice: out ? null : p.nativePrice,
    });
  },
  async steps(quote, p) {
    if (quote.exec.kind === 'solana') return [solanaStep(p.fromChain, quote, p)];
    // into Solana: an EVM transaction, after an approval of the exact amount when the source is a token
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

