// Transaction history from free indexers (Blockscout v2 / Etherscan-compatible), normalized.
import { isSpamToken } from './portfolio.js';
import { etherscanGet, planRefused, planError, poolExhausted, poolError, nodeRealHistory, alchemyHistory } from './indexer.js';
import { alchemyUrl } from './alchemy.js';
import { rpc, getTokenInfo } from './rpc.js';
import { POPULAR_TOKENS } from './tokens.js';
import { markCardRecords } from './mmcard.js';

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
  const [txs, tts] = await Promise.all([ // Etherscan's own requests take turns (indexer.js): under its rate limit
    etherscanGet(chain, { ...p, action: 'txlist' }, key),
    etherscanGet(chain, { ...p, action: 'tokentx' }, key),
  ]);
  const list = (j) => (Array.isArray(j?.result) ? j.result : []);
  // status "0" is also how an empty list is answered; anything else (rate limit, missing key, server error) in
  // either half is an error: a page without its token transfers would show swaps and sends as contract calls
  for (const j of [txs, tts]) {
    if (planRefused(j)) throw planError(j); // the key's plan doesn't cover this network: not a failure
    if (poolExhausted(j)) throw poolError(j); // the network's free pool ran out for today: not a failure either
    if (j?.status === '0' && !/no (transactions|records)/i.test(`${j.message} ${j.result}`)) throw new Error(String(typeof j.result === 'string' ? j.result : j.message));
  }
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

// ---------------------------------------------------------------- transactions not indexed yet
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddr = (t) => '0x' + String(t).slice(-40).toLowerCase();
const tokenInfoCache = new Map(); // `${chainId}:${token}` -> {symbol, decimals, name, icon} | null

async function tokenMeta(chain, token) {
  const k = `${chain.id}:${token}`;
  if (!tokenInfoCache.has(k)) {
    const known = (POPULAR_TOKENS[chain.id] || []).find((p) => p.address === token);
    tokenInfoCache.set(k, known ? Promise.resolve(known) : getTokenInfo(chain, token).catch(() => null));
  }
  return tokenInfoCache.get(k);
}

/**
 * ERC-20 transfers to or from `me` in a receipt, in the indexers' format: a transaction sent from the app shows
 * what it moved (tokens, amounts, icons) as soon as it is mined, before the indexer has it.
 */
export async function receiptTransfers(chain, receipt, me) {
  const logs = (receipt?.logs || []).filter((l) => l.topics?.[0] === TRANSFER && l.topics.length === 3 && l.data && l.data !== '0x'
    && (topicAddr(l.topics[1]) === me || topicAddr(l.topics[2]) === me));
  const out = await Promise.all(logs.map(async (l) => {
    const token = lc(l.address), info = await tokenMeta(chain, token);
    if (!info) return null;
    return { from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), token, symbol: info.symbol, decimals: Number(info.decimals ?? 18),
      amount: BigInt(l.data.slice(0, 66)).toString(), icon: info.icon || '', name: info.name || '' };
  }));
  return out.filter(Boolean);
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
      // (a MetaMask Card payment is sent by the card's relayer: a real one, recognised by shared/mmcard.js)
      if (!r.card && (r.isTx ? !sentByMeTx : (r.notMine || isSpamToken(t, chain.id)))) { r._spoof = true; continue; }
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
  if (r.card === 'spend' && outs.length) kind = 'card';
  else if (r.card === 'refund' && ins.length) kind = 'cardRefund';
  else if (outs.length && ins.length) kind = 'swap';
  else if (m === 'approve' || m === '0x095ea7b3' || r.selector === '0x095ea7b3' || m === 'setapprovalforall' || m === 'permit') kind = 'approve';
  else if (outs.length) kind = 'send';
  else if (ins.length) kind = 'receive';
  else if (sentByMe && r.to === me) kind = 'self';
  else kind = 'contract';
  const spam = !sentByMe && !r.card && (r._spoof || (items.length > 0 && items.every((i) => !i.native && isSpamToken(i, chain.id))) || (items.length === 0 && r.transfers.length > 0));
  return {
    ...r, kind, transfers: items, sentByMe, spam, bridgeLike,
    counterparty: kind === 'send' || kind === 'card' ? outs[0]?.counterparty : kind === 'receive' || kind === 'cardRefund' ? ins[0]?.counterparty : r.to,
    fee: sentByMe ? r.fee : null,
  };
}

/**
 * Loads one page of history. Returns {items, next, error, unsupported}.
 * `localLog`: transactions sent from this wallet (to show pending ones immediately).
 */
export async function loadHistory(chain, address, cursor, { etherscanKey = '', nodeRealKey = '', localLog = [] } = {}) {
  let page = { records: [], next: null }, error = null, unsupported = false, limitUntil = 0;
  // BNB Chain with a NodeReal key: the history from NodeReal (Etherscan's free plan doesn't cover it)
  const viaNodeReal = !!(chain.nodeReal && nodeRealKey) && (!cursor || cursor.src === 'nodereal');
  const backup = alchemyUrl(chain); // Alchemy: the backup, when the usual service can't give the history
  const viaAlchemy = cursor?.src === 'alchemy';
  // indexers to try, in order (some networks prefer a faster alternative for the history); a "next page"
  // cursor always goes back to the indexer that produced it
  const order = chain.altIndexer ? (chain.historyIndexer === 'alt' ? ['alt', 'main'] : ['main', 'alt']) : ['main'];
  const srcs = viaNodeReal || viaAlchemy ? [] : cursor?.src ? [cursor.src] : order;
  if (viaNodeReal) {
    try {
      const r = await nodeRealHistory(chain.nodeReal, nodeRealKey, address, cursor, record);
      const map = new Map(r.records.map((x) => [x.hash, x]));
      markNotMine(map, address, r.since);
      page = { records: [...map.values()], next: r.next ? { ...r.next, src: 'nodereal' } : null };
    } catch (e) { error = e.message; }
  }
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
    } catch (e) {
      if (e.plan) { unsupported = true; error = null; break; } // as without a key: the screen says what's needed
      if (e.pool) { limitUntil = e.resetAt || -1; error = null; break; } // the screen says when it comes back
      error = e.message;
    }
  }
  // Alchemy: a first page the usual service couldn't give (an error, no key, a plan or a free pool that doesn't
  // cover the network), and the pages after one of its own
  if (backup && (viaAlchemy || (!cursor && (error || unsupported || limitUntil)))) {
    try {
      const r = await alchemyHistory(backup, address, viaAlchemy ? cursor : null, record);
      const map = new Map(r.records.map((x) => [x.hash, x]));
      markNotMine(map, address, r.since);
      page = { records: [...map.values()], next: r.next ? { ...r.next, src: 'alchemy' } : null };
      error = null; unsupported = false; limitUntil = 0;
    } catch (e) { if (viaAlchemy || !(unsupported || limitUntil)) error = error || e.message; }
  }

  let records = page.records;
  // what the app knows about the transactions it sent: where they came from and its own title ("Swap … (Velora)")
  const logOf = new Map(localLog.map((l) => [l.hash.toLowerCase(), l]));
  for (const r of records) {
    const l = logOf.get(r.hash.toLowerCase());
    if (l) { r.origin = l.origin; r.appTitle = l.title || null; }
  }
  if (!cursor) {
    // add locally-sent transactions not yet seen by the indexer (it can lag minutes or more behind the chain):
    // their token transfers come from the receipt, so they look the same as when the indexer has them
    const known = new Set(records.map((r) => r.hash.toLowerCase()));
    const local = localLog.filter((l) => !known.has(l.hash.toLowerCase()));
    const me = lc(address);
    const localRecs = await Promise.all(local.slice(0, 30).map(async (l) => {
      let status = l.status, transfers = [], fee = null;
      const rc = await rpc(chain, 'eth_getTransactionReceipt', [l.hash]).catch(() => null);
      if (rc) {
        status = rc.status === '0x1' ? 'ok' : 'failed';
        transfers = await receiptTransfers(chain, rc, me).catch(() => []);
        if (rc.gasUsed && rc.effectiveGasPrice) fee = (BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice)).toString();
      }
      return { hash: l.hash, time: l.time, from: l.from, to: l.to, value: l.value, fee, status, method: l.title || null, appTitle: l.title || null,
        selector: l.data, transfers, isTx: true, local: true, origin: l.origin };
    }));
    records = [...records, ...localRecs];
  }
  await markCardRecords(chain, address, records).catch(() => {}); // MetaMask Card payments (Linea)
  const items = records.map((r) => classify(r, address, chain)).sort((a, b) => b.time - a.time);
  return { items, next: page.next, error, unsupported, limitUntil };
}
