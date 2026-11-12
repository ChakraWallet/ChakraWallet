// Transaction history from free indexers (Blockscout v2 / Etherscan-compatible), normalized.
import { etherscanUrl, isSpamToken } from './portfolio.js';
import { rpc } from './rpc.js';

const lc = (a) => String(a || '').toLowerCase();

import { getJson as httpJson } from './http.js';

const getJson = (url) => httpJson(url, { label: 'Indexer HTTP' });

// A token "sent" by me in a transaction that is not among my transactions (within the period covered by the
// transaction page) was emitted by someone else's contract: an address-poisoning fake.
function markNotMine(map, address, since) {
  const me = lc(address);
  for (const r of map.values()) if (!r.isTx && (r.time || 0) >= since && r.transfers.some((t) => t.from === me)) r.notMine = true;
}

function record(map, hash) {
  if (!map.has(hash)) map.set(hash, { hash, transfers: [], value: '0', fee: null, status: 'ok' });
  return map.get(hash);
}

// ---------------------------------------------------------------- Blockscout
async function blockscoutPage(chain, address, cursor) {
  const base = `${chain.indexer.url}/api/v2/addresses/${address}`;
  const qs = (p) => (p ? '&' + new URLSearchParams(p).toString() : '');
  // first page: cursor undefined. Next pages: {tx: params|null, tt: params|null}
  const [txs, tts] = await Promise.all([
    !cursor || cursor.tx ? getJson(`${base}/transactions?${qs(cursor?.tx).slice(1)}`) : null,
    !cursor || cursor.tt ? getJson(`${base}/token-transfers?type=ERC-20${qs(cursor?.tt)}`) : null,
  ]);
  const map = new Map();
  for (const t of txs?.items || []) {
    const r = record(map, t.hash);
    Object.assign(r, {
      time: Date.parse(t.timestamp) || Date.now(),
      from: lc(t.from?.hash), to: lc(t.to?.hash || t.created_contract?.hash), value: t.value || '0',
      fee: t.fee?.value ?? null, status: t.status === 'error' ? 'failed' : t.status ? 'ok' : 'pending',
      method: t.method || t.decoded_input?.method_call?.split('(')[0] || null,
      toName: t.to?.name || null,
      isTx: true,
    });
  }
  for (const tt of tts?.items || []) {
    const hash = tt.transaction_hash || tt.tx_hash;
    const r = record(map, hash);
    r.time = r.time || Date.parse(tt.timestamp) || Date.now();
    r.method = r.method || tt.method || null;
    r.transfers.push({
      from: lc(tt.from?.hash), to: lc(tt.to?.hash), token: lc(tt.token?.address_hash || tt.token?.address),
      symbol: tt.token?.symbol || '???', decimals: Number(tt.total?.decimals ?? tt.token?.decimals ?? 18),
      amount: tt.total?.value || '0', icon: tt.token?.icon_url || '', name: tt.token?.name || '',
    });
  }
  const txItems = txs?.items || [];
  markNotMine(map, address, txs?.next_page_params && txItems.length ? Math.min(...txItems.map((t) => Date.parse(t.timestamp) || Infinity)) : 0);
  const next = { tx: txs?.next_page_params || null, tt: tts?.next_page_params || null };
  return { records: [...map.values()], next: next.tx || next.tt ? next : null };
}

// ---------------------------------------------------------------- Etherscan-compatible
async function etherscanPage(chain, address, cursor, key) {
  const page = cursor?.page || 1;
  const p = { address, page, offset: 50, sort: 'desc', module: 'account' };
  const [txs, tts] = await Promise.all([
    getJson(etherscanUrl(chain, { ...p, action: 'txlist' }, key)),
    getJson(etherscanUrl(chain, { ...p, action: 'tokentx' }, key)),
  ]);
  const list = (j) => (Array.isArray(j?.result) ? j.result : []);
  if (txs?.status === '0' && /key|rate/i.test(txs?.result || txs?.message || '')) throw new Error(String(txs.result || txs.message));
  const map = new Map();
  for (const t of list(txs)) {
    const r = record(map, t.hash);
    Object.assign(r, {
      time: Number(t.timeStamp) * 1000, from: lc(t.from), to: lc(t.to || t.contractAddress), value: t.value || '0',
      fee: (BigInt(t.gasUsed || 0) * BigInt(t.gasPrice || 0)).toString(),
      status: t.isError === '1' || t.txreceipt_status === '0' ? 'failed' : 'ok',
      method: t.functionName ? t.functionName.split('(')[0] : t.methodId && t.methodId !== '0x' ? t.methodId : null,
      isTx: true,
    });
  }
  for (const t of list(tts)) {
    const r = record(map, t.hash);
    r.time = r.time || Number(t.timeStamp) * 1000;
    r.transfers.push({
      from: lc(t.from), to: lc(t.to), token: lc(t.contractAddress), symbol: t.tokenSymbol || '???',
      decimals: Number(t.tokenDecimal || 18), amount: t.value || '0', icon: '', name: t.tokenName || '',
    });
  }
  markNotMine(map, address, list(txs).length === 50 ? Math.min(...list(txs).map((t) => Number(t.timeStamp) * 1000)) : 0);
  const more = list(txs).length === 50 || list(tts).length === 50;
  return { records: [...map.values()], next: more ? { page: page + 1 } : null };
}

// ---------------------------------------------------------------- classify
const BRIDGE_METHOD = /bridge|depositv3|deposit_v3|startbridge|createorder|createsaltedorder|sendfrom|transferremote|outboundtransfer|depositerc20|relaytokens|crosschain|xcall|sendtoinjective|transfertokens/;
const BRIDGE_CONTRACT = /bridge|spokepool|dlnsource|lifi|relay|stargate|across|socket|bungee|squid|hop|synapse|celer|wormhole|portal|layerzero|orbiter|rhino|meson/i;

export function classify(r, address, chain) {
  const me = lc(address);
  const items = [];
  const nativeVal = BigInt(r.value || 0);
  if (nativeVal > 0n && r.isTx) {
    if (r.from === me) items.push({ dir: 'out', symbol: chain.native.symbol, decimals: chain.native.decimals, amount: r.value, native: true, counterparty: r.to });
    else if (r.to === me) items.push({ dir: 'in', symbol: chain.native.symbol, decimals: chain.native.decimals, amount: r.value, native: true, counterparty: r.from });
  }
  const sentByMeTx = r.from === me || r.local;
  const agg = new Map();
  for (const t of r.transfers) {
    if (t.from === me && t.to === me) continue;
    if (BigInt(t.amount || 0) === 0n) continue; // zero-value transfers = address poisoning
    let dir;
    if (t.from === me) {
      // "outgoing" token transfers in a tx someone else sent are fake events emitted by spam contracts
      // (records known only from the token-transfer list may be ours on another page: drop only spam tokens there)
      if (r.isTx ? !sentByMeTx : (r.notMine || isSpamToken(t, chain.id))) { r._spoof = true; continue; }
      dir = 'out';
    } else if (t.to === me) dir = 'in';
    else continue;
    const key = `${dir}:${t.token}`;
    if (agg.has(key)) agg.get(key).amount = (BigInt(agg.get(key).amount) + BigInt(t.amount)).toString();
    else agg.set(key, { ...t, dir, counterparty: dir === 'out' ? t.to : t.from });
  }
  items.push(...agg.values());
  const outs = items.filter((i) => i.dir === 'out'), ins = items.filter((i) => i.dir === 'in');
  const sentByMe = r.from === me;
  const m = (r.method || '').toLowerCase();
  // tokens leave on this network and nothing comes back here, through a bridge method or a known bridge contract
  const bridgeLike = sentByMe && outs.length > 0 && ins.length === 0 && (BRIDGE_METHOD.test(m) || BRIDGE_CONTRACT.test(r.toName || ''));
  let kind;
  if (outs.length && ins.length) kind = 'swap';
  else if (m === 'approve' || m === '0x095ea7b3' || m === 'setapprovalforall' || m === 'permit') kind = 'approve';
  else if (outs.length) kind = 'send';
  else if (ins.length) kind = 'receive';
  else if (sentByMe && r.to === me) kind = 'self';
  else kind = 'contract';
  const spam = !sentByMe && (r._spoof || (items.length > 0 && items.every((i) => !i.native && isSpamToken(i, chain.id))) || (items.length === 0 && r.transfers.length > 0));
  return {
    ...r, kind, transfers: items, sentByMe, spam, bridgeLike,
    counterparty: kind === 'send' ? outs[0]?.counterparty : kind === 'receive' ? ins[0]?.counterparty : r.to,
    fee: sentByMe ? r.fee : null,
  };
}

/**
 * Loads one page of history. Returns {items, next, error, unsupported}.
 * `localLog`: transactions sent from this wallet (to show pending ones immediately).
 */
export async function loadHistory(chain, address, cursor, { etherscanKey = '', localLog = [] } = {}) {
  let page = { records: [], next: null }, error = null, unsupported = false;
  // indexers to try, in order (some networks prefer a faster alternative for the history); a "next page"
  // cursor always goes back to the indexer that produced it
  const order = chain.altIndexer ? (chain.historyIndexer === 'alt' ? ['alt', 'main'] : ['main', 'alt']) : ['main'];
  const srcs = cursor?.src ? [cursor.src] : order;
  for (const src of srcs) {
    const idx = src === 'alt' ? chain.altIndexer : chain.indexer;
    const c = { ...chain, indexer: idx };
    try {
      error = null;
      if (!idx) unsupported = true;
      else if (idx.type === 'blockscout') page = await blockscoutPage(c, address, cursor);
      else if (idx.type === 'etherscan') {
        if (idx.needsKey && !etherscanKey) unsupported = true;
        else page = await etherscanPage(c, address, cursor, etherscanKey);
      }
      if (page.next) page.next = { ...page.next, src };
      break;
    } catch (e) { error = e.message; }
  }

  let records = page.records;
  if (!cursor) {
    // add locally-sent transactions not yet seen by the indexer
    const known = new Set(records.map((r) => r.hash.toLowerCase()));
    const local = localLog.filter((l) => !known.has(l.hash.toLowerCase()));
    const localRecs = await Promise.all(local.slice(0, 30).map(async (l) => {
      let status = l.status;
      if (status === 'pending') {
        const rc = await rpc(chain, 'eth_getTransactionReceipt', [l.hash]).catch(() => null);
        if (rc) status = rc.status === '0x1' ? 'ok' : 'failed';
      }
      return { hash: l.hash, time: l.time, from: l.from, to: l.to, value: l.value, fee: null, status, method: l.title || null, transfers: [], isTx: true, local: true, origin: l.origin };
    }));
    records = [...records, ...localRecs];
  }
  const items = records.map((r) => classify(r, address, chain)).sort((a, b) => b.time - a.time);
  return { items, next: page.next, error, unsupported };
}
