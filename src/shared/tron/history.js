// Tron history from TronGrid's indexer: the account's transactions (and the TRX contracts paid it, "internal"
// transactions) and its TRC-20 transfers, merged by transaction and turned into the shared history items (as
// classify() in src/shared/history.js makes them). Stake, votes, delegations and the other Tron operations get a title
// of their own. Address poisoning, which is everywhere on Tron: zero-value transfers, dust from strangers and fake
// tokens are marked as spam.
import { t, tn } from '../i18n.js';
import { fmtNum } from '../format.js';
import { tronApi } from './api.js';
import { toBase58, fromHex } from './core.js';
import { popularOf, spamTrc20, learnMeta } from './tokens.js';

const PAGE = 40;
/** Contracts whose name says where an operation went. */
export const KNOWN_CONTRACTS = {
  TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax: 'SunSwap', TXF1xDbVGdxFGbovmmmXvBGu8ZiE3Lq4mR: 'SunSwap', TSJEtPuqHpvSaVnSwvCsngaeBxrGUzp95Q: 'SunSwap',
  TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd: 'JustLend', TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7: 'JustLend',
};
const SELECTORS = { a9059cbb: 'transfer', '095ea7b3': 'approve', '23b872dd': 'transferFrom', d0e30db0: 'deposit', '2e1a7d4d': 'withdraw' };
const TRX_DUST = 100_000n; // 0.1 TRX from a stranger: the bait of address poisoning
const resWord = (r) => t(r === 'ENERGY' || r === 1 ? 'tron.res.energy' : 'tron.res.bandwidth');
const trx = (sun) => `${fmtNum(Number(BigInt(sun || 0)) / 1e6, 6)} TRX`;

const memoOf = (hex) => { try { return hex ? new TextDecoder().decode(fromHex(hex)) : ''; } catch { return ''; } };

function record(map, hash) {
  if (!map.has(hash)) map.set(hash, { hash, transfers: [], value: '0', fee: null, status: 'ok', time: 0 });
  return map.get(hash);
}

const G = (icon, tone) => ({ glyph: { icon, tone } });
const resIcon = (r) => (r === 'ENERGY' || r === 1 ? 'flash' : 'signal');

/** The title, the icon and the operation of a transaction that isn't a plain transfer. */
function describe(type, p, me, special) {
  const mine = p.owner_address === me;
  if (special === 'rent') return { label: t('tron.h.rent'), ...G('flash', 'amber') };
  if (special === 'rentReturn') return { label: t('tron.h.rentReturn'), ...G('flash', 'green') };
  switch (type) {
    case 'FreezeBalanceV2Contract': return { label: t('tron.h.stake', { amount: trx(p.frozen_balance), res: resWord(p.resource) }), ...G(resIcon(p.resource), 'amber') };
    case 'UnfreezeBalanceV2Contract': return { label: t('tron.h.unstake', { amount: trx(p.unfreeze_balance), res: resWord(p.resource) }), ...G('timer', 'amber') };
    case 'WithdrawExpireUnfreezeContract': return { label: t('tron.h.withdrawUnstaked'), ...G('receive', 'green') };
    case 'CancelAllUnfreezeV2Contract': return { label: t('tron.h.cancelUnstake'), ...G('refresh', 'primary') };
    case 'DelegateResourceContract': return { label: mine ? t('tron.h.delegate', { amount: trx(p.balance), res: resWord(p.resource) }) : t('tron.h.delegated', { res: resWord(p.resource) }), ...G('share', 'primary') };
    case 'UnDelegateResourceContract': return { label: mine ? t('tron.h.undelegate', { res: resWord(p.resource) }) : t('tron.h.undelegated', { res: resWord(p.resource) }), ...G('share', 'primary') };
    case 'VoteWitnessContract': return { label: tn('tron.h.vote', (p.votes || []).length), ...G('vote', 'primary') };
    case 'WithdrawBalanceContract': return { label: t('tron.h.rewards'), ...G('trophy', 'green') };
    case 'AccountPermissionUpdateContract': return { label: t('tron.h.permissions'), alarm: true, ...G('warn', 'red') };
    case 'AccountCreateContract': return { label: t('tron.h.activate'), ...G('check', 'green') };
    case 'AccountUpdateContract': return { label: t('tron.h.rename') };
    case 'CreateSmartContract': return { label: t('tron.h.deploy'), ...G('code', 'primary') };
    case 'FreezeBalanceContract': return { label: t('tron.h.stakeV1'), ...G('lock', 'amber') };
    case 'UnfreezeBalanceContract': return { label: t('tron.h.unstakeV1'), ...G('lockOpen', 'amber') };
    default: return {};
  }
}
/** JustLend's energy market: renting and giving back energy. */
const RENT_MARKET = 'TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd';
const RENT_SELECTORS = { fd8527a1: 'rent', af6f4896: 'rentReturn' };

/**
 * A TRC-10 token's id from a transfer: TronGrid writes it as the id itself ("1007445") or as its text in hex
 * ("31303037343435"); an id is all digits, which are hex characters too, so the hex is decoded only when it gives digits.
 */
export function trc10Id(name) {
  const s = String(name || '');
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) {
    try { const d = new TextDecoder().decode(fromHex(s)); if (/^\d+$/.test(d)) return d; } catch { /* not hex */ }
  }
  return s;
}

/** TronGrid's raw_data values (addresses in hex) -> addresses as T…. */
function plainParams(v = {}) {
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (/address$/.test(k) && typeof x === 'string') out[k] = toBase58(x) || x;
    else if (k === 'votes' && Array.isArray(x)) out[k] = x.map((y) => ({ ...y, vote_address: toBase58(y.vote_address) || y.vote_address }));
    else out[k] = x;
  }
  return out;
}

/**
 * One page of history. cursor: { tx, tt } (TronGrid's fingerprints of the two lists) or undefined for the first page.
 * -> { items, next, error }
 */
export async function loadTronHistory(chain, owner, cursor) {
  const me = owner;
  const qs = (fp) => `limit=${PAGE}${fp ? `&fingerprint=${encodeURIComponent(fp)}` : ''}`;
  let txs = null, tts = null, error = null;
  try {
    [txs, tts] = await Promise.all([
      !cursor || cursor.tx ? tronApi(chain, `/v1/accounts/${owner}/transactions?${qs(cursor?.tx)}`) : null,
      !cursor || cursor.tt ? tronApi(chain, `/v1/accounts/${owner}/transactions/trc20?${qs(cursor?.tt)}`) : null,
    ]);
  } catch (e) { return { items: [], next: cursor || null, error: e.message, limited: !!e.limited }; }

  const map = new Map();
  const popular = new Map(popularOf(chain).map((p) => [p.address, p]));
  for (const x of txs?.data || []) {
    if (x.internal_tx_id) { // TRX a contract moved inside a transaction (e.g. a swap paying out TRX)
      const v = BigInt(x.data?.call_value?._ || 0);
      const from = toBase58(x.from_address) || x.from_address, to = toBase58(x.to_address) || x.to_address;
      if (!v || x.data?.rejected || (from !== me && to !== me)) continue;
      const r = record(map, x.tx_id);
      r.time ||= x.block_timestamp;
      r.transfers.push({ from, to, token: 'TRX', symbol: chain.native.symbol, decimals: 6, amount: v.toString(), native: true, icon: '' });
      continue;
    }
    const c = x.raw_data?.contract?.[0];
    if (!c) continue;
    try { readTx(x, c); } catch { /* a transaction the app doesn't understand: the others still show */ }
  }
  function readTx(x, c) {
    const p = plainParams(c.parameter?.value);
    const r = record(map, x.txID);
    const ret = x.ret?.[0] || {};
    Object.assign(r, {
      time: x.block_timestamp || x.raw_data.timestamp, from: p.owner_address, type: c.type, params: p, isTx: true,
      to: p.to_address || p.contract_address || p.receiver_address || null,
      status: ret.contractRet && ret.contractRet !== 'SUCCESS' ? 'failed' : 'ok',
      fee: String(BigInt(ret.fee || 0) || BigInt(x.energy_fee || 0) + BigInt(x.net_fee || 0)),
      memo: memoOf(x.raw_data.data),
    });
    if (c.type === 'TransferContract') {
      r.transfers.push({ from: p.owner_address, to: p.to_address, token: 'TRX', symbol: chain.native.symbol, decimals: 6, amount: String(p.amount || 0), native: true, icon: '' });
    } else if (c.type === 'TransferAssetContract') {
      const id = trc10Id(p.asset_name);
      r.transfers.push({ from: p.owner_address, to: p.to_address, token: id, symbol: `#${id}`, decimals: 0, amount: String(p.amount || 0), trc10: true, icon: '' });
    } else if (c.type === 'TriggerSmartContract') {
      const sel = String(p.data || '').slice(0, 8);
      r.method = SELECTORS[sel] || (sel ? `0x${sel}` : null);
      r.via = KNOWN_CONTRACTS[p.contract_address] || null;
      if (p.contract_address === RENT_MARKET) r.special = RENT_SELECTORS[sel] || null;
      if (p.call_value) r.transfers.push({ from: p.owner_address, to: p.contract_address, token: 'TRX', symbol: chain.native.symbol, decimals: 6, amount: String(p.call_value), native: true, icon: '' });
    }
  }
  const seen = [];
  for (const x of tts?.data || []) {
    if (x.type && x.type !== 'Transfer') continue; // approvals: the transaction says it
    const ti = x.token_info || {};
    const r = record(map, x.transaction_id);
    r.time ||= x.block_timestamp;
    const known = popular.get(ti.address);
    r.transfers.push({ from: x.from, to: x.to, token: ti.address, symbol: known?.symbol || ti.symbol || '???', decimals: Number(known?.decimals ?? ti.decimals ?? 0), amount: String(x.value || 0), name: ti.name || '', icon: known?.icon || '', spamToken: spamTrc20(chain, { address: ti.address, symbol: ti.symbol, name: ti.name }) });
    if (ti.address && !known) seen.push({ address: ti.address, symbol: ti.symbol, name: ti.name, decimals: ti.decimals });
  }
  learnMeta(chain, seen).catch(() => {});

  const items = [...map.values()].map((r) => classify(r, me, chain)).sort((a, b) => b.time - a.time);
  const next = { tx: txs?.meta?.fingerprint || null, tt: tts?.meta?.fingerprint || null };
  return { items, next: next.tx || next.tt ? next : null, error };
}

/** A merged record -> the shared history item. */
export function classify(r, me, chain) {
  const sentByMe = r.from === me;
  const agg = new Map();
  let dust = false, zero = false, fake = false;
  for (const x of r.transfers) {
    if (x.from === me && x.to === me) continue;
    const amount = BigInt(x.amount || 0);
    if (amount === 0n) { zero = true; continue; } // zero-value transfers: address poisoning
    let dir;
    if (x.from === me) dir = 'out'; else if (x.to === me) dir = 'in'; else continue;
    if (x.spamToken) fake = true;
    if (dir === 'in' && x.native && amount < TRX_DUST && !sentByMe) dust = true;
    if (dir === 'out' && !sentByMe && !r.isTx && x.spamToken) continue; // "sent" by a fake token's own contract
    const key = `${dir}:${x.token}`;
    if (agg.has(key)) agg.get(key).amount = (BigInt(agg.get(key).amount) + amount).toString();
    else agg.set(key, { dir, symbol: x.symbol, decimals: x.decimals, amount: amount.toString(), icon: x.icon, token: x.token, native: !!x.native, ...(x.trc10 ? { trc10: true } : {}), counterparty: dir === 'out' ? x.to : x.from });
  }
  const transfers = [...agg.values()];
  const outs = transfers.filter((x) => x.dir === 'out'), ins = transfers.filter((x) => x.dir === 'in');
  const d = describe(r.type, r.params || {}, me, r.special);
  let kind;
  if (r.method === 'approve' && sentByMe) kind = 'approve';
  else if (outs.length && ins.length) kind = 'swap';
  else if (outs.length) kind = 'send';
  else if (ins.length) kind = 'receive';
  else kind = 'contract';
  const approved = kind === 'approve' ? popularOf(chain).find((p) => p.address === r.to)?.symbol : null;
  // a rent pays TRX to the market: still the rent, with the TRX it cost
  if (d.label && r.special && kind === 'send') kind = 'contract';
  const label = approved ? t('history.titleApproveToken', { symbol: approved }) : kind === 'contract' || (d.label && !transfers.length) ? d.label : undefined;
  // tokens "sent" by me in a transaction I didn't sign, fake tokens, dust and zero-value transfers: poisoning
  const spam = !sentByMe && !d.alarm && (fake || dust || (zero && !transfers.length) || (outs.length > 0 && !r.isTx));
  return {
    hash: r.hash, time: r.time || 0, kind, transfers, status: r.status, from: r.from || null, to: r.to || null,
    fee: sentByMe && r.fee != null ? r.fee : null, sentByMe, spam, ...(label ? { label } : {}), ...(r.via ? { via: r.via } : {}),
    ...(r.memo ? { comment: r.memo } : {}), ...(r.method && kind === 'contract' && !label ? { method: r.method } : {}),
    ...(d.alarm ? { alarm: true } : {}), ...(d.glyph && kind === 'contract' ? { glyph: d.glyph } : {}),
    counterparty: kind === 'send' ? outs[0]?.counterparty : kind === 'receive' ? ins[0]?.counterparty : r.to,
    tronType: r.type || null,
  };
}

