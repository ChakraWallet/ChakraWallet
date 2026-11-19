// Coin selection and transaction size. A send picks some of the account's coins (confirmed ones first, the fewest
// that cover the amount), pays the recipients, and sends the rest back to a change address - unless the rest is so
// small it would cost more to spend later than it's worth ("dust"): then it goes to the fee. Sizes are in virtual
// bytes (vB), the unit fees are priced in; inputs are counted at their largest signature size.
import { TYPES, outputVbytes } from './keys.js';

/** Below this an output can't be relayed by nodes (Bitcoin Core's dust limits at 3 sat/vB). */
export const DUST = { p2wpkh: 294n, p2tr: 330n, 'p2sh-p2wpkh': 540n, p2sh: 540n, p2pkh: 546n, p2wsh: 330n, unknown: 546n };
export const dustOf = (type) => DUST[type] ?? 546n;

/** vsize of a transaction: inputs (types), outputs (scripts as bytes). */
export function txVbytes(inputTypes, outputScripts) {
  const segwit = inputTypes.some((t) => t !== 'p2pkh');
  const varint = (n) => (n < 0xfd ? 1 : 3);
  const base = 8 + varint(inputTypes.length) + varint(outputScripts.length) + (segwit ? 0.5 : 0);
  const ins = inputTypes.reduce((s, t) => s + TYPES[t].inVb, 0);
  const outs = outputScripts.reduce((s, sc) => s + outputVbytes(sc), 0);
  return Math.ceil(base + ins + outs);
}
export const feeFor = (vbytes, rate) => BigInt(Math.ceil(vbytes * rate));

/**
 * Picks coins for a send.
 *   coins: spendable coins [{ value (bigint), type, confirmed, … }], in order of preference
 *   outputs: [{ script, value }] the recipients (value 0 for OP_RETURN data)
 *   change: { script, type } where the rest goes
 *   rate: sat/vB;  max: everything goes to outputs[maxIndex] (value computed);  must: coins that have to be spent;
 *   forceChange: there must be a change output (a service that refunds to it)
 * -> { inputs, outputs (with the change last, if any), fee, vbytes, change (bigint, 0 when none) }, or
 *    { error: 'funds' | 'dust', need (bigint: what was missing) }
 */
export function selectCoins({ coins, outputs, change, rate, max = false, maxIndex = 0, must = [], forceChange = false }) {
  const scripts = outputs.map((o) => o.script);
  if (max) {
    const inputs = [...must, ...coins.filter((c) => !must.includes(c))];
    if (!inputs.length) return { error: 'funds', need: 1n };
    const vbytes = txVbytes(inputs.map((c) => c.type), scripts);
    const fee = feeFor(vbytes, rate);
    const total = inputs.reduce((s, c) => s + c.value, 0n);
    const others = outputs.reduce((s, o, k) => (k === maxIndex ? s : s + BigInt(o.value)), 0n);
    const value = total - fee - others;
    const dust = dustOf(outputs[maxIndex].type || 'unknown');
    if (value < dust) return { error: value <= 0n ? 'funds' : 'dust', need: dust - value };
    return { inputs, outputs: outputs.map((o, k) => (k === maxIndex ? { ...o, value } : o)), fee, vbytes, change: 0n };
  }
  const target = outputs.reduce((s, o) => s + BigInt(o.value), 0n);
  const withChange = [...scripts, change.script];
  const changeDust = dustOf(change.type);
  const costOfChange = feeFor(TYPES[change.type]?.outVb || 31, rate) + feeFor(TYPES[change.type]?.inVb || 68, rate);
  const finish = (inputs) => {
    const total = inputs.reduce((s, c) => s + c.value, 0n);
    const vbNo = txVbytes(inputs.map((c) => c.type), scripts), feeNo = feeFor(vbNo, rate);
    const vbCh = txVbytes(inputs.map((c) => c.type), withChange), feeCh = feeFor(vbCh, rate);
    const rest = total - target - feeCh;
    if (rest >= changeDust && rest > costOfChange) return { inputs, outputs: [...outputs, { ...change, value: rest, change: true }], fee: feeCh, vbytes: vbCh, change: rest };
    if (rest >= changeDust && forceChange) return { inputs, outputs: [...outputs, { ...change, value: rest, change: true }], fee: feeCh, vbytes: vbCh, change: rest };
    if (total >= target + feeNo && !forceChange) return { inputs, outputs, fee: total - target, vbytes: vbNo, change: 0n };
    return null;
  };
  // the coins that have to be spent (coin control, a replacement's inputs) come first
  let picked = [...must];
  const rest = coins.filter((c) => !must.includes(c));
  if (picked.length) { const r = finish(picked); if (r) return r; }
  // one coin that pays it all without change and wastes less than a change output would cost
  if (!picked.length && !forceChange) {
    const vbNo = txVbytes([rest[0]?.type || 'p2wpkh'], scripts);
    const exact = rest
      .filter((c) => { const fee = feeFor(txVbytes([c.type], scripts), rate); return c.value >= target + fee && c.value - target - fee <= costOfChange; })
      .sort((x, y) => (x.value < y.value ? -1 : 1))[0];
    if (exact && vbNo) return finish([exact]);
  }
  // the largest coins until they cover it (confirmed ones first: they are in front)
  const ordered = [...rest.filter((c) => c.confirmed !== false).sort((x, y) => (y.value > x.value ? 1 : -1)), ...rest.filter((c) => c.confirmed === false).sort((x, y) => (y.value > x.value ? 1 : -1))];
  for (const c of ordered) {
    picked = [...picked, c];
    const r = finish(picked);
    if (r) return r;
  }
  const total = picked.reduce((s, c) => s + c.value, 0n);
  const fee = feeFor(txVbytes(picked.map((c) => c.type), scripts), rate);
  return { error: 'funds', need: target + fee - total };
}
