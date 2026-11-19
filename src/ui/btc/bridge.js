// Bridges between Bitcoin and the EVM networks: Relay and LI.FI, quoted together and ranked like the other routes
// (public APIs, no keys, no fee added by Chakra). Mainnet only (no service works on Testnet4).
// - Out of Bitcoin, Relay gives a deposit address of its own for the order (useDepositAddress): the account pays it
//   with a transaction it builds itself (its coins, its fee). LI.FI gives an address and a memo: the transaction must
//   be exactly [the amount to that address, OP_RETURN with the memo, the rest back to the sender's address] - only the
//   coins spent may change; a route that comes as a ready-made PSBT is left out. The background signs only those
//   outputs (src/background/btc.js).
// - Into Bitcoin, an EVM transaction (after an approval of the exact amount when the source is a token) that pays the
//   account's next receive address.
import { t } from '../../shared/i18n.js';
import { NATIVE, isEvm } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { ENDPOINTS } from '../../shared/endpoints.js';
import { BRIDGE_CHAINS } from '../../shared/bridge.js';
import { erc20 } from '../../shared/rpc.js';
import { BTC_CHAINS, BTC_MAINNET, isBitcoin } from '../../shared/btc/networks.js';
import { decodeAddress, toHex, fromHex } from '../../shared/btc/keys.js';
import { selectCoins } from '../../shared/btc/select.js';
import { feeRates } from '../../shared/btc/esplora.js';
import { bg } from '../../shared/ext.js';
import { approvalStep, txStep } from '../chains/evm.js';
import { accountContext, rateOf, toPlan, withPrevHex, changeOut, feeOf } from './plan.js';

const RELAY_BTC = 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8'; // BTC in Relay
const RELAY_ID = 8253038, LIFI_ID = 20000000000001;
const ZERO = '0x0000000000000000000000000000000000000000';
const num = (x) => (x == null || x === '' ? null : Number(x));

async function fetchJson(url, init = {}, timeout = 25000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.errorMessage || json.error || `HTTP ${res.status}`);
  return json;
}

/** p (internal): { out (Bitcoin -> EVM), evmChain, evmToken, amount, btcUser (an address of the account holding the most), btcTo, evmAddress, slippageBps, refuel } */
const providers = {
  async Relay(p) {
    const evmCur = p.evmToken.native || p.evmToken.address === NATIVE ? ZERO : p.evmToken.address;
    const body = {
      user: p.out ? p.btcUser : p.evmAddress, recipient: p.out ? p.evmAddress : p.btcTo,
      originChainId: p.out ? RELAY_ID : p.evmChain.id, destinationChainId: p.out ? p.evmChain.id : RELAY_ID,
      originCurrency: p.out ? RELAY_BTC : evmCur, destinationCurrency: p.out ? evmCur : RELAY_BTC,
      amount: p.amount, tradeType: 'EXACT_INPUT', slippageTolerance: String(p.slippageBps),
      ...(p.out ? { useDepositAddress: true, refundTo: p.btcUser } : {}),
      ...(p.refuel && p.out ? { topupGas: true } : {}),
    };
    const r = await fetchJson(`${ENDPOINTS.relay}/quote/v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const steps = r.steps || [];
    if (steps.some((x) => x.kind === 'signature')) throw new Error(t('errors.bridgeNoRoute'));
    const deposit = steps.find((x) => x.id === 'deposit') || steps[steps.length - 1];
    let exec;
    if (p.out) {
      const to = deposit?.depositAddress || r.depositAddress;
      if (!to || !decodeAddress(to, BTC_CHAINS[BTC_MAINNET].net)) throw new Error(t('errors.bridgeNoRoute'));
      exec = { kind: 'btc', outputs: [{ address: to, value: String(p.amount) }] };
    } else {
      const data = deposit?.items?.[0]?.data;
      if (!data?.to) throw new Error(t('errors.bridgeNoRoute'));
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
      ref: { requestId: deposit?.requestId || r.requestId }, exec,
    };
  },

  async 'LI.FI'(p) {
    const evmCur = p.evmToken.native || p.evmToken.address === NATIVE ? ZERO : p.evmToken.address;
    const q = new URLSearchParams({
      fromChain: p.out ? LIFI_ID : p.evmChain.id, toChain: p.out ? p.evmChain.id : LIFI_ID,
      fromToken: p.out ? 'bitcoin' : evmCur, toToken: p.out ? evmCur : 'bitcoin',
      fromAmount: p.amount, fromAddress: p.out ? p.btcUser : p.evmAddress, toAddress: p.out ? p.evmAddress : p.btcTo, slippage: String(p.slippageBps / 10000),
    });
    const r = await fetchJson(`${ENDPOINTS.lifi}/v1/quote?${q}`);
    const e = r.estimate, tr = r.transactionRequest;
    if (!e || !tr) throw new Error(t('errors.bridgeNoRoute'));
    let exec;
    if (p.out) {
      // the memo form only: [amount -> vault, OP_RETURN memo, the rest -> the sender's address]
      const memo = String(tr.data || '');
      const net = BTC_CHAINS[BTC_MAINNET].net;
      if (!tr.to || !decodeAddress(tr.to, net) || !memo || /^(cHNidP|70736274ff)/i.test(memo) || BigInt(tr.value || 0) !== BigInt(p.amount)) throw new Error(t('errors.bridgeNoRoute'));
      const bytes = /^0x[0-9a-f]+$/i.test(memo) ? memo.slice(2) : toHex(new TextEncoder().encode(memo));
      if (bytes.length / 2 > 80) throw new Error(t('errors.bridgeNoRoute'));
      exec = { kind: 'btc', outputs: [{ address: tr.to, value: String(p.amount) }, { script: opReturn(bytes), value: '0' }], refundToSender: true };
    } else {
      if (!tr.data) throw new Error(t('errors.bridgeNoRoute'));
      exec = { kind: 'evm', tx: { to: tr.to, data: tr.data, value: tr.value || '0x0' }, spender: p.evmToken.native ? null : e.approvalAddress };
    }
    const fees = e.feeCosts || [];
    return {
      tool: r.toolDetails?.name || r.tool, amountOut: e.toAmount, minOut: e.toAmountMin, outUsd: num(e.toAmountUSD), durationSec: e.executionDuration,
      feesUsd: fees.reduce((x, f) => x + (num(f.amountUSD) || 0), 0), extraCostUsd: fees.filter((f) => f.included === false).reduce((x, f) => x + (num(f.amountUSD) || 0), 0),
      gasUsd: p.out ? 0 : (e.gasCosts || []).reduce((x, g) => x + (num(g.amountUSD) || 0), 0), refuel: null,
      ref: { tool: r.tool, lifiFrom: p.out ? LIFI_ID : p.evmChain.id, lifiTo: p.out ? p.evmChain.id : LIFI_ID }, exec,
    };
  },
};
/** OP_RETURN <data> (hex). */
function opReturn(hex) {
  const n = hex.length / 2;
  return `6a${n <= 75 ? n.toString(16).padStart(2, '0') : `4c${n.toString(16).padStart(2, '0')}`}${hex}`;
}

const SERVICE = { Relay: 'relay', 'LI.FI': 'lifi' };
export async function btcBridgeQuotes(p) {
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

/** Out of Bitcoin: one transaction paying the service (outputs as the quote says), the account's coins and fee. */
function btcStep(quote, p) {
  const chain = p.fromChain;
  let ctx = null, rates = null;
  const cache = new Map();
  const selFor = (speed) => {
    const rate = rateOf(rates, speed);
    if (cache.has(rate)) return cache.get(rate);
    const outs = quote.exec.outputs.map((o) => (o.script ? { script: fromHex(o.script), value: 0n, data: true, type: 'unknown' } : { address: o.address, script: decodeAddress(o.address, chain.net).script, type: decodeAddress(o.address, chain.net).type, value: BigInt(o.value) }));
    // LI.FI: the rest goes back to the sender's address it was quoted with (its refund), as the third output
    const user = ctx.userCoin;
    const change = quote.exec.refundToSender
      ? { address: user.address, script: decodeAddress(user.address, chain.net).script, type: user.type, own: { b: user.b, c: user.c, i: user.i }, change: true }
      : null;
    const sel = selectCoins({ coins: ctx.coins.filter((c) => c.spendable), outputs: outs, change: change || ctx.change, rate, forceChange: !!change });
    cache.set(rate, sel);
    return sel;
  };
  return {
    key: 'bridge', title: t('bridge.confirm'),
    async prepare() {
      ctx = await accountContext(chain, p.fromAddr.raw);
      rates = await feeRates(chain);
      ctx.userCoin = ctx.coins.filter((c) => c.spendable).sort((a, b) => (b.value > a.value ? 1 : -1))[0] || null;
      ctx.change = changeOut(chain, ctx, 'p2wpkh');
      const problem = (speed) => {
        if (quote.exec.refundToSender && ctx.userCoin?.address !== p.btcUser) return t('errors.bridgeNoRoute');
        const s = selFor(speed);
        return s.error ? t('btc.send.noFunds', { amount: `${Number(s.need) / 1e8} BTC` }) : null;
      };
      return { fee: feeOf(chain, rates, selFor), problem };
    },
    async send(review, { speed, auth }) {
      const s = selFor(speed);
      if (s.error) throw new Error(review.problem(speed));
      const plan = await withPrevHex(chain, toPlan(s, { clean: true }));
      const r = await auth((password) => bg('btcSend', { from: p.account.address, chainId: chain.id, plan, meta: { title: p.title, origin: quote.provider }, password }));
      return { hash: r.txid, quote };
    },
  };
}

/** The shared bridge screen's interface for routes with Bitcoin on one side (driver.d.md, "Bridge"). */
export const btcBridge = {
  chains: () => [BTC_CHAINS[BTC_MAINNET]],
  supports: (a, b) => isBitcoin(a) !== isBitcoin(b) && (isEvm(a) || isEvm(b)) && !a.testnet && !b.testnet && BRIDGE_CHAINS.includes(isBitcoin(a) ? b.id : a.id),
  freeRecipient: true,
  refuel: (p) => isBitcoin(p.fromChain),
  onlyTokens: (chain) => isBitcoin(chain),
  tokens(chain) {
    if (isBitcoin(chain)) return [{ address: NATIVE, symbol: 'BTC', name: 'Bitcoin', decimals: 8, native: true }];
    return [{ address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals, native: true }, ...(POPULAR_TOKENS[chain.id] || [])];
  },
  /** BTC kept for the fee when bridging with Max (a transaction of a few coins at a high rate). */
  reserve: async (chain, token, balance) => (isBitcoin(chain) ? (balance > 20_000n ? balance - 20_000n : 0n) : balance),
  note: (p) => (isBitcoin(p.fromChain) ? t('btc.bridge.note') : isBitcoin(p.toChain) ? t('btc.bridge.noteIn') : null),
  async quotes(p) { return btcBridgeQuotes(await this.internal(p)); },
  async internal(p) {
    const out = isBitcoin(p.fromChain);
    let btcUser = null;
    if (out) {
      // the account's address holding the most: the services quote (and LI.FI refunds) with one address
      const ctx = await accountContext(p.fromChain, p.fromAddr.raw);
      btcUser = ctx.coins.filter((c) => c.spendable).sort((a, b) => (b.value > a.value ? 1 : -1))[0]?.address || p.fromAddr.address;
    }
    return {
      out, evmChain: out ? p.toChain : p.fromChain, evmToken: out ? p.toToken : p.fromToken, amount: p.amount,
      btcUser, btcTo: out ? null : (p.toAddr.address || p.toAddr.raw), evmAddress: (out ? p.toAddr : p.fromAddr).raw, slippageBps: 100, refuel: out && p.refuel,
    };
  },
  async steps(quote, p) {
    if (quote.exec.kind === 'btc') {
      const internal = await this.internal(p);
      return [btcStep(quote, { ...p, btcUser: internal.btcUser })];
    }
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
