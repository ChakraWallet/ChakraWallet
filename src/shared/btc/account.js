// A Bitcoin account and its addresses. An account (the public side the background gives: src/background/btc.js) is
//   { id, kind: 'hd' | 'electrum' | 'single', fp, receive: [types offered for receiving],
//     branches: [{ type, path, xpub } (HD: receive chain 0, change chain 1) | { type, pub (hex), single: true }] }
// Its funds are spread over many addresses: they are found with the standard "gap limit" (20 unused addresses in a row
// end the search), remembered on the device (public data: addresses and their totals) and refreshed cheaply - the
// addresses holding coins or waiting for a transaction, plus the next few ones - with a full search every 30 minutes
// (an old address may be paid again). The search goes by steps: a chain never used is looked at on its first 5
// addresses only; once an address is found used, the 20 after the last used one. The whole gap of 20 on every chain
// ("look for all the funds again") only when asked. The older address types (1…, 3…) of an account are looked at once: if their
// first addresses were never used they are left out for good.
import { local } from '../ext.js';
import { addressStats, addressUtxos } from './esplora.js';
import { TYPES, branchAddress, addressOf, fromHex } from './keys.js';

export const GAP = 20;
const QUICK_GAP = 3, FIRST_PROBE = 5, FULL_EVERY = 30 * 60e3, LEGACY_PROBE = 3;
const parallel = async (list, fn, n = 4) => {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }));
  return out;
};

/** The account as the driver carries it (the `raw` of its address): a JSON text. */
export const encodeAccount = (a) => JSON.stringify(a);
export function decodeAccount(raw) {
  const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!a?.id || !Array.isArray(a.branches)) throw new Error('bad bitcoin account');
  return a;
}
/** A short key of an account's keys: its saved addresses are thrown away when the keys change. */
const sigOf = (a) => a.branches.map((b) => `${b.type}:${(b.xpub || b.pub || '').slice(-16)}`).join('|');
const stateKey = (chain, a) => `btcscan:${chain.id}:${a.id}`;

/** The address of a position: branch number, chain (0 receive, 1 change), index. */
export function addressAt(chain, a, b, c, i) {
  const br = a.branches[b];
  return br.single ? addressOf(br.type, fromHex(br.pub), chain.net) : branchAddress(br, c, i, chain.net);
}

export async function loadState(chain, a) {
  const s = await local.get(stateKey(chain, a), null);
  return s && s.sig === sigOf(a) ? s : { sig: sigOf(a), addrs: {}, next: {}, issued: {}, skip: {}, full: 0, updated: 0 };
}
export const saveState = (chain, a, s) => local.set(stateKey(chain, a), s);

const posKey = (b, c) => `${b}:${c}`;
const isUsed = (x) => x && x.txs > 0;

/**
 * Looks for the account's funds and refreshes them. full (asked by the user): every used address and a whole gap of 20
 * on every chain, used or not. Otherwise every 30 minutes all the used addresses and 20 after the last used one (a
 * chain never used: its first 5), else those with coins or waiting transactions and a few addresses after the last used.
 * -> the state: { addrs: { [address]: { b, c, i, type, funded, spent, mFunded, mSpent, txs } }, next, issued, skip, … }
 */
export async function scanAccount(chain, a, { full = false } = {}) {
  const s = await loadState(chain, a);
  const doFull = full || !s.updated || Date.now() - s.full > FULL_EVERY;
  const record = (addr, pos, st) => {
    if (st.txs > 0) s.addrs[addr] = { ...pos, type: a.branches[pos.b].type, funded: String(st.funded), spent: String(st.spent), mFunded: String(st.mFunded), mSpent: String(st.mSpent), txs: st.txs };
    else delete s.addrs[addr];
  };
  // 1) the addresses already known as used: all of them on a full search, else those whose coins may move
  const known = Object.entries(s.addrs).filter(([, x]) => doFull || BigInt(x.funded) !== BigInt(x.spent) || x.mFunded !== '0' || x.mSpent !== '0');
  await parallel(known, async ([addr, x]) => { record(addr, { b: x.b, c: x.c, i: x.i }, await addressStats(chain, addr)); });
  // 2) new addresses after the last used one of each branch and chain
  await parallel(a.branches.map((br, b) => ({ br, b })), async ({ br, b }) => {
    if (s.skip[b]) return;
    if (br.single) {
      const addr = addressAt(chain, a, b, 0, 0);
      if (doFull || !s.addrs[addr]) record(addr, { b, c: 0, i: 0 }, await addressStats(chain, addr));
      if (!TYPES[br.type].receive && !s.addrs[addr]) s.skip[b] = true; // an older type never used: not again
      return;
    }
    // an older address type (1…, 3…) of an HD account: its first addresses, once; never used -> left out for good
    if (!TYPES[br.type].receive && s.skip[b] === undefined) {
      const firsts = await parallel([...Array(LEGACY_PROBE).keys()], async (i) => {
        const addr = addressAt(chain, a, b, 0, i);
        const st = await addressStats(chain, addr);
        record(addr, { b, c: 0, i }, st);
        return st.txs > 0;
      });
      if (!firsts.some(Boolean)) { s.skip[b] = true; return; }
      s.skip[b] = false;
    }
    for (const c of [0, 1]) {
      const used = Object.values(s.addrs).filter((x) => x.b === b && x.c === c);
      if (c === 1 && !used.length && !Object.values(s.addrs).some((x) => x.b === b)) continue; // no change without a payment first
      let next = used.length ? Math.max(...used.map((x) => x.i)) + 1 : 0;
      const issued = c === 0 ? s.issued[b] || 0 : 0;
      const wide = doFull || !s.updated;
      // a chain never used: its first addresses (all of the gap only when the user asks)
      let from = next, to = !used.length && !full ? Math.max(wide ? FIRST_PROBE : QUICK_GAP, issued + 1) : next + (wide ? GAP : Math.max(QUICK_GAP, issued - next + 1));
      while (from < to) {
        const idx = [];
        for (let i = from; i < to; i++) idx.push(i);
        const found = await parallel(idx, async (i) => {
          const addr = addressAt(chain, a, b, c, i);
          const st = await addressStats(chain, addr);
          record(addr, { b, c, i }, st);
          return st.txs > 0 ? i : -1;
        });
        const last = Math.max(-1, ...found);
        if (last >= next) { const first = next === 0; next = last + 1; from = to; to = next + (wide || first ? GAP : QUICK_GAP); } else break;
      }
      s.next[posKey(b, c)] = next;
    }
  });
  s.updated = Date.now();
  if (doFull) s.full = s.updated;
  await saveState(chain, a, s);
  return s;
}

/** Confirmed balance and the mempool's change, over every address: { confirmed, pending } (bigint). */
export function totals(s) {
  let confirmed = 0n, pending = 0n;
  for (const x of Object.values(s.addrs)) { confirmed += BigInt(x.funded) - BigInt(x.spent); pending += BigInt(x.mFunded) - BigInt(x.mSpent); }
  return { confirmed, pending };
}
/** Every address of the account the device knows as used: a Set (to recognise its own outputs in transactions). */
export const usedAddresses = (s) => new Set(Object.keys(s.addrs));

/** The first never used address of a receive type (chain 0), or the given position. -> { address, b, c, i, type } */
export function receiveAddress(chain, a, s, type) {
  let b = a.branches.findIndex((x) => x.type === type && (a.receive || []).includes(x.type));
  if (b < 0) b = a.branches.findIndex((x) => (a.receive || []).includes(x.type));
  if (b < 0) b = 0;
  const br = a.branches[b];
  if (br.single) return { address: addressAt(chain, a, b, 0, 0), b, c: 0, i: 0, type: br.type };
  const i = Math.max(s.next[posKey(b, 0)] || 0, s.issued[b] || 0);
  return { address: addressAt(chain, a, b, 0, i), b, c: 0, i, type: br.type };
}
/** A new receive address (the one after the last given): at most 20 unused ones ahead, so other wallets find them. */
export async function newReceiveAddress(chain, a, type) {
  const s = await loadState(chain, a);
  const cur = receiveAddress(chain, a, s, type);
  if (a.branches[cur.b].single) return cur;
  const next = s.next[posKey(cur.b, 0)] || 0;
  if (cur.i + 1 >= next + GAP) return { ...cur, limit: true };
  s.issued[cur.b] = cur.i + 1;
  await saveState(chain, a, s);
  return receiveAddress(chain, a, s, type);
}
/** The address the change of a transaction goes to: the next unused change address of a type (single keys: the key's). */
export function changeAddress(chain, a, s, type) {
  let b = a.branches.findIndex((x) => x.type === type && !s.skip[a.branches.indexOf(x)]);
  if (b < 0) b = a.branches.findIndex((x) => (a.receive || []).includes(x.type));
  const br = a.branches[b];
  if (br.single) return { address: addressAt(chain, a, b, 0, 0), b, c: 0, i: 0, type: br.type };
  const i = s.next[posKey(b, 1)] || 0;
  return { address: addressAt(chain, a, b, 1, i), b, c: 1, i, type: br.type };
}

/**
 * Every address of the account with its position, for the Addresses page: the used ones and, per receive type, the
 * ones given out and not used yet. -> [{ address, b, c, i, type, used, balance (bigint), pending, txs }]
 */
export function listAddresses(chain, a, s) {
  const out = Object.entries(s.addrs).map(([address, x]) => ({ address, b: x.b, c: x.c, i: x.i, type: x.type, used: true, balance: BigInt(x.funded) - BigInt(x.spent), pending: BigInt(x.mFunded) - BigInt(x.mSpent), txs: x.txs }));
  a.branches.forEach((br, b) => {
    if (br.single || !(a.receive || []).includes(br.type)) return;
    const next = s.next[posKey(b, 0)] || 0, upTo = Math.max(next, s.issued[b] || 0);
    for (let i = next; i <= upTo; i++) out.push({ address: addressAt(chain, a, b, 0, i), b, c: 0, i, type: br.type, used: false, balance: 0n, pending: 0n, txs: 0 });
  });
  return out.sort((x, y) => x.b - y.b || x.c - y.c || x.i - y.i);
}

/**
 * The account's coins: [{ txid, vout, value, confirmed, height, address, b, c, i, type }] of every address that holds
 * some or is waiting for a transaction.
 */
export async function loadCoins(chain, a, s) {
  const holders = Object.entries(s.addrs).filter(([, x]) => BigInt(x.funded) + BigInt(x.mFunded) > BigInt(x.spent) + BigInt(x.mSpent) || x.mFunded !== '0');
  const lists = await parallel(holders, async ([address, x]) => (await addressUtxos(chain, address)).map((u) => ({ ...u, address, b: x.b, c: x.c, i: x.i, type: x.type })));
  return lists.flat().sort((x, y) => Number(y.confirmed) - Number(x.confirmed) || (y.value > x.value ? 1 : y.value < x.value ? -1 : 0));
}
