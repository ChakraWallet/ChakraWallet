// Preparing Bitcoin transactions on the screens: the account's coins and what protects them, the coins a send uses at
// each speed, the plan the background checks and signs (src/shared/btc/build.js). Sends of bitcoin, of runes (a
// runestone moves them; what's left comes back to the account), of an inscription (its coin, whole), speed up and
// cancel (RBF: the same coins, a higher fee) and speeding up a payment on its way in (CPFP: its coin spent at once,
// with a fee that pays for both).
import { t } from '../../shared/i18n.js';
import { fmtAmount } from '../../shared/format.js';
import { decodeAccount, scanAccount, loadCoins, changeAddress, addressAt } from '../../shared/btc/account.js';
import { markCoins, outpoint } from '../../shared/btc/coins.js';
import { feeRates, getTxHex } from '../../shared/btc/esplora.js';
import { decodeAddress, toHex, fromHex, TYPES } from '../../shared/btc/keys.js';
import { selectCoins, txVbytes, feeFor, dustOf } from '../../shared/btc/select.js';
import { runestoneScript } from '../../shared/btc/runes.js';
import { sentLog } from '../../shared/btc/history.js';

const btcText = (sats, chain) => `${fmtAmount(sats, 8, 8)} ${chain.native.symbol}`;
/** Postage of a coin that carries runes or an inscription to someone (the usual 546 sats). */
export const POSTAGE = 546n;

/**
 * The account, its addresses and coins now. Coins still waiting to be confirmed are spent only when they are change
 * of this wallet's own transactions (someone else's may never be confirmed).
 */
export async function accountContext(chain, raw, { full = false } = {}) {
  const a = decodeAccount(raw);
  const s = await scanAccount(chain, a, { full });
  const sent = Object.fromEntries(Object.entries(await sentLog(chain)).filter(([, l]) => l.account === a.id));
  const marked = await markCoins(chain, a, await loadCoins(chain, a, s), sent);
  for (const c of marked.coins) if (!c.confirmed && !sent[c.txid]) { c.spendable = false; c.waiting = true; }
  return { a, s, sent, coins: marked.coins, precise: marked.precise, runes: marked.runes };
}

/** sat/vB of a speed: 'slow' | 'normal' | 'fast' | 'custom:<rate>' (never under the network's minimum). */
export function rateOf(rates, speed) {
  if (String(speed).startsWith('custom:')) return Math.max(Number(String(speed).slice(7)) || rates.normal, rates.minimum);
  return rates[speed] ?? rates.normal;
}

const out = (chain, address, value, extra = {}) => {
  const d = decodeAddress(address, chain.net);
  return { address, script: d.script, type: d.type, value: BigInt(value), ...extra };
};
/** A change output of the account (type: the address type wanted; offset: another one after it). */
export function changeOut(chain, ctx, type, offset = 0) {
  const c = changeAddress(chain, ctx.a, ctx.s, type);
  const single = ctx.a.branches[c.b].single;
  const pos = { b: c.b, c: c.c, i: c.i + (single ? 0 : offset) };
  const address = offset && !single ? addressAt(chain, ctx.a, pos.b, pos.c, pos.i) : c.address;
  return { ...out(chain, address, 0n), type: c.type, own: pos, change: true };
}

/** A selection as a plan for the background. */
export function toPlan(sel, { clean = true } = {}) {
  return {
    inputs: sel.inputs.map((c) => ({ txid: c.txid, vout: c.vout, value: String(c.value), b: c.b, c: c.c, i: c.i, address: c.address })),
    outputs: sel.outputs.map((o) => (o.data ? { script: toHex(o.script), value: '0' } : { address: o.address, value: String(o.value), ...(o.own ? { own: o.own } : {}), ...(o.change ? { change: true } : {}) })),
    clean,
  };
}
/** Adds the previous transactions old address types (1…) need to be signed. */
export async function withPrevHex(chain, plan) {
  for (const x of plan.inputs) if (x.address && /^[1mn]/.test(x.address) && !x.prevHex) x.prevHex = await getTxHex(chain, x.txid);
  return plan;
}

/** What a failed selection means, in words. held: sats in coins a send can't use by itself. */
function problemOf(chain, sel, ctx) {
  if (!sel?.error) return null;
  if (sel.error === 'dust') return t('btc.send.dust', { amount: btcText(sel.need, chain) });
  const held = ctx.coins.filter((c) => !c.spendable).reduce((s, c) => s + c.value, 0n);
  return held > 0n ? t('btc.send.noFundsHeld', { amount: btcText(sel.need, chain), held: btcText(held, chain) }) : t('btc.send.noFunds', { amount: btcText(sel.need, chain) });
}

/** The component that draws a Bitcoin fee (src/ui/btc/fee.jsx, set by index.jsx: this module has no JSX). */
let FeeComponent = null;
export const setFeeComponent = (c) => { FeeComponent = c; };
/** The review's fee: computed for a speed on demand (FeeView draws it with fee.View). */
export function feeOf(chain, rates, selFor) {
  return { kind: 'btc', View: FeeComponent, rates, selFor, symbol: chain.native.symbol, decimals: chain.native.decimals };
}

/**
 * A send of bitcoin or runes. manual: outpoints chosen on the Coins page (all of them are spent, nothing else).
 * -> review (src/ui/chains/driver.d.md) with _btc: { planFor(speed) }
 */
export async function prepareBtcSend(chain, { wallet, token, to, amountRaw, isMax, manual = null }) {
  const ctx = await accountContext(chain, wallet.raw);
  const rates = await feeRates(chain);
  const dest = out(chain, to, amountRaw || 0);
  const notes = [];
  if (token && !token.native) return prepareRuneSend(chain, ctx, rates, { token, dest, amountRaw });
  if (!isMax && dest.value < dustOf(dest.type)) {
    return { recipient: to, rows: [], notes, amount: () => dest.value, problem: () => t('btc.send.belowDust', { amount: btcText(dustOf(dest.type), chain) }), fee: feeOf(chain, rates, () => null), _btc: { ctx, planFor: () => null } };
  }
  const ch = changeOut(chain, ctx, TYPES[dest.type]?.receive ? dest.type : 'p2wpkh');
  const chosen = manual ? ctx.coins.filter((c) => manual.includes(outpoint(c)) && !c.frozen) : null;
  if (chosen?.some((c) => c.protect && !c.allowed)) notes.push(t('btc.send.manualProtected'));
  const pool = chosen ? [] : ctx.coins.filter((c) => c.spendable);
  const cache = new Map();
  const selFor = (speed) => {
    const rate = rateOf(rates, speed);
    if (!cache.has(rate)) cache.set(rate, selectCoins({ coins: pool, must: chosen || [], outputs: [dest], change: ch, rate, max: isMax, maxIndex: 0 }));
    return cache.get(rate);
  };
  if (pool.some((c) => !c.confirmed)) notes.push(t('btc.send.usesUnconfirmed'));
  const rows = chosen ? [{ k: t('btc.coins.title'), v: t('btc.send.manualCoins', { n: chosen.length }) }] : [];
  return {
    recipient: to, rows, notes,
    amount: (speed) => (isMax ? selFor(speed).outputs?.[0]?.value ?? 0n : dest.value),
    problem: (speed) => problemOf(chain, selFor(speed), ctx),
    fee: feeOf(chain, rates, selFor),
    _btc: { ctx, planFor: (speed) => { const s = selFor(speed); return s.error ? null : toPlan(s, { clean: !s.inputs.some((c) => c.protect) }); } },
  };
}

/** Runes: their coins are spent, the amount goes to the recipient (546 sats with it), the rest of the runes back. */
function prepareRuneSend(chain, ctx, rates, { token, dest, amountRaw }) {
  const amount = BigInt(amountRaw || 0);
  const runeCoins = ctx.coins.filter((c) => c.runes.some((r) => r.id === token.address) && !c.frozen);
  const held = runeCoins.reduce((s, c) => s + (c.runes.find((r) => r.id === token.address)?.amount || 0n), 0n);
  const problemFixed = !runeCoins.length ? t('btc.runes.noCoins') : held < amount ? t('btc.runes.notEnough') : runeCoins.some((c) => c.inscriptions.length) ? t('btc.runes.withInscription') : null;
  const recipient = { ...dest, value: POSTAGE };
  const runeBack = changeOut(chain, ctx, 'p2tr');
  runeBack.value = POSTAGE; runeBack.change = false; // the runes' change: a coin of its own
  const btcBack = changeOut(chain, ctx, 'p2wpkh', runeBack.address === changeOut(chain, ctx, 'p2wpkh').address ? 1 : 0);
  const stone = runestoneScript({ edicts: [{ id: token.address, amount, output: 0 }], pointer: 1 });
  const data = { script: stone, value: 0n, data: true, type: 'unknown' };
  const pool = ctx.coins.filter((c) => c.spendable);
  const cache = new Map();
  const selFor = (speed) => {
    if (problemFixed) return { error: 'runes' };
    const rate = rateOf(rates, speed);
    if (!cache.has(rate)) cache.set(rate, selectCoins({ coins: pool, must: runeCoins, outputs: [recipient, runeBack, data], change: btcBack, rate }));
    return cache.get(rate);
  };
  return {
    recipient: dest.address, notes: [t('btc.runes.sendNote', { postage: btcText(POSTAGE, chain) })],
    rows: [{ k: t('btc.runes.rune'), v: token.name || token.symbol }],
    amount: () => amount,
    problem: (speed) => problemFixed || problemOf(chain, selFor(speed), ctx),
    fee: feeOf(chain, rates, selFor),
    _btc: { ctx, planFor: (speed) => { const s = selFor(speed); return s.error ? null : toPlan(s, { clean: false }); } },
  };
}

/** An inscription: its coin, whole, to the recipient (the inscribed sat goes first: to output 0). */
export async function prepareInscriptionSend(chain, { wallet, inscription, to }) {
  const ctx = await accountContext(chain, wallet.raw);
  const rates = await feeRates(chain);
  const coin = ctx.coins.find((c) => c.inscriptions.some((x) => x.id === inscription.id));
  const dest = out(chain, to, coin?.value || 0n);
  const btcBack = changeOut(chain, ctx, 'p2wpkh');
  const pool = ctx.coins.filter((c) => c.spendable);
  const others = coin ? coin.inscriptions.length - 1 : 0;
  const problemFixed = !coin ? t('btc.ord.notFound') : coin.runes.length ? t('btc.ord.withRunes') : null;
  const cache = new Map();
  const selFor = (speed) => {
    if (problemFixed) return { error: 'ord' };
    const rate = rateOf(rates, speed);
    if (!cache.has(rate)) cache.set(rate, selectCoins({ coins: pool, must: [coin], outputs: [dest], change: btcBack, rate }));
    return cache.get(rate);
  };
  return {
    recipient: to,
    notes: [t('btc.ord.sendNote', { amount: btcText(coin?.value || 0n, chain) }), ...(others > 0 ? [t('btc.ord.others', { n: others })] : [])],
    rows: [], amount: () => coin?.value || 0n,
    problem: (speed) => problemFixed || problemOf(chain, selFor(speed), ctx),
    fee: feeOf(chain, rates, selFor),
    _btc: { ctx, planFor: (speed) => { const s = selFor(speed); return s.error ? null : toPlan(s, { clean: false }); } },
  };
}

// ------------------------------------------------------------ speed up, cancel, CPFP
/** The coins of a sent transaction's plan, as selection inputs. */
const planCoins = (plan) => plan.inputs.map((x) => ({ txid: x.txid, vout: x.vout, value: BigInt(x.value), b: x.b, c: x.c, i: x.i, address: x.address, type: inputType(x.address), confirmed: true }));
function inputType(address) {
  if (/^(bc1p|tb1p)/i.test(address)) return 'p2tr';
  if (/^(bc1q|tb1q)/i.test(address)) return 'p2wpkh';
  if (/^[32]/.test(address)) return 'p2sh-p2wpkh';
  return 'p2pkh';
}

/**
 * A replacement of a transaction this wallet sent: speedUp keeps every output in its place (only the change pays the
 * higher fee; more coins join when it can't); cancel sends all its coins back to the account. Nodes take it only with
 * a higher rate and a fee at least the old one plus 1 sat/vB of the new size.
 */
export async function prepareReplacement(chain, item, { mode, wallet }) {
  const ctx = await accountContext(chain, wallet.raw);
  const orig = ctx.sent[item.hash];
  if (!orig) throw new Error(t('replace.err.unknown'));
  const rates = await feeRates(chain);
  const oldFee = BigInt(orig.fee), oldRate = Number(orig.fee) / orig.vsize;
  const must = planCoins(orig.plan);
  // not the transaction's own outputs (its change): they disappear with it
  const pool = ctx.coins.filter((c) => c.spendable && c.txid !== item.hash && !must.some((m) => outpoint(m) === outpoint(c)));
  const kept = orig.plan.outputs.filter((o) => !o.change).map((o) => (o.script ? { script: fromHex(o.script), value: 0n, data: true, type: 'unknown' } : { ...out(chain, o.address, o.value), ...(o.own ? { own: o.own } : {}) }));
  const oldChange = orig.plan.outputs.find((o) => o.change);
  const back = oldChange ? { ...out(chain, oldChange.address, 0n), own: oldChange.own, change: true } : changeOut(chain, ctx, 'p2wpkh');
  const cache = new Map();
  const selFor = (speed) => {
    let rate = Math.max(rateOf(rates, speed), oldRate + 1);
    const k = `${rate}`;
    if (cache.has(k)) return cache.get(k);
    let sel;
    // the rate the speed asks, raised to what nodes ask: the old fee plus 1 sat/vB of the new size
    for (let n = 0; n < 5; n++) {
      sel = mode === 'cancel'
        ? selectCoins({ coins: [], must, outputs: [{ ...back, change: false }], change: back, rate, max: true, maxIndex: 0 })
        : selectCoins({ coins: pool, must, outputs: kept, change: back, rate });
      if (sel.error || sel.fee >= oldFee + BigInt(sel.vbytes)) break;
      rate = Math.max(rate, Number(oldFee + BigInt(sel.vbytes)) / sel.vbytes) + 0.01;
    }
    cache.set(k, sel);
    return sel;
  };
  const notes = [t(mode === 'cancel' ? 'btc.replace.cancelNote' : 'btc.replace.speedUpNote')];
  return {
    recipient: null, notes,
    rows: [{ k: t('replace.oldFee'), v: `${btcText(oldFee, chain)} · ${fmtRate(oldRate)}`, sub: t('btc.replace.floor') }],
    amount: () => 0n,
    problem: (speed) => { const s = selFor(speed); return s.error ? (mode === 'cancel' ? t('btc.replace.cannotCancel') : problemOf(chain, s, ctx)) : null; },
    fee: feeOf(chain, rates, selFor),
    _btc: { ctx, mode, txid: item.hash, planFor: (speed) => { const s = selFor(speed); return s.error ? null : toPlan(s, { clean: orig.plan.clean }); } },
  };
}

/** Speeds up a payment on its way in: its coin to the account, with a fee that brings both to the speed chosen. */
export async function prepareCpfp(chain, item, { wallet }) {
  const ctx = await accountContext(chain, wallet.raw);
  const rates = await feeRates(chain);
  const parent = ctx.coins.filter((c) => c.txid === item.hash);
  const pv = Number(item.btc?.vsize || 0), pf = BigInt(item.btc?.fee || 0);
  const back = changeOut(chain, ctx, 'p2wpkh');
  const cache = new Map();
  const selFor = (speed) => {
    const target = rateOf(rates, speed);
    if (cache.has(target)) return cache.get(target);
    let sel;
    if (!parent.length || !pv) sel = { error: 'cpfp' };
    else if (pf >= feeFor(pv, target)) sel = { error: 'fastEnough' };
    else {
      const cv = txVbytes(parent.map((c) => c.type), [back.script]);
      const childFee = feeFor(pv + cv, target) - pf;
      sel = selectCoins({ coins: [], must: parent, outputs: [{ ...back, change: false }], change: back, rate: Number(childFee) / cv, max: true, maxIndex: 0 });
    }
    cache.set(target, sel);
    return sel;
  };
  return {
    recipient: null, notes: [t('btc.cpfp.note')],
    rows: [{ k: t('btc.cpfp.parentRate'), v: pv ? fmtRate(Number(pf) / pv) : '—' }],
    amount: () => 0n,
    problem: (speed) => { const s = selFor(speed); return s.error === 'fastEnough' ? t('btc.cpfp.fastEnough') : s.error === 'cpfp' ? t('btc.cpfp.noCoin') : problemOf(chain, s, ctx); },
    fee: feeOf(chain, rates, selFor),
    _btc: { ctx, mode: 'cpfp', parent: item.hash, planFor: (speed) => { const s = selFor(speed); return s.error ? null : toPlan(s, { clean: true }); } },
  };
}
const fmtRate = (r) => `${Number(r).toLocaleString(undefined, { maximumFractionDigits: 1 })} sat/vB`;
