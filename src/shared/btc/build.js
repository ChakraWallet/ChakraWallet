// Building and signing Bitcoin transactions (the signing part runs in the background only). A send is described by a
// plan the screens prepare and the background checks before it signs:
//   { inputs:  [{ txid, vout, value (sats, string), b, c, i (the address's place in the account), prevHex? (old
//                 address types: the whole transaction that created the coin) }],
//     outputs: [{ address, value } (paid to someone) | { address, value, own: { b, c, i } } (back to the account)
//               | { script (hex: OP_RETURN data), value: '0' }] }
// Every transaction says it can be replaced (RBF), so a send waiting too long can be sped up or cancelled.
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha256';
import { payment, decodeAddress, fromHex, toHex } from './keys.js';

export const RBF_SEQUENCE = 0xfffffffd;
/** Highest fee rate signed, whatever asks (no fee in Bitcoin's history came close): a wrong number can't burn coins. */
export const MAX_FEE_RATE = 1000;

/** txid of a raw transaction (hex): double SHA-256, bytes reversed. Only for transactions without witness data. */
export function txidOfRaw(hex) { return toHex(sha256(sha256(fromHex(hex))).reverse()); }

/** The output script of an output of the plan. */
export function outputScript(o, net) {
  if (o.script) return fromHex(o.script);
  const d = decodeAddress(o.address, net);
  if (!d) throw new Error(`bad address ${o.address}`);
  return d.script;
}

/**
 * Builds and signs a plan. keyAt({ b, c, i }) -> { privateKey, publicKey, type } (the account's key of that address).
 * -> { hex, txid, vsize, fee (bigint), inValue, outValue }. Throws when an input isn't the account's.
 */
export function signPlan(plan, net, keyAt) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true, version: 2 });
  const keys = [];
  let inValue = 0n;
  for (const inp of plan.inputs) {
    const k = keyAt(inp);
    const pay = payment(k.type, k.publicKey, net);
    if (inp.address && inp.address !== pay.address) throw new Error('input not of this account');
    const value = BigInt(inp.value);
    const fields = { txid: inp.txid, index: inp.vout, sequence: RBF_SEQUENCE };
    if (k.type === 'p2pkh') {
      if (!inp.prevHex) throw new Error('missing previous transaction');
      const prev = btc.Transaction.fromRaw(fromHex(inp.prevHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
      if (prev.id !== inp.txid) throw new Error('previous transaction mismatch');
      const out = prev.getOutput(inp.vout);
      if (!out || out.amount !== value || toHex(out.script) !== toHex(pay.script)) throw new Error('previous output mismatch');
      fields.nonWitnessUtxo = fromHex(inp.prevHex);
    } else {
      fields.witnessUtxo = { script: pay.script, amount: value };
    }
    if (pay.redeemScript) fields.redeemScript = pay.redeemScript;
    if (pay.tapInternalKey) fields.tapInternalKey = pay.tapInternalKey;
    tx.addInput(fields);
    keys.push(k.privateKey);
    inValue += value;
  }
  let outValue = 0n;
  for (const o of plan.outputs) {
    const value = BigInt(o.value);
    tx.addOutput({ script: outputScript(o, net), amount: value });
    outValue += value;
  }
  if (outValue > inValue) throw new Error('outputs exceed inputs');
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize, fee: inValue - outValue, inValue, outValue };
}

/** Reads a signed transaction: { txid, vsize, inputs: [{ txid, vout, sequence }], outputs: [{ script (hex), value }] }. */
export function readTx(hex) {
  const tx = btc.Transaction.fromRaw(fromHex(hex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const inputs = [], outputs = [];
  for (let i = 0; i < tx.inputsLength; i++) { const x = tx.getInput(i); inputs.push({ txid: toHex(x.txid), vout: x.index, sequence: x.sequence }); }
  for (let i = 0; i < tx.outputsLength; i++) { const x = tx.getOutput(i); outputs.push({ script: toHex(x.script), value: x.amount }); }
  return { txid: tx.id, vsize: tx.vsize, inputs, outputs };
}
