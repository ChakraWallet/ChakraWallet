// Gas/fee estimation and transaction preparation (shared by UI and background).
// Everything that crosses runtime messaging is a hex string (BigInt is not serializable).
import { Transaction, Interface } from 'ethers';
import { rpc } from './rpc.js';
import { toHex } from './chains.js';
import { t } from './i18n.js';

const big = (v, d = 0n) => (v === undefined || v === null || v === '' ? d : BigInt(v));
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0n) / BigInt(arr.length) : 0n);
const maxB = (a, b) => (a > b ? a : b);
const minB = (a, b) => (a < b ? a : b);

export const SPEEDS = {
  slow: { label: 'speed.slow', hint: 'speed.slow.hint' }, // i18n keys
  normal: { label: 'speed.normal', hint: 'speed.normal.hint' },
  fast: { label: 'speed.fast', hint: 'speed.fast.hint' },
};

export async function getFeeData(chain) {
  const block = await rpc(chain, 'eth_getBlockByNumber', ['latest', false]);
  if (block?.baseFeePerGas) {
    let base = BigInt(block.baseFeePerGas);
    let pr = [0n, 0n, 0n];
    try {
      const h = await rpc(chain, 'eth_feeHistory', ['0x5', 'latest', [10, 50, 90]]);
      if (h?.baseFeePerGas?.length) base = BigInt(h.baseFeePerGas[h.baseFeePerGas.length - 1]);
      if (h?.reward?.length) pr = [0, 1, 2].map((i) => mean(h.reward.map((r) => BigInt(r[i] || 0))));
    } catch { /* ignore */ }
    let suggested = 0n;
    try { suggested = BigInt(await rpc(chain, 'eth_maxPriorityFeePerGas', [])); } catch { /* ignore */ }
    const floor = chain.minPriorityFee ? BigInt(chain.minPriorityFee) : 0n;
    const tip = {
      slow: maxB(maxB(pr[0], floor), suggested / 2n),
      normal: maxB(maxB(pr[1], suggested), floor),
      fast: maxB(maxB(pr[2], (suggested * 12n) / 10n), floor),
    };
    if (tip.fast < tip.normal) tip.fast = tip.normal;
    const mult = { slow: 125n, normal: 175n, fast: 225n };
    const speeds = {};
    for (const s of Object.keys(tip)) {
      speeds[s] = { priority: tip[s], maxFee: (base * mult[s]) / 100n + tip[s], effective: base + tip[s] };
    }
    return { eip1559: true, baseFee: base, speeds };
  }
  const gp = BigInt(await rpc(chain, 'eth_gasPrice', []));
  return {
    eip1559: false,
    speeds: {
      slow: { gasPrice: gp, effective: gp },
      normal: { gasPrice: (gp * 110n) / 100n, effective: (gp * 110n) / 100n },
      fast: { gasPrice: (gp * 130n) / 100n, effective: (gp * 130n) / 100n },
    },
  };
}

const oracle = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
const OP_ORACLE = '0x420000000000000000000000000000000000000F';

export async function getL1Fee(chain, tx) {
  if (!chain.opStack) return 0n;
  try {
    const unsigned = Transaction.from({
      type: 2, chainId: chain.id, to: tx.to || null, data: tx.data || '0x', value: big(tx.value),
      nonce: Number(big(tx.nonce)), gasLimit: big(tx.gas), maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
    }).unsignedSerialized;
    const res = await rpc(chain, 'eth_call', [{ to: OP_ORACLE, data: oracle.encodeFunctionData('getL1Fee', [unsigned]) }, 'latest']);
    return BigInt(res);
  } catch { return 0n; }
}

/**
 * Prepare a transaction: estimate gas, nonce and fees for all speeds.
 * tx: {to, value?, data?, gas?/gasLimit?} (hex or decimal strings)
 * Returns a serializable object with costs per speed (wei, hex strings).
 */
export async function prepareTx(chain, from, tx) {
  const base = {
    from,
    to: tx.to ? tx.to : undefined,
    value: toHex(big(tx.value)),
    data: tx.data && tx.data !== '0x' ? tx.data : tx.input && tx.input !== '0x' ? tx.input : '0x',
  };
  let estimateError = null;
  let gasEstimate;
  const userGas = tx.gas ?? tx.gasLimit;
  const [fee, nonce, code] = await Promise.all([
    getFeeData(chain),
    rpc(chain, 'eth_getTransactionCount', [from, 'pending']),
    base.to && base.data === '0x' ? rpc(chain, 'eth_getCode', [base.to, 'latest']).catch(() => '0x') : Promise.resolve(null),
  ]);
  if (code === '0x' && base.data === '0x') {
    gasEstimate = 21000n;
  } else {
    try {
      const callObj = { from, to: base.to, value: base.value, data: base.data };
      gasEstimate = BigInt(await rpc(chain, 'eth_estimateGas', [callObj]));
    } catch (e) {
      estimateError = e?.data?.message || e?.message || t('errors.txMayFail');
      gasEstimate = userGas ? big(userGas) : 300000n;
    }
  }
  let gasLimit = userGas ? big(userGas) : gasEstimate === 21000n ? 21000n : (gasEstimate * 125n) / 100n;
  if (gasLimit < gasEstimate) gasLimit = gasEstimate;
  const l1Fee = await getL1Fee(chain, { ...base, gas: gasLimit, nonce });
  const speeds = {};
  for (const [k, s] of Object.entries(fee.speeds)) {
    speeds[k] = {
      ...(fee.eip1559 ? { maxFeePerGas: toHex(s.maxFee), maxPriorityFeePerGas: toHex(s.priority) } : { gasPrice: toHex(s.gasPrice) }),
      estCost: toHex(gasEstimate * s.effective + l1Fee),
      maxCost: toHex(gasLimit * (fee.eip1559 ? s.maxFee : s.gasPrice) + l1Fee),
    };
  }
  return {
    chainId: chain.id,
    eip1559: fee.eip1559,
    tx: { ...base, nonce, gas: toHex(gasLimit) },
    gasEstimate: toHex(gasEstimate),
    l1Fee: toHex(l1Fee),
    speeds,
    estimateError,
  };
}

/** Build the final tx (to send to the background for signing) from a prepared tx and the chosen speed. */
export function finalizeTx(prepared, speed = 'normal') {
  const s = prepared.speeds[speed] || prepared.speeds.normal;
  const tx = { ...prepared.tx, chainId: prepared.chainId };
  if (prepared.eip1559) {
    tx.type = 2; tx.maxFeePerGas = s.maxFeePerGas; tx.maxPriorityFeePerGas = s.maxPriorityFeePerGas;
  } else {
    tx.type = 0; tx.gasPrice = s.gasPrice;
  }
  return tx;
}

// ---------------------------------------------------------------- replacing a transaction still waiting
// A transaction not mined yet is replaced by another one with the same nonce and higher fees: the nodes keep the one
// that pays more - at least 10% more on every fee field, and strictly more (geth's rule, which the other clients
// follow) - and only one of them is ever mined. "Speed up": the same transaction again; "cancel": nothing in its
// place (0 to oneself, no data), which uses the nonce up. `pending`: what the background kept of a transaction it
// sent (src/background/index.js, txpending): { hash, chainId, from, nonce, type (0 | 2), to, value, data, gas,
// maxFeePerGas, maxPriorityFeePerGas | gasPrice, private }.

/** The lowest fees a replacement may offer: 10% above the highest of the transactions sent with that nonce. */
export function replacementFloor(sent) {
  const up = (b) => { const c = b + (b + 9n) / 10n; return c > b ? c : b + 1n; };
  const most = (k) => sent.reduce((m, x) => maxB(m, big(x[k])), 0n);
  return sent[0].type === 2
    ? { maxFeePerGas: up(most('maxFeePerGas')), maxPriorityFeePerGas: up(most('maxPriorityFeePerGas')) }
    : { gasPrice: up(most('gasPrice')) };
}
/** Do these fees (hex or bigint) reach the floor? */
export const meetsFloor = (fees, floor) => Object.keys(floor).every((k) => fees[k] != null && big(fees[k]) >= floor[k]);

/** What the replacement does: the same call (speed up), or 0 to oneself with no data (cancel). */
export const replacementCall = (pending, mode) => (mode === 'cancel'
  ? { to: pending.from, value: '0x0', data: '0x' }
  : { to: pending.to || null, value: pending.value || '0x0', data: pending.data || '0x' });

/**
 * A replacement ready for the fee screen, in prepareTx's shape (speeds with fees, estCost, maxCost; tx; l1Fee), every
 * speed lifted to the floor when the network's own fee is lower. `sent`: every transaction sent with that nonce (the
 * floor is above all of them). Also `before`: what the transaction offered, at today's base fee (to compare).
 */
export async function prepareReplacement(chain, pending, mode, sent = [pending]) {
  const call = replacementCall(pending, mode);
  const floor = replacementFloor(sent);
  const [fee, estimate] = await Promise.all([
    getFeeData(chain),
    rpc(chain, 'eth_estimateGas', [{ from: pending.from, ...(call.to ? { to: call.to } : {}), value: call.value, data: call.data }]).then((g) => BigInt(g), () => null),
  ]);
  // speed up: the gas limit it was signed with (the call may not be estimable any more: a swap past its deadline...);
  // cancel: what a transfer to oneself takes on this network (more than 21,000 on some L2s)
  let gasLimit, gasEstimate;
  if (mode === 'cancel') {
    gasEstimate = estimate ?? 21000n;
    gasLimit = gasEstimate <= 21000n ? 21000n : (gasEstimate * 125n) / 100n;
  } else {
    gasLimit = big(pending.gas);
    gasEstimate = estimate && estimate < gasLimit ? estimate : gasLimit;
  }
  const l1Fee = await getL1Fee(chain, { ...call, gas: gasLimit, nonce: pending.nonce });
  const base = fee.eip1559 ? fee.baseFee : null;
  const speeds = {};
  for (const [k, s] of Object.entries(fee.speeds)) {
    if (pending.type === 2) {
      const priority = maxB(fee.eip1559 ? s.priority : s.gasPrice, floor.maxPriorityFeePerGas);
      const maxFee = maxB(maxB(fee.eip1559 ? s.maxFee : s.gasPrice, floor.maxFeePerGas), priority);
      const effective = base != null ? minB(maxFee, base + priority) : maxFee;
      speeds[k] = { maxFeePerGas: toHex(maxFee), maxPriorityFeePerGas: toHex(priority), estCost: toHex(gasEstimate * effective + l1Fee), maxCost: toHex(gasLimit * maxFee + l1Fee) };
    } else {
      const gasPrice = maxB(fee.eip1559 ? s.effective : s.gasPrice, floor.gasPrice);
      speeds[k] = { gasPrice: toHex(gasPrice), estCost: toHex(gasEstimate * gasPrice + l1Fee), maxCost: toHex(gasLimit * gasPrice + l1Fee) };
    }
  }
  const was = pending.type === 2
    ? (base != null ? minB(big(pending.maxFeePerGas), base + big(pending.maxPriorityFeePerGas)) : big(pending.maxFeePerGas))
    : big(pending.gasPrice);
  return {
    chainId: chain.id, eip1559: pending.type === 2, mode, hash: pending.hash,
    tx: { from: pending.from, ...call, nonce: pending.nonce, gas: toHex(gasLimit) },
    gasEstimate: toHex(gasEstimate), l1Fee: toHex(l1Fee), speeds, before: toHex(gasEstimate * was + l1Fee), estimateError: null,
  };
}
