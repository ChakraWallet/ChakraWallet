// What a typed-data signature (eth_signTypedData_v4) gives away, read from its content: a signature can't be
// simulated (nothing happens until someone uses it), so the known kinds are recognised one by one. No UI here.
// - spending permits: EIP-2612 `Permit`, DAI's `Permit` (allowed: unlimited), Uniswap's Permit2 (one token or a batch,
//   lasting permissions or a single transfer);
// - Seaport orders (OpenSea and the marketplaces on it): what the signer gives and what comes back to them.
import { isUnlimited, PERMIT2 } from './simulate.js';

const lc = (a) => String(a || '').toLowerCase();
const big = (v) => { try { return BigInt(String(v)); } catch { return null; } };
const NEVER = 10 * 365 * 86400; // an expiry more than ten years ahead is no expiry

/** Unix seconds -> { at, never } ('at' null: no expiry given; 0 in Permit2 = only in the same block). */
function expiry(v, now) {
  const n = big(v);
  if (n == null || n === 0n) return { at: null, never: false };
  return n > BigInt(now + NEVER) ? { at: null, never: true } : { at: Number(n), never: false };
}

/**
 * A spending permit: { kind: 'permit'|'dai'|'permit2'|'permit2transfer', spender, items: [{ token, amount, unlimited }],
 * at, never, revoke } or null. permit2transfer: a single transfer of the amount (not a lasting permission).
 */
export function readPermit(typed, now = Math.floor(Date.now() / 1000)) {
  const pt = String(typed?.primaryType || '');
  const m = typed?.message || {};
  const domain = typed?.domain || {};
  const isPermit2 = lc(domain.verifyingContract) === PERMIT2 || domain.name === 'Permit2';
  if (isPermit2) {
    if (/^Permit(Single|Batch)$/.test(pt)) {
      const details = Array.isArray(m.details) ? m.details : [m.details].filter(Boolean);
      const items = details.map((d) => ({ token: lc(d.token), amount: big(d.amount) ?? 0n, unlimited: isUnlimited(big(d.amount) ?? 0n, 160) }));
      // the shortest expiry of the batch
      const exps = details.map((d) => expiry(d.expiration, now));
      const timed = exps.filter((e) => e.at != null).sort((a, b) => a.at - b.at);
      return { kind: 'permit2', spender: lc(m.spender), items, at: timed[0]?.at ?? null, never: !timed.length && exps.some((e) => e.never), revoke: items.every((i) => i.amount === 0n) };
    }
    if (/TransferFrom$/.test(pt)) { // PermitTransferFrom, PermitBatchTransferFrom, their Witness versions (UniswapX orders)
      const permitted = Array.isArray(m.permitted) ? m.permitted : [m.permitted].filter(Boolean);
      const items = permitted.map((p) => ({ token: lc(p.token), amount: big(p.amount) ?? 0n, unlimited: isUnlimited(big(p.amount) ?? 0n) }));
      return { kind: 'permit2transfer', spender: lc(m.spender), items, ...expiry(m.deadline, now), revoke: false };
    }
    return null;
  }
  if (pt === 'Permit' && 'allowed' in m) { // DAI: all or nothing
    const allowed = m.allowed === true || m.allowed === 'true';
    return { kind: 'dai', spender: lc(m.spender), items: [{ token: lc(domain.verifyingContract), amount: null, unlimited: allowed }], ...expiry(m.expiry, now), revoke: !allowed };
  }
  if (pt === 'Permit' && m.spender && m.value != null) { // EIP-2612
    const amount = big(m.value) ?? 0n;
    return { kind: 'permit', spender: lc(m.spender), items: [{ token: lc(domain.verifyingContract), amount, unlimited: isUnlimited(amount) }], ...expiry(m.deadline, now), revoke: amount === 0n };
  }
  return null;
}

// Seaport item types
const NATIVE = 0, ERC20 = 1;
const isNft = (type) => type >= 2; // ERC-721, ERC-1155 and their "with criteria" versions (any item of a collection)

/**
 * A Seaport order: { give: [{ type, token, id, amount, nft }], get: [...], toOthers: [...], free } or null.
 * give: what the signer offers; get: what comes back to them; toOthers: the rest (fees, royalties - or a thief);
 * free: NFTs or tokens leave and nothing comes back (the classic "list for zero" phishing signature).
 */
export function readSeaport(typed) {
  if (typed?.domain?.name !== 'Seaport' || typed?.primaryType !== 'OrderComponents') return null;
  const m = typed.message || {};
  const offerer = lc(m.offerer);
  const item = (x) => {
    const type = Number(x.itemType);
    const start = big(x.startAmount) ?? 0n, end = big(x.endAmount) ?? 0n;
    return { type, token: lc(x.token), id: big(x.identifierOrCriteria), amount: start > end ? start : end, nft: isNft(type), criteria: type >= 4 };
  };
  const give = (m.offer || []).map(item);
  const cons = (m.consideration || []).map((x) => ({ ...item(x), recipient: lc(x.recipient) }));
  const get = cons.filter((x) => x.recipient === offerer);
  const toOthers = cons.filter((x) => x.recipient !== offerer);
  const free = give.length > 0 && !get.some((x) => x.amount > 0n);
  return { offerer, give, get, toOthers, free };
}

export const SEAPORT_TYPES = { NATIVE, ERC20 };
