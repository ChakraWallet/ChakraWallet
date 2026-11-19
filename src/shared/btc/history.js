// Bitcoin history of an account: the transactions of all its addresses, merged (one row per transaction) and in time
// order across pages, in the shared item shape (classify() in src/shared/history.js). What the account paid and got
// is computed from the inputs and outputs that are its own: change and moves between its addresses don't count as
// payments. The transactions this wallet sent (src/background/btc.js keeps them) show at once, also when they were
// replaced (speed up, cancel) or dropped from the mempool.
import { t } from '../i18n.js';
import { local } from '../ext.js';
import { addressTxs, getTx, replacedBy } from './esplora.js';
import { loadState, scanAccount, usedAddresses } from './account.js';
import { hasInscription, hasRunestone } from './runes.js';
import { oneRowPerOperation } from '../history.js';

const PAGE = 25; // confirmed transactions per address and page (Esplora's)
export const SENT_KEY = (chain) => `btcsent:${chain.id}`;
/** What this wallet sent on a network: { [txid]: { txid, account, time, plan, fee, vsize, rate, title, origin, mode?, replaces? } }. */
export const sentLog = (chain) => local.get(SENT_KEY(chain), {});

const timeOf = (tx, log) => (tx.status?.confirmed ? (tx.status.block_time || 0) * 1000 : log?.[tx.txid]?.time || Date.now());

/** One transaction (Esplora's JSON) as a history item, seen from the account (own: its addresses). */
export function classifyTx(chain, tx, own, logEntry = null) {
  let myIn = 0n, myOut = 0n, toOthers = 0n, fromOthers = null, toOther = null;
  for (const v of tx.vin || []) {
    const a = v.prevout?.scriptpubkey_address;
    if (a && own.has(a)) myIn += BigInt(v.prevout.value || 0);
    else if (!fromOthers && a) fromOthers = a;
  }
  for (const o of tx.vout || []) {
    const a = o.scriptpubkey_address;
    if (a && own.has(a)) myOut += BigInt(o.value || 0);
    else if (a) { toOthers += BigInt(o.value || 0); toOther ||= a; }
  }
  const sentByMe = myIn > 0n;
  const sym = chain.native.symbol, dec = chain.native.decimals;
  const transfer = (dir, amount, counterparty) => ({ dir, symbol: sym, decimals: dec, amount: amount.toString(), icon: '', token: 'native', native: true, counterparty });
  let kind, transfers = [], label;
  if (sentByMe && toOthers > 0n) { kind = 'send'; transfers = [transfer('out', toOthers, toOther)]; }
  else if (sentByMe) { kind = 'contract'; label = t('btc.h.self'); } // between the account's own addresses
  else if (myOut > 0n) { kind = 'receive'; transfers = [transfer('in', myOut, fromOthers)]; }
  else { kind = 'contract'; }
  const notes = [];
  if (hasRunestone(tx)) notes.push(t('btc.h.runes'));
  if (hasInscription(tx)) notes.push(t('btc.h.inscription'));
  return {
    hash: tx.txid, time: timeOf(tx, { [tx.txid]: logEntry }), kind, transfers, status: tx.status?.confirmed ? 'ok' : 'pending',
    from: fromOthers, to: toOther, fee: sentByMe && tx.fee != null ? String(tx.fee) : null, sentByMe, spam: false,
    counterparty: kind === 'send' ? toOther : kind === 'receive' ? fromOthers : null,
    ...(label ? { label } : {}), ...(notes.length ? { comment: notes.join(' · ') } : {}),
    ...(logEntry ? logFields(logEntry) : {}),
    btc: { vsize: tx.weight ? Math.ceil(tx.weight / 4) : null, fee: tx.fee ?? null, confirmed: !!tx.status?.confirmed },
  };
}
const logFields = (l) => ({
  ...(l.title ? { appTitle: l.title } : {}), ...(l.origin && l.origin !== 'Chakra' ? { via: l.origin } : {}),
  replaceable: true, ...(l.replaces ? { replaces: l.replaces } : {}), ...(l.mode ? { replacement: l.mode === 'cpfp' ? 'speedUp' : l.mode } : {}),
  ...(l.mode === 'cpfp' ? { label: t('btc.h.cpfp') } : {}),
});

/** A sent transaction no service knows any more (replaced or dropped), as a history item from what the wallet kept. */
async function lostRecord(chain, l) {
  const by = await replacedBy(chain, l.txid);
  const toOthers = (l.plan?.outputs || []).filter((o) => o.address && !o.own).reduce((s, o) => s + BigInt(o.value), 0n);
  const first = (l.plan?.outputs || []).find((o) => o.address && !o.own)?.address || null;
  return {
    hash: l.txid, time: l.time, kind: toOthers > 0n ? 'send' : 'contract', status: by ? 'replaced' : 'dropped', sentByMe: true, spam: false,
    transfers: toOthers > 0n ? [{ dir: 'out', symbol: chain.native.symbol, decimals: chain.native.decimals, amount: toOthers.toString(), icon: '', token: 'native', native: true, counterparty: first }] : [],
    from: null, to: first, counterparty: first, fee: l.fee != null ? String(l.fee) : null, ...logFields(l),
    ...(toOthers > 0n ? {} : { label: t('btc.h.self') }), btc: { vsize: l.vsize, fee: l.fee, confirmed: false },
  };
}

/**
 * One page of an account's history. cursor: null (first page) or { after: { [address]: last txid }, buffer: [items] }.
 * -> { items, next, error }
 */
export async function loadBtcHistory(chain, a, cursor = null) {
  let s = await loadState(chain, a);
  if (!s.updated) s = await scanAccount(chain, a);
  const own = usedAddresses(s);
  const log = Object.fromEntries(Object.entries(await sentLog(chain)).filter(([, l]) => l.account === a.id));
  const addrs = cursor ? Object.keys(cursor.after || {}) : [...own];
  const seen = new Map((cursor?.buffer || []).map((x) => [x.txid, x]));
  const more = {}; // address -> its oldest confirmed txid fetched, when it may have more
  const oldest = {}; // address -> time of that transaction
  let error = null, i = 0;
  await Promise.all(Array.from({ length: Math.min(4, addrs.length) }, async () => {
    while (i < addrs.length) {
      const address = addrs[i++];
      try {
        const list = await addressTxs(chain, address, cursor?.after?.[address] || null);
        for (const tx of list) seen.set(tx.txid, tx);
        const confirmed = list.filter((tx) => tx.status?.confirmed);
        if (confirmed.length >= PAGE) {
          const last = confirmed[confirmed.length - 1];
          more[address] = last.txid;
          oldest[address] = (last.status.block_time || 0) * 1000;
        }
      } catch (e) { error = e.message; }
    }
  }));
  // what can be shown now: everything newer than the oldest transaction of any address that has more to give
  const frontier = Object.keys(more).length ? Math.max(...Object.values(oldest)) : 0;
  const all = [...seen.values()];
  const ready = all.filter((tx) => !tx.status?.confirmed || (tx.status.block_time || 0) * 1000 >= frontier);
  const later = all.filter((tx) => !ready.includes(tx));
  let items = ready.map((tx) => classifyTx(chain, tx, own, log[tx.txid] || null));
  // sent from this wallet and no longer known: replaced or dropped (first page only)
  if (!cursor) {
    const known = new Set(all.map((tx) => tx.txid));
    const lost = Object.values(log).filter((l) => !known.has(l.txid) && Date.now() - l.time < 14 * 864e5);
    for (const l of lost) {
      try {
        const tx = await getTx(chain, l.txid);
        items.push(tx ? classifyTx(chain, tx, own, l) : await lostRecord(chain, l));
      } catch { /* the service is down: next time */ }
    }
    items = oneRowPerOperation(items, Object.values(log).map((l) => ({ hash: l.txid, replaces: l.replaces || null })));
  }
  items.sort((x, y) => (y.status === 'pending') - (x.status === 'pending') || y.time - x.time);
  const next = Object.keys(more).length || later.length ? { after: more, buffer: later } : null;
  return { items, next, error: items.length ? null : error };
}
