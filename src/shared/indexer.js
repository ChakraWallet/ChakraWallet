// Clients of the indexers that take a key:
// - Etherscan (API v2, one key for its networks). The free plan answers at most 3 requests a second: every request
//   waits its turn in a queue shared by the whole app, and a "rate limit" answer is retried after a pause. The free
//   plan doesn't cover BNB Chain (since November 2025): that answer is told apart (planRefused).
// - NodeReal (BNB Chain's infrastructure, a free key): the tokens an address holds and its transfers, through its
//   enhanced JSON-RPC methods (nr_getTokenHoldings, nr_getAssetTransfers).
// - Alchemy (a free key, shared/alchemy.js): the same through alchemy_getTokenBalances and alchemy_getAssetTransfers,
//   the backup when a network's usual service fails or isn't available.
import { getJson } from './http.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => String(a || '').toLowerCase();

/** A queue that lets one call through every `gap` ms (shared by everything that calls it). */
function pacer(gap) {
  let last = Promise.resolve(), at = 0;
  return async () => {
    const prev = last;
    let release;
    last = new Promise((r) => { release = r; });
    await prev;
    const wait = at + gap - Date.now();
    if (wait > 0) await sleep(wait);
    at = Date.now();
    release();
  };
}

// ---------------------------------------------------------------- Etherscan
export function etherscanUrl(chain, params, key) {
  const u = new URL(chain.indexer.url);
  if (chain.indexer.url.includes('etherscan.io/v2')) u.searchParams.set('chainid', chain.id);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (key && chain.indexer.url.includes('etherscan.io')) u.searchParams.set('apikey', key); // the key goes to Etherscan only
  return u.toString();
}

/** Etherscan's answer when the key's plan doesn't cover the network (e.g. a free key on BNB Chain). */
export const planRefused = (j) => j?.status === '0' && /free api access is not supported|upgrade your api plan/i.test(String(j.result || j.message || ''));
/** An error that means "this key's plan doesn't cover the network": shown as such, not as a failure. */
export const planError = (j) => Object.assign(new Error(String(j.result || j.message)), { plan: true });
/**
 * Etherscan's "Community Free API Limit reached. Resets 2026-11-18 00:00:00 UTC": on some networks (Linea, Arbitrum,
 * Celo...) the free plan has no allowance per key but one daily pool shared by every free user, which can run out
 * during the day whatever the key. Not a failure of the app or of the connection: it says when it comes back.
 */
export const poolExhausted = (j) => j?.status === '0' && /community free api limit/i.test(String(j.result || j.message || ''));
/** When the shared pool comes back (ms), from the answer; 0 if the answer doesn't say. */
export function poolResetAt(j) {
  const m = /resets\s+(\d{4}-\d{2}-\d{2})[ t](\d{2}:\d{2}(?::\d{2})?)\s*utc/i.exec(String(j?.result || j?.message || ''));
  const at = m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
  return Number.isFinite(at) ? at : 0;
}
/** An error that means "the network's free pool ran out until `resetAt`": shown as such, not as a failure. */
export const poolError = (j) => Object.assign(new Error(String(j.result || j.message)), { pool: true, resetAt: poolResetAt(j) });
/** Etherscan's "too many requests" (it answers HTTP 200 with status "0"). */
export const rateLimited = (j) => j?.status === '0' && /rate limit|max calls per sec|max rate/i.test(String(j.result || j.message || ''));

const etherscanTurn = pacer(360); // under the free plan's 3 a second

/** GET from an Etherscan-compatible API; Etherscan's own requests are paced and retried on its rate limit. */
export async function etherscanGet(chain, params, key, { timeout = 25000 } = {}) {
  const url = etherscanUrl(chain, params, key);
  const paced = url.includes('etherscan.io');
  for (let attempt = 0; ; attempt++) {
    if (paced) await etherscanTurn();
    const j = await getJson(url, { timeout, label: 'Indexer HTTP' });
    if (!rateLimited(j) || attempt >= 3) return j;
    await sleep(1100 * (attempt + 1));
  }
}

// ---------------------------------------------------------------- NodeReal (BNB Chain)
const nodeRealTurn = pacer(120);

/**
 * POST of a JSON-RPC body (one call, or a list: a batch) to an indexer, in its turn; busy or unreachable is retried.
 * The parsed answer, or an error named after the service.
 */
async function postRpc(endpoint, body, { turn, name, timeout = 25000 }) {
  for (let attempt = 0; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      if (attempt < 1) { await sleep(700); continue; }
      throw new Error(`${name}: ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
    const j = await res.json().catch(() => null);
    const err = Array.isArray(j) ? null : j?.error;
    if (!res.ok || !j) throw new Error(`${name} ${res.status}${err?.message ? `: ${err.message}` : ''}`);
    if (err) throw new Error(`${name}: ${err.message || err.code}`);
    return j;
  }
}

/** One call of NodeReal's JSON-RPC: the result, or an error (its message). */
export async function nodeReal(url, key, method, params, { timeout = 25000 } = {}) {
  const j = await postRpc(`${url}/${encodeURIComponent(key)}`, { jsonrpc: '2.0', id: 1, method, params }, { turn: nodeRealTurn, name: 'NodeReal', timeout });
  return j.result;
}

const num = (v) => (v == null || v === '' ? null : /^0x/i.test(String(v)) ? Number.parseInt(v, 16) : Number(v));
const big = (v) => { try { return BigInt(v || 0); } catch { return 0n; } };

/** Tokens an address holds (up to 300): [{ address, symbol, name, decimals, indexerBalance }] (the balance shown is read on-chain). */
export async function nodeRealHoldings(url, key, address, { timeout } = {}) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const r = await nodeReal(url, key, 'nr_getTokenHoldings', [address, `0x${page.toString(16)}`, '0x64'], { timeout });
    const details = r?.details || [];
    for (const t of details) {
      out.push({
        address: lc(t.tokenAddress), symbol: t.tokenSymbol || '???', name: t.tokenName || '',
        decimals: num(t.tokenDecimals) ?? 18, indexerBalance: big(t.tokenBalance),
      });
    }
    if (details.length < 100 || out.length >= num(r?.totalCount)) break;
  }
  return out;
}

const PAGE = 50;
/**
 * One page of an address' history from NodeReal, as history.js builds records: { records, next }.
 * Two lists (what the address sent, what it received: BNB and BEP-20), each with its own page key in the cursor.
 */
export async function nodeRealHistory(url, key, address, cursor, record) {
  const me = lc(address);
  const ask = (side, pageKey) => nodeReal(url, key, 'nr_getAssetTransfers', [{
    category: ['external', '20'], [side]: address, order: 'desc', excludeZeroValue: false, maxCount: `0x${PAGE.toString(16)}`,
    ...(pageKey ? { pageKey } : {}),
  }]);
  const [sent, got] = await Promise.all([
    !cursor || cursor.from ? ask('fromAddress', cursor?.from) : null,
    !cursor || cursor.to ? ask('toAddress', cursor?.to) : null,
  ]);
  const map = new Map();
  const seen = new Set(); // a transfer to oneself is in both lists
  for (const t of [...(sent?.transfers || []), ...(got?.transfers || [])]) {
    const id = `${t.hash}:${t.category}:${t.id ?? t.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const time = (num(t.blockTimeStamp ?? t.blockTimestamp) || 0) * 1000;
    const r = record(map, t.hash);
    if (t.category === 'external') {
      Object.assign(r, {
        time, from: lc(t.from), to: lc(t.to), value: big(t.value).toString(),
        fee: (big(t.gasUsed) * big(t.gasPrice)).toString(), status: t.receiptsStatus === 0 ? 'failed' : 'ok',
        method: t.input && t.input !== '0x' ? String(t.input).slice(0, 10) : null, isTx: true,
      });
    } else {
      r.time = r.time || time;
      r.transfers.push({
        from: lc(t.from), to: lc(t.to), token: lc(t.contractAddress), symbol: t.asset || '???',
        decimals: num(t.decimal) ?? 18, amount: big(t.value).toString(), icon: '', name: t.name || '',
      });
    }
  }
  // what the address sent, older than this page: a token "sent" without a transaction of mine in it is a fake
  const mine = (sent?.transfers || []).filter((t) => t.category === 'external' && lc(t.from) === me);
  const since = sent?.transfers?.length === PAGE && mine.length ? Math.min(...mine.map((t) => (num(t.blockTimeStamp ?? t.blockTimestamp) || 0) * 1000)) : 0;
  const next = {
    from: sent?.transfers?.length === PAGE ? sent.pageKey || null : null,
    to: got?.transfers?.length === PAGE ? got.pageKey || null : null,
  };
  return { records: [...map.values()], since, next: next.from || next.to ? next : null };
}

// ---------------------------------------------------------------- Alchemy (backup on every network switched on)
const alchemyTurn = pacer(80);
const hexOf = (n) => `0x${Number(n).toString(16)}`;
const word = (v) => (typeof v === 'string' && /^0x[0-9a-f]{1,64}$/i.test(v) ? BigInt(v) : null);

/** One call of Alchemy's JSON-RPC (url: the network's address with the key): the result, or an error. */
export async function alchemy(url, method, params, { timeout = 25000 } = {}) {
  const j = await postRpc(url, { jsonrpc: '2.0', id: 1, method, params }, { turn: alchemyTurn, name: 'Alchemy', timeout });
  return j.result;
}

/** Many calls in one request: their results in order (null for the ones that failed). */
async function alchemyBatch(url, calls, { timeout = 25000 } = {}) {
  const out = [];
  for (let i = 0; i < calls.length; i += 100) {
    const part = calls.slice(i, i + 100);
    const j = await postRpc(url, part.map(([method, params], k) => ({ jsonrpc: '2.0', id: k + 1, method, params })), { turn: alchemyTurn, name: 'Alchemy', timeout });
    const byId = new Map((Array.isArray(j) ? j : []).map((x) => [x.id, x]));
    part.forEach((_, k) => out.push(byId.get(k + 1)?.result ?? null));
  }
  return out;
}

/** Tokens an address holds (up to 300, balances above zero): [{ address, symbol, name, decimals, indexerBalance, icon }]. */
export async function alchemyHoldings(url, address) {
  const held = [];
  let pageKey;
  for (let page = 0; page < 3; page++) {
    const r = await alchemy(url, 'alchemy_getTokenBalances', [address, 'erc20', { maxCount: 100, ...(pageKey ? { pageKey } : {}) }]);
    for (const b of r?.tokenBalances || []) {
      const bal = b.error ? null : word(b.tokenBalance);
      if (bal) held.push({ address: lc(b.contractAddress), bal });
    }
    pageKey = r?.pageKey;
    if (!pageKey) break;
  }
  const metas = await alchemyBatch(url, held.map((h) => ['alchemy_getTokenMetadata', [h.address]]));
  return held.map((h, i) => {
    const m = metas[i] || {};
    return { address: h.address, symbol: m.symbol || '???', name: m.name || '', decimals: Number.isInteger(m.decimals) ? m.decimals : 18, indexerBalance: h.bal, icon: m.logo || '' };
  });
}

/**
 * One page of an address' history from Alchemy, as history.js builds records: { records, since, next }.
 * Two lists (what the address sent, what it received: native coin and tokens), each with its own page key. Where
 * Alchemy gives no time (some networks), it is read from the blocks; the fee, the outcome and the method of the
 * address' own transactions from their receipts: one request for all of them.
 */
export async function alchemyHistory(url, address, cursor, record) {
  const me = lc(address);
  const ask = (side, pageKey) => alchemy(url, 'alchemy_getAssetTransfers', [{
    fromBlock: '0x0', toBlock: 'latest', [side]: address, category: ['external', 'erc20'], order: 'desc',
    withMetadata: true, excludeZeroValue: false, maxCount: hexOf(PAGE), ...(pageKey ? { pageKey } : {}),
  }]);
  const [sent, got] = await Promise.all([
    !cursor || cursor.from ? ask('fromAddress', cursor?.from) : null,
    !cursor || cursor.to ? ask('toAddress', cursor?.to) : null,
  ]);
  const all = [];
  const seen = new Set(); // a transfer to oneself is in both lists
  for (const t of [...(sent?.transfers || []), ...(got?.transfers || [])]) {
    const id = t.uniqueId || `${t.hash}:${t.category}:${t.from}:${t.to}:${t.rawContract?.value}`;
    if (!seen.has(id)) { seen.add(id); all.push(t); }
  }

  // what Alchemy doesn't say: times (from the blocks), fee / outcome / method (receipts and transactions)
  const noTime = [...new Set(all.filter((t) => !t.metadata?.blockTimestamp).map((t) => t.blockNum))];
  const ext = [...new Set(all.filter((t) => t.category === 'external').map((t) => t.hash))];
  const mine = [...new Set(all.filter((t) => t.category === 'external' && lc(t.from) === me).map((t) => t.hash))];
  const extra = await alchemyBatch(url, [
    ...noTime.map((b) => ['eth_getBlockByNumber', [b, false]]),
    ...ext.map((h) => ['eth_getTransactionReceipt', [h]]),
    ...mine.map((h) => ['eth_getTransactionByHash', [h]]),
  ]);
  const blockTime = new Map(noTime.map((b, i) => [b, Number(extra[i]?.timestamp || 0) * 1000]));
  const receipt = new Map(ext.map((h, i) => [h, extra[noTime.length + i]]));
  const txOf = new Map(mine.map((h, i) => [h, extra[noTime.length + ext.length + i]]));
  const timeOf = (t) => Date.parse(t.metadata?.blockTimestamp) || blockTime.get(t.blockNum) || 0;

  const map = new Map();
  for (const t of all) {
    const time = timeOf(t);
    const r = record(map, t.hash);
    if (t.category === 'external') {
      const rc = receipt.get(t.hash);
      const input = txOf.get(t.hash)?.input;
      Object.assign(r, {
        time, from: lc(t.from), to: lc(t.to), value: (word(t.rawContract?.value) ?? 0n).toString(),
        fee: rc?.gasUsed && rc?.effectiveGasPrice ? (BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice)).toString() : null,
        status: rc?.status === '0x0' ? 'failed' : 'ok',
        method: input && input !== '0x' ? String(input).slice(0, 10) : null, isTx: true,
      });
    } else {
      r.time = r.time || time;
      r.transfers.push({
        from: lc(t.from), to: lc(t.to), token: lc(t.rawContract?.address), symbol: t.asset || '???',
        decimals: t.rawContract?.decimal ? Number(BigInt(t.rawContract.decimal)) : 18,
        amount: (word(t.rawContract?.value) ?? 0n).toString(), icon: '', name: '',
      });
    }
  }
  // what the address sent, older than this page: a token "sent" without a transaction of mine in it is a fake
  const mineTimes = all.filter((t) => t.category === 'external' && lc(t.from) === me).map(timeOf);
  const since = sent?.pageKey && mineTimes.length ? Math.min(...mineTimes) : 0;
  const next = { from: sent?.pageKey || null, to: got?.pageKey || null };
  return { records: [...map.values()], since, next: next.from || next.to ? next : null };
}
