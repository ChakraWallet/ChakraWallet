// UniSat's indexer (Ordinals, Runes, BRC-20): with the user's free key on mainnet (Settings > Service keys), without
// one on Testnet4. Requests are spaced (the free plan allows a few a second) and the answers kept a few minutes.
// Only addresses are sent. Inscription images are loaded from UniSat's public content server (no key).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let key = '';
/** The optional UniSat key (Settings > Service keys). */
export const setUnisatKey = (k) => { key = String(k || '').trim(); };
export const hasUnisatKey = () => !!key;
/** Whether Ordinals and Runes can be read on a network: Testnet4 always, mainnet with the key. */
export const unisatReady = (chain) => !!chain?.unisat && (chain.unisatFree || !!key);

let last = 0, pace = 1;
/** Tests: requests without the pause between them. */
export const setUnisatPace = (x) => { pace = x; };
const cache = new Map(); // url -> { at, value }
const TTL = 3 * 60e3;

export class UnisatError extends Error {
  constructor(message, { limited = false, auth = false } = {}) { super(message); this.limited = limited; this.auth = auth; }
}

async function call(chain, path) {
  const url = `${chain.unisat}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  for (let attempt = 0; ; attempt++) {
    const gap = (chain.unisatFree && !key ? 1100 : 250) * pace;
    const wait = last + gap - Date.now();
    last = Math.max(Date.now(), last + gap);
    if (wait > 0) await sleep(wait);
    const headers = { accept: 'application/json' };
    if (key && !chain.unisatFree) headers.authorization = `Bearer ${key}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => null);
    const limited = res.status === 429 || j?.code === -2004 || j?.code === -2005;
    if (limited && attempt < 2) { await sleep(1500 * (attempt + 1) * pace); continue; }
    if (res.status === 401 || res.status === 403 || limited) throw new UnisatError(j?.msg || `UniSat ${res.status}`, { limited, auth: res.status === 401 });
    if (!res.ok || !j || j.code !== 0) throw new UnisatError(j?.msg || `UniSat ${res.status}`);
    cache.set(url, { at: Date.now(), value: j.data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return j.data;
  }
}
export const forgetUnisat = () => cache.clear();

/** Coins carrying inscriptions: [{ txid, vout, value, address, inscriptions: [{ id, number, offset }] }]. */
export async function inscriptionUtxos(chain, address) {
  const out = [];
  for (let cursor = 0; cursor < 1000;) {
    const d = await call(chain, `/v1/indexer/address/${address}/inscription-utxo-data?cursor=${cursor}&size=100`);
    const list = d?.utxo || [];
    for (const u of list) {
      out.push({
        txid: u.txid, vout: u.vout, value: BigInt(u.satoshi ?? u.satoshis ?? 0), address,
        inscriptions: (u.inscriptions || []).map((x) => ({ id: x.inscriptionId, number: x.inscriptionNumber, offset: x.offset ?? 0 })),
      });
    }
    cursor += list.length;
    if (!list.length || cursor >= (d?.total || 0)) break;
  }
  return out;
}
/** Inscriptions of an address with their details: [{ id, number, contentType, contentLength, txid?, … }]. */
export async function inscriptionsOf(chain, address) {
  const out = [];
  for (let cursor = 0; cursor < 1000;) {
    const d = await call(chain, `/v1/indexer/address/${address}/inscription-data?cursor=${cursor}&size=100`);
    const list = d?.inscription || [];
    for (const x of list) out.push({ id: x.inscriptionId, number: x.inscriptionNumber, contentType: x.contentType || '', contentLength: x.contentLength || 0, offset: x.offset ?? 0, time: (x.timestamp || 0) * 1000, utxo: x.utxo || null, brc20: x.brc20 || null, address });
    cursor += list.length;
    if (!list.length || cursor >= (d?.total || 0)) break;
  }
  return out;
}
/** Rune balances of an address: [{ id, rune, spaced, symbol, divisibility, amount (bigint) }]. */
export async function runeBalances(chain, address) {
  const out = [];
  for (let start = 0; start < 500;) {
    const d = await call(chain, `/v1/indexer/address/${address}/runes/balance-list?start=${start}&limit=100`);
    const list = d?.detail || [];
    for (const r of list) out.push({ id: r.runeid, rune: r.rune, spaced: r.spacedRune || r.rune, symbol: r.symbol || '', divisibility: Number(r.divisibility || 0), amount: BigInt(r.amount || 0) });
    start += list.length;
    if (!list.length || start >= (d?.total || 0)) break;
  }
  return out;
}
/** Coins of an address carrying a rune: [{ txid, vout, value, runes: [{ id, amount }] }]. */
export async function runeUtxos(chain, address, runeId) {
  const out = [];
  for (let start = 0; start < 1000;) {
    const d = await call(chain, `/v1/indexer/address/${address}/runes/${runeId}/utxo?start=${start}&limit=100`);
    const list = d?.utxo || [];
    for (const u of list) out.push({ txid: u.txid, vout: u.vout, value: BigInt(u.satoshi || 0), runes: (u.runes || []).map((r) => ({ id: r.runeid, amount: BigInt(r.amount || 0) })) });
    start += list.length;
    if (!list.length || start >= (d?.total || 0)) break;
  }
  return out;
}
/** BRC-20 balances of an address: [{ ticker, overall, transferable, available }] (strings, already in units). */
export async function brc20Balances(chain, address) {
  const d = await call(chain, `/v1/indexer/address/${address}/brc20/summary?start=0&limit=100&exclude_zero=true`);
  return (d?.detail || []).map((x) => ({ ticker: x.ticker, overall: String(x.overallBalance || '0'), transferable: String(x.transferableBalance || '0'), available: String(x.availableBalance || '0') }));
}
/** Where an inscription's content can be loaded from (an image, a text). */
export const contentUrl = (chain, id) => (chain.unisatContent ? `${chain.unisatContent}/${id}` : `${chain.unisat}/v1/indexer/inscription/content/${id}`);
