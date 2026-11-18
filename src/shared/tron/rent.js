// Renting energy from JustLend DAO's energy market (on chain, no account, no key): the market delegates the energy of
// staked TRX to the address for as long as the rent paid in advance (a deposit) lasts. The rent runs by the second;
// what is left of the deposit comes back when the energy is given back (or, when the deposit runs out, a liquidator
// closes the rental and the rest goes back). Contract: docs.justlend.org/developers/energy_rental; every number here is
// read from the contract itself. Mainnet only.
import { Interface } from 'ethers';
import { constantCall } from './api.js';
import { toEvmAddress } from './core.js';
import { RESOURCE } from './proto.js';

export const RENT_MARKET = { [-195]: 'TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd' };
export const rentMarketOf = (chain) => RENT_MARKET[chain.id] || null;
const MARKET = new Interface([
  'function _rentalRate(uint256 amount, uint256 resourceType) view returns (uint256)',
  'function _stableRate(uint256 resourceType) view returns (uint256)',
  'function minFee() view returns (uint256)',
  'function feeRatio() view returns (uint256)',
  'function liquidateThreshold() view returns (uint256)',
  'function rentPaused(uint256 resourceType) view returns (bool)',
  'function rentals(address renter, address receiver, uint256 resourceType) view returns (uint256 amount, uint256 securityDeposit, uint256 rentIndex)',
  'function getRentInfo(address renter, address receiver, uint256 resourceType) view returns (uint256, uint256, bool)',
  'function rentResource(address receiver, uint256 amount, uint256 resourceType) payable',
  'function returnResource(address receiver, uint256 amount, uint256 resourceType) returns (uint256)',
]);
const E18 = 10n ** 18n;
const DAY = 86400n;

async function read(chain, fn, args = [], owner) {
  const r = await constantCall(chain, { owner, contract: rentMarketOf(chain), data: MARKET.encodeFunctionData(fn, args).slice(2) });
  if (!r.ok || !r.result) throw new Error(r.message || `${fn}: no answer`);
  return MARKET.decodeFunctionResult(fn, `0x${r.result}`);
}

/** The market's terms for energy: { stable (rate per sun per second, ×1e18), minFee, feeRatio (×1e18), threshold (s), paused }. */
export async function rentTerms(chain) {
  const T = RESOURCE.ENERGY;
  const [stable, minFee, feeRatio, threshold, paused] = await Promise.all([
    read(chain, '_stableRate', [T]), read(chain, 'minFee'), read(chain, 'feeRatio'), read(chain, 'liquidateThreshold'), read(chain, 'rentPaused', [T]),
  ]);
  return { stable: stable[0], minFee: minFee[0], feeRatio: feeRatio[0], threshold: threshold[0], paused: paused[0] };
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * A rental of `energyPerDay` (the energy it gives back every day) for `days`. energyPerTrx: energy a staked TRX gives
 * (fees.resourceState().perTrx.energy). -> { amount (sun of TRX delegated), rentPerDay, rent (for the days), fee,
 * prepay (sent now: the rent for the days, a day of margin the market asks, its fee), burn (what the same energy would
 * cost burning TRX, used once a day for the days) } in sun (bigint).
 */
export async function rentQuote(chain, { terms, energyPerDay, days, energyPerTrx, energyFee }) {
  const trx = BigInt(Math.max(2, Math.ceil(energyPerDay / Math.max(energyPerTrx, 1e-9))));
  const amount = trx * 1_000_000n;
  const rate = (await read(chain, '_rentalRate', [amount, RESOURCE.ENERGY]))[0];
  const r = rate > terms.stable ? rate : terms.stable;
  const rentPerDay = ceilDiv(amount * r * DAY, E18);
  const rent = rentPerDay * BigInt(days);
  const pct = ceilDiv(amount * terms.feeRatio, E18);
  const fee = pct > terms.minFee ? pct : terms.minFee;
  const prepay = ceilDiv(amount * r * (BigInt(days) * DAY + DAY + BigInt(terms.threshold)), E18) + fee;
  const burn = BigInt(Math.round(energyPerDay * days)) * BigInt(energyFee ?? 100);
  return { amount, rentPerDay, rent, fee, prepay, burn, cost: rent + fee };
}

/**
 * The account's current rental (for itself): { amount (sun delegated), deposit (sun left, rent accrued), liquidatable,
 * daysLeft } or null.
 */
export async function myRental(chain, renter, receiver = renter) {
  if (!rentMarketOf(chain)) return null;
  const T = RESOURCE.ENERGY;
  const [rental, info] = await Promise.all([
    read(chain, 'rentals', [toEvmAddress(renter), toEvmAddress(receiver), T], renter),
    read(chain, 'getRentInfo', [toEvmAddress(renter), toEvmAddress(receiver), T], renter),
  ]);
  const amount = rental[0];
  if (!amount) return null;
  const deposit = info[0];
  const rate = (await read(chain, '_rentalRate', [amount, T]))[0];
  const perDay = (amount * rate * DAY) / E18;
  return { amount, deposit, liquidatable: !!info[2], perDay, daysLeft: perDay ? Number(deposit) / Number(perDay) : null };
}

/** Rents `amount` sun of delegated TRX worth of energy for `receiver`, paying `prepay` now. */
export const rentTx = (owner, receiver, amount, prepay, market) => ({
  type: 'TriggerSmartContract',
  parameter: { owner_address: owner, contract_address: market, call_value: BigInt(prepay), data: MARKET.encodeFunctionData('rentResource', [toEvmAddress(receiver), BigInt(amount), RESOURCE.ENERGY]).slice(2) },
});
/** Gives the rented energy back: what is left of the deposit returns to the renter. */
export const returnTx = (owner, receiver, amount, market) => ({
  type: 'TriggerSmartContract',
  parameter: { owner_address: owner, contract_address: market, data: MARKET.encodeFunctionData('returnResource', [toEvmAddress(receiver), BigInt(amount), RESOURCE.ENERGY]).slice(2) },
});
