// TON data: TON Center (v3 indexer) for balances, jettons, history, fees and broadcasting; STON.fi's public asset API
// for jetton prices and icons; DefiLlama (as everywhere in the app) for the GRAM price.
// Without an API key TON Center allows 1 request per second: requests go one at a time, spaced; with a key
// (Settings, optional) up to 10 per second. Only addresses and signed messages are sent.
import { Buffer } from './buffer.js';
import { Address } from '@ton/core';
import { getPrices } from '../prices.js';

export const TON_CHAINS = {
  [-239]: { id: -239, kind: 'ton', name: 'TON', short: 'TON', color: '#0098EA', native: { symbol: 'GRAM', name: 'Gram', decimals: 9, priceId: 'coingecko:the-open-network' }, api: 'https://toncenter.com', explorer: 'https://tonscan.org', rpc: ['https://toncenter.com/api/v3'] },
  [-3]: { id: -3, kind: 'ton', name: 'TON Testnet', short: 'tTON', color: '#9CA3AF', testnet: true, native: { symbol: 'GRAM', name: 'Gram (testnet)', decimals: 9 }, api: 'https://testnet.toncenter.com', explorer: 'https://testnet.tonscan.org', rpc: ['https://testnet.toncenter.com/api/v3'] },
};
export const isTon = (chain) => chain?.kind === 'ton';

// ------------------------------------------------------------ TON Center client
let apiKey = '';
/** Optional TON Center key (Settings): raises the limit from 1 to 10 requests per second. */
export const setTonCenterKey = (k) => { apiKey = String(k || '').trim(); };
const queue = { last: Promise.resolve(), at: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function slot() {
  const gap = apiKey ? 110 : 1100;
  const prev = queue.last;
  let release;
  queue.last = new Promise((r) => { release = r; });
  await prev;
  const wait = queue.at + gap - Date.now();
  if (wait > 0) await sleep(wait);
  queue.at = Date.now();
  release();
}

class TonApiError extends Error {}

async function call(chain, path, { params, body, timeout = 20000 } = {}) {
  const url = new URL(chain.api + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    for (const x of [].concat(v)) url.searchParams.append(k, String(x));
  }
  if (apiKey) url.searchParams.set('api_key', apiKey);
  for (let attempt = 0; ; attempt++) {
    await slot();
    let res;
    try {
      res = await fetch(url, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(timeout),
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (attempt < 2) continue;
      throw new TonApiError(`TON Center: ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1200 * (attempt + 1)); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new TonApiError(json.error || json.detail || `TON Center ${res.status}`);
    return json;
  }
}

const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
/** raw "0:ABC…" -> Address (null if not an address). */
const addr = (raw) => { try { return Address.parse(raw); } catch { return null; } };
const sameAddr = (a, b) => { const x = addr(a), y = addr(b); return !!x && !!y && x.equals(y); };

// ------------------------------------------------------------ account
/** { balance (nanoGRAM), status: 'active' | 'uninit' | 'nonexist' | 'frozen', seqno, walletType } */
export async function tonAccount(chain, address) {
  const r = await call(chain, '/api/v3/walletInformation', { params: { address, use_v2: false } });
  return { balance: big(r.balance), status: r.status || 'nonexist', seqno: r.seqno != null ? Number(r.seqno) : 0, walletType: r.wallet_type || null };
}

/** Status of any address (to decide the bounce flag of a transfer). */
export async function tonAddressStatus(chain, address) {
  const r = await call(chain, '/api/v3/addressInformation', { params: { address, use_v2: false } });
  return r.status || 'uninit';
}

/** Code, data, balance and status of any address (code and data as base64 BoC, null when absent). */
export async function tonAddressInfo(chain, address) {
  const r = await call(chain, '/api/v3/addressInformation', { params: { address, use_v2: false } });
  return { balance: big(r.balance), status: r.status || 'uninit', code: r.code || null, data: r.data || null, frozenHash: r.frozen_hash || null };
}

// ------------------------------------------------------------ contracts
/** Runs a get method (name, or numeric id as text) -> { exitCode, gasUsed, stack } (stack in TON Center format). */
export async function tonRunGetMethod(chain, address, method, stack = []) {
  const r = await call(chain, '/api/v3/runGetMethod', { body: { address, method: String(method), stack } });
  return { exitCode: Number(r.exit_code ?? 0), gasUsed: Number(r.gas_used ?? 0), stack: r.stack || [] };
}

/** The chain of transactions (trace) a transaction belongs to, or null while it isn't indexed. txHash: hex. */
export async function tonTraceByTx(chain, txHash) {
  const r = await call(chain, '/api/v3/traces', { params: { tx_hash: txHash, include_actions: false } });
  return r.traces?.[0] || null;
}

/** Latest transactions of an address (newest first): [{ hash (hex), time, ok, op, value, from, bounced }]. */
export async function tonTransactions(chain, address, limit = 20) {
  const r = await call(chain, '/api/v3/transactions', { params: { account: address, limit, sort: 'desc' } });
  return (r.transactions || []).map((tx) => {
    const d = tx.description || {}, c = d.compute_ph || {}, m = tx.in_msg || {};
    const failed = (!c.skipped && c.success === false) || d.action?.success === false;
    return {
      hash: Buffer.from(tx.hash, 'base64').toString('hex'), time: Number(tx.now) * 1000, ok: !failed, exitCode: c.exit_code ?? null,
      op: m.opcode != null ? Number(m.opcode) >>> 0 : null, value: big(m.value), from: m.source || null, bounced: !!m.bounced, external: !m.source,
    };
  });
}

// ------------------------------------------------------------ jettons
const metaCache = new Map(); // master raw -> { name, symbol, decimals, image, scam }
const stonCache = new Map(); // master raw -> { price, image, blacklisted, known, t }

async function jettonMeta(chain, masters) {
  const missing = masters.filter((m) => !metaCache.has(m));
  for (let i = 0; i < missing.length; i += 40) {
    const part = missing.slice(i, i + 40);
    const r = await call(chain, '/api/v3/metadata', { params: { address: part } }).catch(() => ({}));
    for (const m of part) {
      const info = (r[m]?.token_info || []).find((x) => x.type === 'jetton_masters') || {};
      metaCache.set(m, { name: info.name || null, symbol: info.symbol || null, decimals: info.extra?.decimals != null ? Number(info.extra.decimals) : null, image: info.image || null, scam: !!info.is_scam });
    }
  }
  return Object.fromEntries(masters.map((m) => [m, metaCache.get(m)]));
}

/** STON.fi knows the liquid jettons: USD price, icon, decimals and a blacklist. Mainnet only. */
export async function stonAsset(master) {
  const c = stonCache.get(master);
  if (c && Date.now() - c.t < 60_000) return c;
  let out = { known: false, t: Date.now() };
  try {
    const a = addr(master);
    const res = await fetch(`https://api.ston.fi/v1/assets/${a.toString({ urlSafe: true, bounceable: true })}`, { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const j = (await res.json())?.asset;
      if (j) {
        const price = Number(j.dex_usd_price ?? j.third_party_usd_price ?? NaN);
        out = { known: true, price: isFinite(price) ? price : null, image: j.image_url || null, symbol: j.symbol || null, name: j.display_name || null, decimals: j.decimals != null ? Number(j.decimals) : null, blacklisted: !!j.blacklisted, t: Date.now() };
      }
    }
  } catch { /* offline / unknown */ }
  stonCache.set(master, out);
  return out;
}

/**
 * Jettons held by an address: [{ master, wallet, balance, symbol, name, decimals, image, price, usd, amount, scam }].
 * scam: flagged by TON Center or blacklisted by STON.fi (hidden like spam tokens).
 */
export async function tonJettons(chain, owner) {
  const r = await call(chain, '/api/v3/jetton/wallets', { params: { owner_address: owner, exclude_zero_balance: true, limit: 100 } });
  const list = (r.jetton_wallets || []).filter((w) => big(w.balance) > 0n);
  const masters = [...new Set(list.map((w) => w.jetton))];
  const meta = await jettonMeta(chain, masters);
  const ston = chain.testnet ? {} : Object.fromEntries(await Promise.all(masters.map(async (m) => [m, await stonAsset(m)])));
  return list.map((w) => {
    const m = meta[w.jetton] || {}, s = ston[w.jetton] || {};
    const decimals = m.decimals ?? s.decimals ?? 9;
    const balance = big(w.balance);
    const amount = Number(balance) / 10 ** decimals;
    const price = s.price ?? null;
    return {
      master: w.jetton, wallet: w.address, balance, decimals, amount,
      symbol: s.symbol || m.symbol || '???', name: s.name || m.name || '', image: s.image || m.image || null,
      price, usd: price != null ? amount * price : null, scam: !!(m.scam || s.blacklisted), known: !!s.known,
    };
  }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
}

/** GRAM price in USD (null on testnet). */
export const gramPrice = async (chain) => (chain.native.priceId ? (await getPrices([chain.native.priceId]))[chain.native.priceId] ?? null : null);

// ------------------------------------------------------------ history
const SPAM_MAX = 50_000_000n; // incoming GRAM transfers under 0.05 with a text are almost always ads

/**
 * Latest actions of an account, newest first:
 * [{ id, time, kind: 'in' | 'out' | 'swap' | 'other', ok, amount, symbol, decimals, image, counterparty, comment,
 *    swap?: { in: {amount, symbol, decimals}, out: {...} }, type, txHash (hex), spam }]
 */
export async function tonHistory(chain, account, { limit = 30, cursor } = {}) {
  const r = await call(chain, '/api/v3/actions', { params: { account, limit, sort: 'desc', cursor } });
  const book = r.address_book || {};
  const meta = r.metadata || {};
  const name = (raw) => book[raw]?.user_friendly || raw;
  const tokenOf = (master) => {
    const info = (meta[master]?.token_info || []).find((x) => x.type === 'jetton_masters') || {};
    return { symbol: info.symbol || '???', decimals: info.extra?.decimals != null ? Number(info.extra.decimals) : 9, image: info.image || null, scam: !!info.is_scam };
  };
  const hexOf = (b64) => { try { return Buffer.from(b64, 'base64').toString('hex'); } catch { return null; } };
  const rows = (r.actions || []).map((a) => {
    const d = a.details || {};
    const base = { id: a.action_id, time: Number(a.start_utime) * 1000, ok: a.success !== false, type: a.type, txHash: a.transactions?.[0] ? hexOf(a.transactions[0]) : null };
    if (a.type === 'ton_transfer') {
      const out = sameAddr(d.source, account);
      const amount = big(d.value);
      return { ...base, kind: out ? 'out' : 'in', amount, symbol: chain.native.symbol, decimals: 9, counterparty: name(out ? d.destination : d.source), comment: d.encrypted ? null : d.comment || null, spam: !out && !!d.comment && amount < SPAM_MAX };
    }
    if (a.type === 'jetton_transfer') {
      const out = sameAddr(d.sender, account);
      const tk = tokenOf(d.asset);
      return { ...base, kind: out ? 'out' : 'in', amount: big(d.amount), ...tk, counterparty: name(out ? d.receiver : d.sender), comment: d.is_encrypted_comment ? null : d.comment || null, spam: !out && tk.scam };
    }
    if (a.type === 'jetton_swap') {
      const side = (x, asset) => ({ amount: big(x?.amount), ...(asset ? tokenOf(asset) : { symbol: chain.native.symbol, decimals: 9 }) });
      return { ...base, kind: 'swap', swap: { in: side(d.dex_incoming_transfer, d.asset_in), out: side(d.dex_outgoing_transfer, d.asset_out) }, counterparty: d.dex || null };
    }
    return { ...base, kind: 'other', counterparty: null };
  });
  return { rows, cursor: r.next_cursor || null };
}

// ------------------------------------------------------------ fees, broadcast, confirmation
/** Fee of an external message (TON Center estimate), in nanoGRAM: gas + storage + forwarding on the sender's side. */
export async function tonEstimateFee(chain, query) {
  const r = await call(chain, '/api/v3/estimateFee', { body: query });
  const s = r.source_fees || {};
  const dest = (r.destination_fees || []).reduce((t, f) => t + big(f.in_fwd_fee) + big(f.storage_fee) + big(f.gas_fee) + big(f.fwd_fee), 0n);
  return big(s.in_fwd_fee) + big(s.storage_fee) + big(s.gas_fee) + big(s.fwd_fee) + dest;
}

/** Broadcasts a signed external message (base64 BoC) -> { hash, hashNorm } (base64). */
export async function tonSendBoc(chain, boc) {
  const r = await call(chain, '/api/v3/message', { body: { boc } });
  return { hash: r.message_hash || null, hashNorm: r.message_hash_norm || null };
}

/**
 * Waits for the wallet to apply the message: seqno grows past `seqno`. Then looks up the transaction of the message
 * for the explorer link. -> { ok: true, txHash (hex) | null } ; throws on timeout.
 */
export async function tonWaitApplied(chain, wallet, seqno, { hash, timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const a = await tonAccount(chain, wallet).catch(() => null);
    if (a && a.seqno > seqno) {
      let txHash = null;
      if (hash) {
        const r = await call(chain, '/api/v3/transactionsByMessage', { params: { msg_hash: hash, direction: 'in', limit: 1 } }).catch(() => null);
        const h = r?.transactions?.[0]?.hash;
        if (h) txHash = Buffer.from(h, 'base64').toString('hex');
      }
      return { ok: true, txHash };
    }
  }
  throw new TonApiError('timeout');
}

// explorer links in the same form as the EVM ones (/tx/, /address/), so shared screens (bridges) work too
export const tonTxUrl = (chain, hex) => (hex ? `${chain.explorer}/tx/${hex}` : null);
export const tonAddrUrl = (chain, a) => `${chain.explorer}/address/${a}`;
