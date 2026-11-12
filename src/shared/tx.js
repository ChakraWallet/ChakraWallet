// Gas/fee estimation and transaction preparation (shared by UI and background).
// Everything that crosses runtime messaging is a hex string (BigInt is not serializable).
import { Transaction, Interface } from 'ethers';
import { rpc } from './rpc.js';
import { toHex } from './chains.js';
import { t } from './i18n.js';

const big = (v, d = 0n) => (v === undefined || v === null || v === '' ? d : BigInt(v));
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0n) / BigInt(arr.length) : 0n);
const maxB = (a, b) => (a > b ? a : b);

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

async function getL1Fee(chain, tx) {
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
