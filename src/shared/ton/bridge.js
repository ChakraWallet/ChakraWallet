// Bridges between EVM networks and TON (Android app): Relay for GRAM, Symbiosis for USD₮ on TON. Both answer with
// ready-made transactions: an EVM transaction (plus the spender to approve) when the source is an EVM network,
// TON messages to sign when the source is TON. Public APIs, no keys, no fee added by Chakra.
import { erc20 } from '../rpc.js';
import { t } from '../i18n.js';

export const RELAY_TON = 224235520; // TON in Relay
export const SYMBIOSIS_TON = 85918; // TON in Symbiosis
const ZERO_TON = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'; // GRAM in Relay
const ZERO_EVM = '0x0000000000000000000000000000000000000000';
export const USDT_TON = { master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', symbiosis: '0x9328Eb759596C38a25f59028B146Fecdc3621Dfe', decimals: 6, symbol: 'USD₮' };

/** Assets on the TON side and the provider that moves them. */
export const TON_ASSETS = {
  GRAM: { key: 'GRAM', symbol: 'GRAM', decimals: 9, provider: 'Relay' },
  USDT: { key: 'USDT', symbol: 'USD₮', decimals: 6, master: USDT_TON.master, provider: 'Symbiosis' },
};

async function fetchJson(url, init = {}, timeout = 25000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}
const num = (x) => (x == null || x === '' ? null : Number(x));

/**
 * p: { dir: 'in' (EVM -> TON) | 'out' (TON -> EVM), evmChain, evmToken: { address|NATIVE, symbol, decimals, native },
 *      tonAsset: TON_ASSETS.x, amount (raw string, source units), evmAddress, tonAddress (friendly), slippageBps }
 * -> route: { provider, amountOut, minOut, outUsd, durationSec, feesUsd, exec, ref }
 *    exec: { kind: 'evm', tx: { to, data, value }, spender } | { kind: 'ton', messages: [{ to, value, bounce, body }], mode? }
 */
async function relay(p) {
  const evmCur = p.evmToken.native ? ZERO_EVM : p.evmToken.address;
  const inbound = p.dir === 'in';
  const body = {
    user: inbound ? p.evmAddress : p.tonAddress, recipient: inbound ? p.tonAddress : p.evmAddress,
    originChainId: inbound ? p.evmChain.id : RELAY_TON, destinationChainId: inbound ? RELAY_TON : p.evmChain.id,
    originCurrency: inbound ? evmCur : ZERO_TON, destinationCurrency: inbound ? ZERO_TON : evmCur,
    amount: p.amount, tradeType: 'EXACT_INPUT', slippageTolerance: String(p.slippageBps ?? 100),
  };
  const r = await fetchJson('https://api.relay.link/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const steps = r.steps || [];
  if (steps.some((s) => s.kind === 'signature')) throw new Error(t('errors.bridgeNoRoute'));
  const deposit = steps.find((s) => s.id === 'deposit') || steps[steps.length - 1];
  const data = deposit?.items?.[0]?.data;
  if (!data) throw new Error(t('errors.bridgeNoRoute'));
  let exec;
  if (data.messages) {
    const m = data.messages;
    exec = { kind: 'ton', mode: m[0]?.mode ?? 1, messages: m.map((x) => ({ to: x.to, value: String(x.value), bounce: !!x.bounce, body: x.body || null })) };
  } else {
    let spender = null;
    const approve = steps.find((s) => s.id === 'approve');
    if (approve?.items?.[0]?.data) { try { spender = erc20.decodeFunctionData('approve', approve.items[0].data.data)[0]; } catch { /* none */ } }
    exec = { kind: 'evm', tx: { to: data.to, data: data.data, value: data.value || '0' }, spender };
  }
  const d = r.details || {}, out = d.currencyOut || {};
  return {
    provider: 'Relay', amountOut: out.amount, minOut: out.minimumAmount || out.amount, outUsd: num(out.amountUsd), durationSec: d.timeEstimate,
    feesUsd: (num(r.fees?.relayer?.amountUsd) || 0) + (num(r.fees?.gas?.amountUsd) || 0), exec, ref: { requestId: deposit.requestId || r.requestId },
  };
}

async function symbiosis(p) {
  const inbound = p.dir === 'in';
  const evm = { chainId: p.evmChain.id, address: p.evmToken.native ? '' : p.evmToken.address, symbol: p.evmToken.symbol, decimals: p.evmToken.decimals };
  const ton = { chainId: SYMBIOSIS_TON, address: USDT_TON.symbiosis, symbol: 'USDT', decimals: USDT_TON.decimals, attributes: { ton: USDT_TON.master } };
  const body = {
    tokenAmountIn: { ...(inbound ? evm : ton), amount: p.amount }, tokenOut: inbound ? ton : evm,
    from: inbound ? p.evmAddress : p.tonAddress, to: inbound ? p.tonAddress : p.evmAddress, slippage: p.slippageBps ?? 200,
  };
  const r = await fetchJson('https://api.symbiosis.finance/crosschain/v2/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // only on-chain routes: "changelly-trade" is a deposit-address exchange, not for a self-custodial wallet
  if (r.kind !== 'crosschain-swap' || !r.tx) throw new Error(r.message || t('errors.bridgeNoRoute'));
  const out = r.tokenAmountOut || {}, min = r.tokenAmountOutMin || out;
  const exec = r.type === 'ton'
    ? { kind: 'ton', messages: (r.tx.messages || []).map((x) => ({ to: x.address, value: String(x.amount), bounce: true, body: x.payload || null })) }
    : { kind: 'evm', tx: { to: r.tx.to, data: r.tx.data, value: r.tx.value || '0' }, spender: p.evmToken.native || /^0x0{40}$/i.test(r.approveTo || '') ? null : r.approveTo };
  const feesUsd = (r.fees || []).reduce((s, f) => s + (Number(f.value?.amount || 0) / 10 ** (f.value?.decimals || 0)) * (f.value?.priceUsd || 0), 0);
  return {
    provider: 'Symbiosis', amountOut: out.amount, minOut: min.amount, outUsd: out.priceUsd ? (Number(out.amount) / 10 ** out.decimals) * out.priceUsd : null,
    durationSec: r.estimatedTime, feesUsd, exec, ref: { tonAddress: p.tonAddress, inbound },
  };
}

/** Route for the asset chosen on the TON side (GRAM: Relay, USD₮: Symbiosis). */
export function tonBridgeQuote(p) {
  return p.tonAsset.provider === 'Relay' ? relay(p) : symbiosis(p);
}

/**
 * Status of a Symbiosis transfer (used by the shared bridge tracker): EVM source by its transaction hash; TON source
 * by the sender's address (Symbiosis doesn't index the TON wallet's own transaction).
 */
export async function symbiosisStatus(entry) {
  const map = (code, dest) => (code === 0 ? { status: 'done', destTxHash: dest } : code === 3 ? { status: 'failed' } : { status: 'pending' });
  if (!entry.ref?.inbound && entry.ref?.tonAddress) {
    const r = await fetchJson(`https://api.symbiosis.finance/crosschain/v1/txs?search=${encodeURIComponent(entry.ref.tonAddress)}&chain_id=${SYMBIOSIS_TON}`);
    const rec = (r.records || []).find((x) => x.txIn?.time && Date.parse(x.txIn.time) >= entry.created - 120000);
    return rec ? map(rec.status?.code, rec.tx?.hash) : { status: 'pending' };
  }
  const r = await fetchJson(`https://api.symbiosis.finance/crosschain/v1/tx/${entry.fromChainId}/${entry.txHash}`);
  return map(r.status?.code, r.tx?.hash);
}
