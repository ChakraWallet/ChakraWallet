// Esplora API (mempool.space, blockstream.info): addresses, coins, transactions, fees, broadcasting. Public and
// without a key, with limits they don't publish: past a few requests a second from one IP, mempool.space doesn't refuse
// them, it holds them for 10-20 seconds. So the reads are shared between the network's services, each with its own queue
// (two requests at a time, spaced), and the pace follows each service: a slow answer spaces the next ones more, fast
// answers bring the pace back; a request a service doesn't answer in time (or refuses: 429, connection refused) goes to
// the other one, and that service is left alone for a while (30 s, then longer, up to 5 minutes) until it answers again. mempool.space's extras (replacements, recommended fees) are asked to it only. Only addresses and signed
// transactions leave.
const MAX_BUSY = 2, SLOW_MS = 1500, MAX_GAP = 4000;
let BASE_GAP = 250;
/** Tests: requests without the pause between them. */
export const setEsploraPace = (ms) => { BASE_GAP = ms; for (const q of queues.values()) q.gap = ms; };
const queues = new Map(); // service -> { busy, waiting, last, gap, ms (average answer time) }
const queueOf = (base) => {
  if (!queues.has(base)) queues.set(base, { busy: 0, waiting: [], last: 0, gap: BASE_GAP, ms: 400, fails: 0, until: 0 });
  return queues.get(base);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function slot(q) {
  while (q.busy >= MAX_BUSY) await new Promise((r) => q.waiting.push(r));
  q.busy++;
  const wait = q.last + q.gap - Date.now();
  q.last = Math.max(Date.now(), q.last + q.gap);
  if (wait > 0) await sleep(wait);
}
function release(q) { q.busy--; q.waiting.shift()?.(); }
/** The pace after an answer: slower after a slow one (or a refusal), back towards the normal one after fast ones. */
function learn(q, ms, failed = false) {
  if (failed) { // held, refused, unreachable: left alone for a while (longer each time)
    q.fails++;
    q.until = Date.now() + (BASE_GAP ? Math.min(300e3, 30e3 * 2 ** (q.fails - 1)) : 0);
    q.gap = Math.min(MAX_GAP, Math.max(q.gap * 2, 500));
    return;
  }
  q.fails = 0;
  q.ms = q.ms * 0.7 + ms * 0.3;
  q.gap = ms > SLOW_MS ? Math.min(MAX_GAP, Math.max(q.gap * 2, 500)) : Math.max(BASE_GAP, q.gap * 0.85);
}
/** How long a new request would wait for a service (its queue, its pace, its usual answer time). */
const expected = (q) => (q.busy + q.waiting.length) * Math.max(q.gap, q.ms / MAX_BUSY) + q.ms;

export class EsploraError extends Error {
  constructor(message, { status = 0, limited = false } = {}) { super(message); this.status = status; this.limited = limited; }
}

/**
 * One request to one service. kind: 'json' | 'text'. 404 -> null. retry: one more try after a refusal for too many
 * requests (when there's no other service to ask).
 */
async function call(base, path, { method = 'GET', body, kind = 'json', timeout, retry = false }) {
  const q = queueOf(base);
  for (let attempt = 0; ; attempt++) {
    await slot(q);
    // the service failed while this request was waiting its turn: to the next one at once
    if (!retry && q.until > Date.now()) { release(q); throw new EsploraError('resting', { limited: true }); }
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${base}${path}`, { method, body, headers: body ? { 'content-type': 'text/plain' } : { accept: kind === 'json' ? 'application/json' : 'text/plain' }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      release(q);
      learn(q, Date.now() - t0, true);
      throw new EsploraError(e?.name === 'TimeoutError' ? 'timeout' : String(e?.message || e));
    }
    release(q);
    learn(q, Date.now() - t0, res.status === 429);
    if (res.status === 404) return null;
    if (res.status === 429 && retry && attempt < 1) { await sleep(BASE_GAP ? 1500 : 0); continue; }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EsploraError(text.trim().slice(0, 300) || `HTTP ${res.status}`, { status: res.status, limited: res.status === 429 });
    }
    return kind === 'json' ? res.json() : res.text();
  }
}

/**
 * A request to the network's services: the one that would answer first, then the others when it can't (a timeout, a
 * server error, too many requests - not a 4xx, which is the answer). primaryOnly: the first service only.
 */
export async function esplora(chain, path, opts = {}) {
  const now = Date.now();
  const resting = (b) => queueOf(b).until > now;
  const bases = opts.primaryOnly ? chain.esplora.slice(0, 1)
    : opts.method === 'POST' ? chain.esplora // broadcasting: in order
      : [...chain.esplora].sort((a, b) => resting(a) - resting(b) || expected(queueOf(a)) - expected(queueOf(b))); // resting ones last
  let last;
  for (const [k, base] of bases.entries()) {
    // a read another service can answer doesn't wait long for one that holds requests
    const timeout = opts.timeout ?? (opts.method === 'POST' ? 30000 : k < bases.length - 1 ? 6000 : 15000);
    try { return await call(base, path, { ...opts, timeout, retry: k === bases.length - 1 }); } catch (e) {
      last = e;
      if (e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
    }
  }
  throw last;
}

// ------------------------------------------------------------ addresses
/**
 * Totals of an address: { funded, spent (confirmed, sats), mFunded, mSpent (in the mempool), txs (all), balance,
 * pending (the mempool's change to it) } - all bigint except txs.
 */
export async function addressStats(chain, address) {
  const j = await esplora(chain, `/address/${address}`);
  const c = j?.chain_stats || {}, m = j?.mempool_stats || {};
  const funded = BigInt(c.funded_txo_sum || 0), spent = BigInt(c.spent_txo_sum || 0);
  const mFunded = BigInt(m.funded_txo_sum || 0), mSpent = BigInt(m.spent_txo_sum || 0);
  return {
    funded, spent, mFunded, mSpent, txs: (c.tx_count || 0) + (m.tx_count || 0), chainTxs: c.tx_count || 0,
    balance: funded - spent, pending: mFunded - mSpent,
  };
}
/** The coins of an address: [{ txid, vout, value (bigint), confirmed, height, time }]. */
export async function addressUtxos(chain, address) {
  const list = (await esplora(chain, `/address/${address}/utxo`)) || [];
  return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: !!u.status?.confirmed, height: u.status?.block_height || 0, time: (u.status?.block_time || 0) * 1000 }));
}
/** Transactions of an address, newest first: the mempool's and 25 confirmed ones; then 25 at a time after `after`. */
export async function addressTxs(chain, address, after = null) {
  return (await esplora(chain, after ? `/address/${address}/txs/chain/${after}` : `/address/${address}/txs`)) || [];
}

// ------------------------------------------------------------ transactions
export const getTx = (chain, txid) => esplora(chain, `/tx/${txid}`);
export const getTxHex = (chain, txid) => esplora(chain, `/tx/${txid}/hex`, { kind: 'text' });
export const txStatus = (chain, txid) => esplora(chain, `/tx/${txid}/status`);
export const outspends = (chain, txid) => esplora(chain, `/tx/${txid}/outspends`);
export const tipHeight = async (chain) => Number(await esplora(chain, '/blocks/tip/height', { kind: 'text' }));
/** The transaction that last replaced this one (mempool.space only: the root of its replacement tree), or null. */
export async function replacedBy(chain, txid) {
  try {
    const j = await esplora(chain, `/v1/tx/${txid}/rbf`, { primaryOnly: true });
    const top = j?.replacements?.tx?.txid;
    return top && top !== txid ? top : null;
  } catch { return null; }
}

/** Broadcasts a signed transaction (hex). -> txid. The node's refusal comes back as the error's message. */
export async function broadcast(chain, hex) {
  const txid = await esplora(chain, '/tx', { method: 'POST', body: hex, kind: 'text', timeout: 30000 });
  if (!/^[0-9a-f]{64}$/i.test(String(txid || '').trim())) throw new EsploraError(String(txid || 'broadcast failed'));
  return String(txid).trim();
}

// ------------------------------------------------------------ fees
/**
 * Fee rates now, in sat/vB: { slow, normal, fast, minimum } (numbers, may be fractional). mempool.space recommends
 * them; on the second service the estimates for 1, 3 and 6 blocks.
 */
export async function feeRates(chain) {
  try {
    const j = await esplora(chain, '/v1/fees/recommended', { primaryOnly: true });
    if (j?.fastestFee) {
      const min = Number(j.minimumFee) || 1;
      return { slow: Math.max(Number(j.hourFee) || min, min), normal: Math.max(Number(j.halfHourFee) || min, min), fast: Math.max(Number(j.fastestFee), min), minimum: min };
    }
  } catch { /* the estimates below */ }
  const e = await esplora(chain, '/fee-estimates');
  const at = (n) => Number(e?.[n]) || 1;
  return { slow: at(6), normal: at(3), fast: at(1), minimum: Math.min(1, at(144) || 1) };
}
