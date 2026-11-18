// Tron's own operations around energy and bandwidth (Stake 2.0): staking TRX for a resource, unstaking (the TRX come
// back after the network's waiting time), delegating resources to another address, voting for Super Representatives
// with the staked TRX (Tron Power) and claiming the rewards; who controls the account (its permissions). Reads from
// the node and transaction builders (src/shared/tron/proto.js contracts); renting energy: rent.js.
import { tronApi, getAccount } from './api.js';
import { RESOURCE } from './proto.js';
import { toBase58 } from './core.js';

/** An address as the node wrote it -> T… (some calls answer in hex even when asked for T…, e.g. listwitnesses). */
const addr = (a) => toBase58(a) || a;

/**
 * What a resource buys, for the screens. Energy is spent by any contract call; the screens count it in token transfers,
 * measured on a USDT transfer (the most common one on Tron: to a holder; about twice to a new one). Bandwidth: a TRX
 * send's bytes, a token transfer's.
 */
export const USDT_ENERGY = 65_000;
export const USDT_ENERGY_NEW = 130_000;
export const TRX_SEND_BYTES = 268;
export const TOKEN_SEND_BYTES = 345;

/** How many of the usual operations the account's resources pay for now: { tokens (token transfers), sends (TRX sends) }. */
export function coverage(res) {
  return { tokens: Math.floor(res.energy.available / USDT_ENERGY), sends: Math.floor(res.bandwidth.available / TRX_SEND_BYTES) };
}

// ------------------------------------------------------------ stake
const n = (v) => BigInt(v || 0);

/**
 * The account's TRX in Stake 2.0 (sun, bigint): { energy, bandwidth } staked for its own use, { delegatedEnergy,
 * delegatedBandwidth } staked and given to others, unstaking: [{ amount, resource, at }] (ready when at <= now),
 * withdrawable (sum of the ready ones), votes: [{ address, count }], power: { total, used } (votes = whole TRX).
 */
export function stakeOverview(acc) {
  let energy = 0n, bandwidth = 0n;
  for (const f of acc?.frozenV2 || []) {
    if (f.type === 'ENERGY') energy += n(f.amount); else if (!f.type || f.type === 'BANDWIDTH') bandwidth += n(f.amount);
  }
  const delegatedEnergy = n(acc?.account_resource?.delegated_frozenV2_balance_for_energy);
  const delegatedBandwidth = n(acc?.delegated_frozenV2_balance_for_bandwidth);
  const now = Date.now();
  const unstaking = (acc?.unfrozenV2 || []).map((u) => ({ amount: n(u.unfreeze_amount), resource: u.type || 'BANDWIDTH', at: Number(u.unfreeze_expire_time || 0) }))
    .filter((u) => u.amount > 0n).sort((a, b) => a.at - b.at);
  const withdrawable = unstaking.filter((u) => u.at <= now).reduce((s, u) => s + u.amount, 0n);
  const votes = (acc?.votes || []).map((v) => ({ address: addr(v.vote_address), count: Number(v.vote_count || 0) }));
  const total = Number((energy + bandwidth + delegatedEnergy + delegatedBandwidth) / 1_000_000n);
  return { energy, bandwidth, delegatedEnergy, delegatedBandwidth, unstaking, withdrawable, votes, power: { total, used: votes.reduce((s, v) => s + v.count, 0) } };
}

export const stakeTx = (owner, sun, resource) => ({ type: 'FreezeBalanceV2Contract', parameter: { owner_address: owner, frozen_balance: BigInt(sun), resource: RESOURCE[resource] } });
export const unstakeTx = (owner, sun, resource) => ({ type: 'UnfreezeBalanceV2Contract', parameter: { owner_address: owner, unfreeze_balance: BigInt(sun), resource: RESOURCE[resource] } });
export const withdrawTx = (owner) => ({ type: 'WithdrawExpireUnfreezeContract', parameter: { owner_address: owner } });
export const cancelUnstakeTx = (owner) => ({ type: 'CancelAllUnfreezeV2Contract', parameter: { owner_address: owner } });
/** lockDays: the delegation can't be taken back before (0 = whenever). */
export const delegateTx = (owner, receiver, sun, resource, lockDays = 0) => ({
  type: 'DelegateResourceContract',
  parameter: { owner_address: owner, receiver_address: receiver, balance: BigInt(sun), resource: RESOURCE[resource], lock: lockDays > 0, lock_period: lockDays > 0 ? lockDays * 28800 : 0 },
});
export const undelegateTx = (owner, receiver, sun, resource) => ({ type: 'UnDelegateResourceContract', parameter: { owner_address: owner, receiver_address: receiver, balance: BigInt(sun), resource: RESOURCE[resource] } });
/** votes: [{ address, count }]: the new votes replace all the previous ones. */
export const voteTx = (owner, votes) => ({ type: 'VoteWitnessContract', parameter: { owner_address: owner, votes: votes.filter((v) => v.count > 0).map((v) => ({ vote_address: v.address, vote_count: v.count })) } });
export const claimTx = (owner) => ({ type: 'WithdrawBalanceContract', parameter: { owner_address: owner } });

/** How much the account can still delegate, per resource (sun). */
export async function canDelegate(chain, owner) {
  const [e, b] = await Promise.all([1, 0].map((type) => tronApi(chain, '/wallet/getcandelegatedmaxsize', { owner_address: owner, type }).catch(() => ({}))));
  return { ENERGY: n(e.max_size), BANDWIDTH: n(b.max_size) };
}

/**
 * Delegations of an account: out (to others) and in (from others), each { address, energy, bandwidth (sun),
 * energyLock, bandwidthLock (ms: not revocable before) }.
 */
export async function delegations(chain, owner) {
  const idx = await tronApi(chain, '/wallet/getdelegatedresourceaccountindexv2', { value: owner });
  const read = async (from, to) => {
    const j = await tronApi(chain, '/wallet/getdelegatedresourcev2', { fromAddress: from, toAddress: to }).catch(() => null);
    const list = j?.delegatedResource || [];
    return list.reduce((s, d) => ({
      energy: s.energy + n(d.frozen_balance_for_energy), bandwidth: s.bandwidth + n(d.frozen_balance_for_bandwidth),
      energyLock: Math.max(s.energyLock, Number(d.expire_time_for_energy || 0)), bandwidthLock: Math.max(s.bandwidthLock, Number(d.expire_time_for_bandwidth || 0)),
    }), { energy: 0n, bandwidth: 0n, energyLock: 0, bandwidthLock: 0 });
  };
  const out = [], inn = [];
  for (const to of (idx.toAccounts || []).slice(0, 30).map(addr)) out.push({ address: to, ...(await read(owner, to)) });
  for (const from of (idx.fromAccounts || []).slice(0, 30).map(addr)) inn.push({ address: from, ...(await read(from, owner)) });
  return { out: out.filter((d) => d.energy || d.bandwidth), in: inn.filter((d) => d.energy || d.bandwidth) };
}

// ------------------------------------------------------------ votes
/** Voting rewards ready to claim (sun). */
export async function rewards(chain, owner) {
  const j = await tronApi(chain, '/wallet/getReward', { address: owner }).catch(() => null);
  return n(j?.reward);
}

const srCache = new Map(); // chain id -> { at, list }
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return String(u || '').slice(0, 40); } };
/**
 * Super Representatives and candidates, by votes: [{ address, name (their website), votes, rank, producing (top 27) }].
 * Cached for 30 minutes.
 */
export async function superReps(chain) {
  const c = srCache.get(chain.id);
  if (c && Date.now() - c.at < 30 * 60e3) return c.list;
  const j = await tronApi(chain, '/wallet/listwitnesses', {});
  const list = (j.witnesses || []).map((w) => ({ address: addr(w.address), name: hostOf(w.url), url: w.url, votes: Number(w.voteCount || 0) }))
    .sort((a, b) => b.votes - a.votes).map((w, i) => ({ ...w, rank: i + 1, producing: i < 27 }));
  srCache.set(chain.id, { at: Date.now(), list });
  return list;
}

const brokerages = new Map(); // address -> percent kept by the SR
/** The share of the rewards a Super Representative keeps (percent), cached. */
export async function brokerage(chain, address) {
  if (brokerages.has(address)) return brokerages.get(address);
  const j = await tronApi(chain, '/wallet/getBrokerage', { address }).catch(() => null);
  const b = j?.brokerage == null ? null : Number(j.brokerage);
  if (b != null) brokerages.set(address, b);
  return b;
}

/**
 * Yearly return of voting for a Super Representative (fraction, e.g. 0.035): its block rewards (top 27) and its share
 * of the vote rewards (the 127 most voted, by votes), less what it keeps (brokerage), split by the votes it has.
 * params: chain parameters (getWitnessPayPerBlock, getWitness127PayPerBlock).
 */
export function voteApr(sr, list, params, brokeragePct) {
  if (!sr || !sr.votes || brokeragePct == null) return null;
  const BLOCKS = 28800; // a day
  const top127 = list.slice(0, 127).reduce((s, w) => s + w.votes, 0);
  const blockPay = Number(params.getWitnessPayPerBlock ?? 8e6) / 1e6, votePay = Number(params.getWitness127PayPerBlock ?? 128e6) / 1e6;
  const blocks = sr.rank <= 27 ? (BLOCKS / 27) * blockPay : 0;
  const voteShare = sr.rank <= 127 && top127 ? (BLOCKS * votePay * sr.votes) / top127 : 0;
  return (((blocks + voteShare) * (100 - brokeragePct)) / 100 / sr.votes) * 365;
}

// ------------------------------------------------------------ who controls the account
/**
 * The account's permissions: { safe, owner: [addresses], active: [addresses], others: [addresses that aren't the
 * account] }. safe: only the account's own key can move its funds (as for every new account).
 */
export function permissionsOf(acc, address) {
  const keys = (p) => (p?.keys || []).map((k) => addr(k.address));
  const owner = acc?.owner_permission ? keys(acc.owner_permission) : [address];
  const active = (acc?.active_permission || []).flatMap(keys);
  const others = [...new Set([...owner, ...active].filter((a) => a !== address))];
  return { safe: others.length === 0, owner, active, others };
}

export { getAccount };
