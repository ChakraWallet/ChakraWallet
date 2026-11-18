// What a Tron transaction costs. Tron has no gas price: a transaction uses bandwidth (its size in bytes) and, when it
// runs a contract, energy. An account has free bandwidth every day (600), and bandwidth and energy from the TRX it
// staked (or rented, or was delegated); what it lacks is paid by burning TRX at the network's prices. Sending TRX to
// an address that never had any also pays its activation. The rules are java-tron's (BandwidthProcessor,
// EnergyProcessor); the prices come from the chain parameters.
import { getAccountResource, getAccount, chainParams, accountExists } from './api.js';

const DAY_SLOTS = 28800; // 24 hours of 3-second blocks: how long used energy / bandwidth takes to come back
const SLOT_MS = 3000;

/** Bytes a transaction is charged for: its raw data, one signature and the room the network keeps for the result. */
export const bandwidthBytes = (rawDataHex) => rawDataHex.length / 2 + 3 + 67 + 64;

/** When resources used at `lastUse` are all back (0: not known): window in slots (×1000 when "optimized"). */
function recoveredAt(lastUse, window, optimized) {
  if (!lastUse) return 0;
  const slots = window ? (optimized ? window / 1000 : window) : DAY_SLOTS;
  return lastUse + slots * SLOT_MS;
}

/**
 * Energy and bandwidth of an account now, and what the network gives per staked TRX:
 * { energy: { limit, used, available, fullAt }, bandwidth: { free: { limit, used, available, fullAt }, staked: {
 * limit, used, available, fullAt }, available }, perTrx: { energy, bandwidth }, activated, account }.
 */
export async function resourceState(chain, address) {
  const [r, acc] = await Promise.all([getAccountResource(chain, address), getAccount(chain, address)]);
  const n = (v) => Number(v || 0);
  const eLimit = n(r.EnergyLimit), eUsed = Math.min(n(r.EnergyUsed), eLimit);
  const fLimit = n(r.freeNetLimit), fUsed = Math.min(n(r.freeNetUsed), fLimit);
  const sLimit = n(r.NetLimit), sUsed = Math.min(n(r.NetUsed), sLimit);
  const ar = acc?.account_resource || {};
  return {
    energy: { limit: eLimit, used: eUsed, available: eLimit - eUsed, fullAt: eUsed ? recoveredAt(n(ar.latest_consume_time_for_energy), n(ar.energy_window_size), ar.energy_window_optimized) : 0 },
    bandwidth: {
      free: { limit: fLimit, used: fUsed, available: fLimit - fUsed, fullAt: fUsed ? recoveredAt(n(acc?.latest_consume_free_time), DAY_SLOTS, false) : 0 },
      staked: { limit: sLimit, used: sUsed, available: sLimit - sUsed, fullAt: sUsed ? recoveredAt(n(acc?.latest_consume_time), n(acc?.net_window_size), acc?.net_window_optimized) : 0 },
      available: fLimit - fUsed + sLimit - sUsed,
    },
    // a staked TRX gives this much a day (the network's total split by the total staked)
    perTrx: {
      energy: n(r.TotalEnergyWeight) ? n(r.TotalEnergyLimit) / n(r.TotalEnergyWeight) : 0,
      bandwidth: n(r.TotalNetWeight) ? n(r.TotalNetLimit) / n(r.TotalNetWeight) : 0,
    },
    tronPower: { limit: n(r.tronPowerLimit), used: n(r.tronPowerUsed) },
    activated: accountExists(acc) && Object.keys(acc).length > 0,
    account: acc || {},
  };
}

/**
 * What a transaction would burn (sun, bigint) with the account's resources: { bandwidth: { bytes, from: 'staked' |
 * 'free' | 'burn', burn }, energy: { need, covered, burn }, activation, memo, total }.
 * res: resourceState(); params: chainParams(); createsAccount: TRX (or a TRC-10 token) to an address never used.
 */
export function costOf({ res, params, bytes, energy = 0, createsAccount = false, memo = false }) {
  const txFee = BigInt(params.getTransactionFee ?? 1000), energyFee = BigInt(params.getEnergyFee ?? 100);
  const bw = { bytes, from: 'burn', burn: 0n };
  let activation = 0n;
  if (createsAccount) {
    // creating an account takes staked bandwidth only (not the free one), else a fixed fee; and the activation itself
    if (res.bandwidth.staked.available >= bytes) bw.from = 'staked';
    else bw.burn = BigInt(params.getCreateAccountFee ?? 100000);
    activation = BigInt(params.getCreateNewAccountFeeInSystemContract ?? 1_000_000);
  } else if (res.bandwidth.staked.available >= bytes) bw.from = 'staked';
  else if (res.bandwidth.free.available >= bytes) bw.from = 'free';
  else bw.burn = BigInt(bytes) * txFee;
  const covered = Math.min(energy, res.energy.available);
  const en = { need: energy, covered, burn: BigInt(energy - covered) * energyFee };
  const memoFee = memo ? BigInt(params.getMemoFee ?? 1_000_000) : 0n;
  return { bandwidth: bw, energy: en, activation, memo: memoFee, total: bw.burn + en.burn + activation + memoFee };
}

/**
 * The fee limit of a contract call: the most TRX it may burn for energy. Room above the estimate (the dynamic energy
 * of popular contracts changes block by block), never below 15 TRX and never above the network's maximum.
 */
export function feeLimitFor(energy, res, params) {
  const energyFee = BigInt(params.getEnergyFee ?? 100);
  const missing = BigInt(Math.max(0, Math.ceil(energy * 1.3) - res.energy.available));
  const limit = missing * energyFee * 3n / 2n + 5_000_000n;
  const max = BigInt(params.getMaxFeeLimit ?? 15_000_000_000);
  const min = 15_000_000n;
  return Number(limit < min ? min : limit > max ? max : limit);
}

/** TRX price of energy and bandwidth (sun per unit), for the screens. */
export async function unitPrices(chain) {
  const p = await chainParams(chain);
  return { energy: p.getEnergyFee ?? 100, bandwidth: p.getTransactionFee ?? 1000, activation: (p.getCreateNewAccountFeeInSystemContract ?? 1_000_000) + (p.getCreateAccountFee ?? 100000), memo: p.getMemoFee ?? 1_000_000, unstakeDays: p.getUnfreezeDelayDays ?? 14 };
}
