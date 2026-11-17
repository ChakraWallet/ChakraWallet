// Solana networks and their JSON-RPC: reads, fees, simulation, broadcasting and confirmation.
// Nodes: Helius (an optional key, Settings > Service keys) and Alchemy (the key the app already has, when Solana is
// switched on in its app) first, then the public nodes. Public nodes allow few requests (and one getTransaction per
// batch): requests that fail with "too many requests" wait and retry, then move to the next node.
// Only addresses and signed transactions are sent.
import { alchemyUrl } from '../alchemy.js';
import { toBase64, fromBase64, addressOf } from './core.js';

export const SOL_MAINNET = -501;
export const SOL_DEVNET = -502;
export const SOL_CHAINS = {
  [SOL_MAINNET]: {
    id: SOL_MAINNET, kind: 'solana', name: 'Solana', short: 'SOL', color: '#9945FF',
    native: { symbol: 'SOL', name: 'Solana', decimals: 9, priceId: 'coingecko:solana' },
    rpc: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'],
    alchemy: 'solana-mainnet', genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    explorer: 'https://solscan.io', explorerAddress: 'account', swap: true,
  },
  [SOL_DEVNET]: {
    id: SOL_DEVNET, kind: 'solana', name: 'Solana Devnet', short: 'dSOL', color: '#9CA3AF', testnet: true,
    native: { symbol: 'SOL', name: 'Solana (devnet)', decimals: 9 },
    rpc: ['https://api.devnet.solana.com'],
    genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    explorer: 'https://solscan.io', explorerAddress: 'account', explorerQuery: '?cluster=devnet', faucet: 'https://faucet.solana.com',
  },
};
export const isSolana = (chain) => chain?.kind === 'solana';
export const solTxUrl = (chain, sig) => (sig ? `${chain.explorer}/tx/${sig}${chain.explorerQuery || ''}` : null);
export const solAddrUrl = (chain, a) => `${chain.explorer}/account/${a}${chain.explorerQuery || ''}`;
export const solTokenUrl = (chain, a) => `${chain.explorer}/token/${a}${chain.explorerQuery || ''}`;

// ------------------------------------------------------------ nodes
let heliusKey = '';
/** Optional Helius key (Settings > Service keys): a faster node, the history at full speed, NFTs (DAS). */
export const setHeliusKey = (k) => { heliusKey = String(k || '').trim(); };
export const hasHelius = () => !!heliusKey;
const HELIUS = { [SOL_MAINNET]: 'https://mainnet.helius-rpc.com/', [SOL_DEVNET]: 'https://devnet.helius-rpc.com/' };
export const heliusUrl = (chain) => (heliusKey && HELIUS[chain.id] ? `${HELIUS[chain.id]}?api-key=${encodeURIComponent(heliusKey)}` : null);

/** The nodes of a network, best first: [{ url, keyed }]. */
export function nodes(chain) {
  const out = [];
  const h = heliusUrl(chain);
  if (h) out.push({ url: h, keyed: true });
  const a = alchemyUrl(chain);
  if (a) out.push({ url: a, keyed: true });
  for (const url of chain.rpc || []) out.push({ url, keyed: false });
  return out;
}
/** Is there a node with a key (no strict limits)? */
export const keyedNode = (chain) => nodes(chain).some((n) => n.keyed);

export class RpcError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data; }
}
// answers about the request itself: another node would say the same
const FINAL = new Set([-32002, -32003, -32602, -32600, -32015, -32016]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

/**
 * A JSON-RPC call, node after node. opts: { timeout, start (index of the node to begin with: spreads a burst of
 * calls over the public nodes), nodes (a list to use instead) }.
 */
export async function rpc(chain, method, params = [], { timeout = 20000, start = 0 } = {}) {
  const list = nodes(chain);
  if (!list.length) throw new Error('Solana: no node');
  const ordered = [...list.slice(start % list.length), ...list.slice(0, start % list.length)];
  let last = null;
  for (const n of ordered) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res, json;
      try {
        res = await fetch(n.url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout),
          body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
        });
        json = await res.json().catch(() => null);
      } catch (e) { last = e; break; }
      const busy = res.status === 429 || json?.error?.code === 429 || /too many requests/i.test(json?.error?.message || '');
      if (busy || res.status >= 500) { last = new Error('Solana: node busy'); await sleep(600 * (attempt + 1)); continue; }
      if (json?.error) {
        const e = new RpcError(json.error.message || 'Solana RPC', json.error.code, json.error.data);
        // a node that refuses the method itself (publicnode blocks token-account queries): the next one may serve it
        const refused = /blocked|not allowed|not available|disabled|method not found|upgrade|api key|maximum of|personal token/i.test(e.message);
        if (FINAL.has(e.code) && !refused) throw e;
        last = e; break;
      }
      if (!res.ok || !json || !('result' in json)) { last = new Error(`Solana: HTTP ${res.status}`); break; }
      return json.result;
    }
  }
  throw last || new Error('Solana RPC');
}

/** Runs async jobs a few at a time (each gets its index: rpc's `start`, so they spread over the nodes). */
export async function pool(items, fn, concurrency = 3) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ------------------------------------------------------------ accounts
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
/** Lamports of an address. */
export const solBalance = async (chain, address) => big((await rpc(chain, 'getBalance', [address, { commitment: 'confirmed' }])).value);

/** An account: { lamports, owner, executable, space, data (Uint8Array) } or null when it doesn't exist. */
export async function accountInfo(chain, address) {
  const r = await rpc(chain, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  return r.value ? toAccount(r.value) : null;
}
const toAccount = (v) => ({ lamports: big(v.lamports), owner: v.owner, executable: !!v.executable, space: v.space ?? null, data: fromBase64(v.data[0]) });
/** Several accounts at once (base64), in order; null where missing. */
export async function multipleAccounts(chain, addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const part = addresses.slice(i, i + 100);
    const r = await rpc(chain, 'getMultipleAccounts', [part, { encoding: 'base64', commitment: 'confirmed' }], { start: i / 100 });
    out.push(...r.value.map((v) => (v ? toAccount(v) : null)));
  }
  return out;
}
/**
 * Several accounts at once, parsed by the node where it can (token accounts, mints): the raw `value`s. A batch that
 * fails leaves its places null (the rest still count).
 */
export async function multipleParsed(chain, addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const part = addresses.slice(i, i + 100);
    const r = await rpc(chain, 'getMultipleAccounts', [part, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null);
    out.push(...(r?.value || part.map(() => null)));
  }
  return out;
}

/** Lamports an account of `space` bytes must hold to exist (rent exemption). */
const rentCache = new Map();
export async function rentExempt(chain, space) {
  const k = `${chain.id}:${space}`;
  if (!rentCache.has(k)) rentCache.set(k, rpc(chain, 'getMinimumBalanceForRentExemption', [space]).then(big).catch((e) => { rentCache.delete(k); throw e; }));
  return rentCache.get(k);
}

// ------------------------------------------------------------ transactions
/** { blockhash, lastValidBlockHeight } */
export const latestBlockhash = async (chain) => (await rpc(chain, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value;

/**
 * Simulates a transaction (unsigned is fine: signatures aren't checked, the blockhash is replaced) ->
 * { err, logs, unitsConsumed, accounts?, returnData }. opts.accounts: addresses whose state after it is wanted.
 */
export async function simulate(chain, bytes, { accounts = null } = {}) {
  const r = await rpc(chain, 'simulateTransaction', [toBase64(bytes), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    ...(accounts?.length ? { accounts: { encoding: 'base64', addresses: accounts } } : {}),
  }]);
  return r.value;
}

/** The fee of a message (lamports: the signatures' fee plus the priority fee it sets), or null. */
export async function messageFee(chain, message) {
  const r = await rpc(chain, 'getFeeForMessage', [toBase64(message), { commitment: 'confirmed' }]).catch(() => null);
  return r?.value != null ? big(r.value) : null;
}

/**
 * The priority fee to offer (micro-lamports per compute unit): the 75th percentile of what recent blocks took for
 * these accounts, within sane bounds - enough to land in a busy moment, never a surprise.
 */
export async function priorityPrice(chain, writable = []) {
  if (chain.testnet) return 1000;
  const r = await rpc(chain, 'getRecentPrioritizationFees', [writable.slice(0, 128)]).catch(() => []);
  const v = r.map((x) => x.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
  const p75 = v.length ? v[Math.floor(v.length * 0.75)] : 0;
  return Math.min(Math.max(p75, 20_000), 2_000_000);
}

/** Broadcasts a signed transaction -> its signature (base58). Preflight on: a transaction that would fail isn't sent. */
export async function sendRaw(chain, bytes, { skipPreflight = false } = {}) {
  return rpc(chain, 'sendTransaction', [toBase64(bytes), { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed', maxRetries: 2 }]);
}

/** Readable reason of a failed simulation or send: the program's error log line, else the error. */
export function failReason(e, logs) {
  const lines = logs || e?.data?.logs || [];
  const line = [...lines].reverse().find((l) => /Error|failed|insufficient/i.test(l));
  const err = e?.data?.err ?? e;
  return (line ? line.replace(/^Program log: /, '') : null) || (typeof err === 'string' ? err : err?.message || JSON.stringify(err));
}

/**
 * Waits until a signature is confirmed: { hash } (resolves), or rejects when it failed or its blockhash expired.
 * The signed bytes, when given, are sent again every few seconds (nodes drop transactions in busy moments), through
 * `resend(bytes)` when given.
 */
export async function waitConfirmed(chain, signature, { bytes = null, lastValidBlockHeight = null, timeoutMs = 90000, resend = null } = {}) {
  const t0 = Date.now();
  let lastSend = Date.now();
  // the status: { err, confirmationStatus } | null (not seen) | undefined (no node answered: nothing can be said)
  const status = (history) => rpc(chain, 'getSignatureStatuses', [[signature], { searchTransactionHistory: history }]).then((r) => r?.value?.[0] ?? null, () => undefined);
  for (;;) {
    await sleep(1500);
    const st = await status(false);
    if (st?.err) throw new RpcError(typeof st.err === 'string' ? st.err : JSON.stringify(st.err), 'failed', { err: st.err });
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { hash: signature };
    if (lastValidBlockHeight != null && st === null) {
      const h = await rpc(chain, 'getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
      if (h != null && h > lastValidBlockHeight) {
        // past its last valid block: expired only if the network's history doesn't have it either
        const late = await status(true);
        if (late?.err) throw new RpcError(JSON.stringify(late.err), 'failed', { err: late.err });
        if (late) return { hash: signature };
        if (late === null) throw new RpcError('expired', 'expired');
      }
    }
    // sent again through the same channel it went (a protected swap must not reach the public nodes)
    if (bytes && Date.now() - lastSend > 4000) { lastSend = Date.now(); Promise.resolve(resend ? resend(bytes) : sendRaw(chain, bytes, { skipPreflight: true })).catch(() => {}); }
    if (Date.now() - t0 > timeoutMs) throw new RpcError('timeout', 'timeout');
  }
}

/** A transaction with its effects, as the node parses it (jsonParsed), or null. */
export async function parsedTransaction(chain, signature, { start = 0 } = {}) {
  const opts = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };
  try { return await rpc(chain, 'getTransaction', [signature, opts], { start }); } catch (e) {
    if (e.code !== -32602 && e.code !== -32015) throw e;
    return rpc(chain, 'getTransaction', [signature, { ...opts, maxSupportedTransactionVersion: 0 }], { start }).catch(() => null); // older nodes
  }
}

/** Address lookup tables' contents: { [table]: [addresses] } (for reading version 0 transactions). */
export async function lookupTables(chain, keys) {
  if (!keys.length) return {};
  const accs = await multipleAccounts(chain, keys);
  const out = {};
  keys.forEach((k, i) => {
    const d = accs[i]?.data;
    if (!d || d.length < 56) return;
    const list = [];
    for (let o = 56; o + 32 <= d.length; o += 32) list.push(d.slice(o, o + 32));
    out[k] = list.map(addressOf);
  });
  return out;
}

/** Devnet SOL from the network's faucet (requestAirdrop; often limited: then the faucet's page). */
export const requestAirdrop = (chain, address, lamports = 1_000_000_000n) => rpc(chain, 'requestAirdrop', [address, Number(lamports)]);
