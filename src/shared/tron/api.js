// Tron networks and their HTTP API (java-tron's /wallet/* and TronGrid's indexed /v1/*): accounts, resources, chain
// parameters, contract calls, broadcasting and confirmation. Nodes: TronGrid (with the optional free key, Settings >
// Service keys; without it TronGrid answers few requests a second), and Alchemy for the /wallet/* calls when its key
// has Tron switched on (it has no /v1 indexer: history and token lists stay on TronGrid). Requests are spaced and
// retried when TronGrid says "too many requests". Only addresses and signed transactions are sent.
import { Interface } from 'ethers';
import { alchemyUrl } from '../alchemy.js';
import { encodeMessage, blockRef } from './proto.js';
import { fromHex, toHex, toEvmAddress, toBase58 } from './core.js';

export const TRON_MAINNET = -195;
export const TRON_NILE = -196;
export const TRON_CHAINS = {
  [TRON_MAINNET]: {
    id: TRON_MAINNET, kind: 'tron', name: 'Tron', short: 'TRX', color: '#EB0029',
    native: { symbol: 'TRX', name: 'Tron', decimals: 6, priceId: 'coingecko:tron' },
    api: 'https://api.trongrid.io', alchemy: 'tron-mainnet', evmChainId: 728126428,
    explorer: 'https://tronscan.org/#', explorerTxPath: 'transaction', swap: true,
  },
  [TRON_NILE]: {
    id: TRON_NILE, kind: 'tron', name: 'Tron Nile (test)', short: 'NILE', color: '#9CA3AF', testnet: true,
    native: { symbol: 'TRX', name: 'Tron (Nile)', decimals: 6 },
    api: 'https://nile.trongrid.io', evmChainId: 3448148188,
    explorer: 'https://nile.tronscan.org/#', explorerTxPath: 'transaction', faucet: 'https://nileex.io/join/getJoinPage',
  },
};
export const isTron = (chain) => chain?.kind === 'tron';
export const tronTxUrl = (chain, id) => (id ? `${chain.explorer}/transaction/${id}` : null);
export const tronAddrUrl = (chain, a) => `${chain.explorer}/address/${a}`;
export const tronTokenUrl = (chain, a) => (/^\d+$/.test(String(a)) ? `${chain.explorer}/token/${a}` : `${chain.explorer}/token20/${a}`);

// ------------------------------------------------------------ nodes
let gridKey = '';
/** The optional TronGrid key (Settings > Service keys): many more requests a second, for the mainnet. */
export const setTronGridKey = (k) => { gridKey = String(k || '').trim(); };
export const hasTronGridKey = () => !!gridKey;
const keyed = (chain) => !!gridKey && chain.id === TRON_MAINNET;

export class TronError extends Error {
  constructor(message, { code, limited } = {}) { super(message); this.code = code; this.limited = !!limited; }
}

// TronGrid without a key (measured): about one request a second to its indexer (/v1), a few a second to the node
// (/wallet). Requests leave one or two at a time, spaced; with a key, many at once.
const queues = { v1: { busy: 0, waiting: [], last: 0 }, wallet: { busy: 0, waiting: [], last: 0 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function slot(chain, q) {
  const indexer = q === queues.v1;
  const max = keyed(chain) ? 8 : indexer ? 1 : 2, gap = keyed(chain) ? 0 : indexer ? 1100 : 260;
  while (q.busy >= max) await new Promise((r) => q.waiting.push(r));
  q.busy++;
  const wait = q.last + gap - Date.now();
  q.last = Math.max(Date.now(), q.last + gap);
  if (wait > 0) await sleep(wait);
}
function release(q) { q.busy--; q.waiting.shift()?.(); }

/** A node's message, which some answers write as hex. */
export function nodeMessage(j) {
  const m = j?.Error || j?.error || j?.result?.message || j?.message || '';
  const s = String(typeof m === 'object' ? JSON.stringify(m) : m);
  return /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 ? new TextDecoder().decode(fromHex(s)) : s;
}

async function call(url, { method, body, headers, timeout }) {
  const res = await fetch(url, {
    method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

/**
 * A call to the Tron API. path: '/wallet/…' (node: TronGrid, then Alchemy) or '/v1/…' (TronGrid's indexer).
 * body: POST JSON (visible: true is added: addresses as T…), or null for a GET.
 */
export async function tronApi(chain, path, body = null, { timeout = 20000 } = {}) {
  const post = body != null;
  const payload = post ? { visible: true, ...body } : null;
  const targets = [{ url: `${chain.api}${path}`, headers: keyed(chain) ? { 'TRON-PRO-API-KEY': gridKey } : {}, grid: true }];
  const alchemy = path.startsWith('/wallet') ? alchemyUrl(chain) : null;
  if (alchemy) targets.push({ url: `${alchemy}${path}`, headers: {}, grid: false });
  const q = path.startsWith('/v1') ? queues.v1 : queues.wallet;
  let last = null;
  for (const tg of targets) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (tg.grid) await slot(chain, q);
      let r;
      try { r = await call(tg.url, { method: post ? 'POST' : 'GET', body: payload, headers: tg.headers, timeout }); }
      catch (e) { last = e.name === 'TimeoutError' ? new TronError('Tron: timeout') : e; if (tg.grid) release(q); break; }
      finally { if (tg.grid && r) release(q); }
      const { res, json } = r;
      if (res.status === 429 || res.status === 503 || /too many|rate limit|exceeds the limit/i.test(nodeMessage(json))) {
        last = new TronError('Tron: too many requests', { limited: true });
        await sleep((q === queues.v1 ? 1500 : 1000) * (attempt + 1) + Math.random() * 300);
        continue;
      }
      if (res.status >= 500 || !json) { last = new TronError(`Tron: HTTP ${res.status}`); break; }
      if (res.status === 401 || res.status === 403) { last = new TronError('Tron: key refused', { code: res.status }); break; }
      if (!res.ok) throw new TronError(nodeMessage(json) || `Tron: HTTP ${res.status}`, { code: res.status });
      return json;
    }
  }
  throw last || new TronError('Tron: no answer');
}

// ------------------------------------------------------------ accounts and resources
/** The account as the node keeps it ({} when it doesn't exist yet: never received TRX). */
export const getAccount = (chain, address) => tronApi(chain, '/wallet/getaccount', { address });
/** Energy and bandwidth of an account, usage as of now (the node applies the recovery since the last use). */
export const getAccountResource = (chain, address) => tronApi(chain, '/wallet/getaccountresource', { address });
/** TronGrid's view of an account: balances of its TRC-20 tokens too (data[0]), or null when it doesn't exist. */
export async function getV1Account(chain, address) {
  const j = await tronApi(chain, `/v1/accounts/${address}`);
  return j?.data?.[0] || null;
}
export const accountExists = (acc) => !!acc && (acc.create_time != null || acc.balance != null || acc.address != null);

const params = new Map(); // chain id -> { at, map }
/** The network's parameters (fees, limits), cached for 10 minutes: { getEnergyFee, getTransactionFee, … } as numbers. */
export async function chainParams(chain) {
  const c = params.get(chain.id);
  if (c && Date.now() - c.at < 10 * 60e3) return c.map;
  const j = await tronApi(chain, '/wallet/getchainparameters', {});
  const map = Object.fromEntries((j.chainParameter || []).map((p) => [p.key, Number(p.value ?? 0)]));
  params.set(chain.id, { at: Date.now(), map });
  return map;
}

/** The latest block, as the reference a new transaction carries: { ref_block_bytes, ref_block_hash, time }. */
export async function latestRef(chain) {
  return blockRef(await tronApi(chain, '/wallet/getnowblock', {}));
}

// ------------------------------------------------------------ contracts
/**
 * A read-only call (nothing is sent): { ok, result (hex), energy (what it would use, the dynamic penalty included),
 * message (why it failed) }. data: the calldata (hex, selector included).
 */
export async function constantCall(chain, { owner, contract, data, callValue = 0 }) {
  const j = await tronApi(chain, '/wallet/triggerconstantcontract', {
    owner_address: owner || 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', contract_address: contract,
    data: String(data).replace(/^0x/, ''), ...(callValue ? { call_value: Number(callValue) } : {}),
  });
  const ok = j?.result?.result === true && j?.transaction?.ret?.[0]?.ret !== 'FAILED';
  return { ok, result: j?.constant_result?.[0] || '', energy: Number(j?.energy_used || 0), message: ok ? '' : nodeMessage(j) || revertReason(j?.constant_result?.[0]) };
}
/** Error(string) inside a revert, if there is one. */
export function revertReason(hex) {
  const h = String(hex || '');
  if (!h.startsWith('08c379a0')) return '';
  try { return new Interface(['function Error(string)']).decodeFunctionData('Error', `0x${h}`)[0]; } catch { return ''; }
}

export const TRC20 = new Interface([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
]);
/** Calldata of a TRC-20 function, Tron addresses (T…) given as they are. */
export function trc20Data(fn, args = []) {
  const evm = args.map((a) => (typeof a === 'string' && toBase58(a) ? toEvmAddress(toBase58(a)) : a));
  return TRC20.encodeFunctionData(fn, evm).slice(2);
}
/** A TRC-20 read: the decoded value, or null. */
export async function trc20Read(chain, contract, fn, args = [], owner) {
  const r = await constantCall(chain, { owner, contract, data: trc20Data(fn, args) });
  if (!r.ok || !r.result) return null;
  try { return TRC20.decodeFunctionResult(fn, `0x${r.result}`)[0]; } catch { return null; }
}

// ------------------------------------------------------------ sending
/** A signed transaction in the wire format (Transaction: raw_data + signatures), hex. */
export const signedHex = (rawDataHex, signatures) => toHex(encodeMessage('SignedTransaction', { raw_data: fromHex(rawDataHex), signature: signatures.map(fromHex) }));

/** Broadcasts a signed transaction -> its id; throws with the node's reason when refused. */
export async function broadcast(chain, { rawDataHex, txID, signatures }) {
  const j = await tronApi(chain, '/wallet/broadcasthex', { transaction: signedHex(rawDataHex, signatures) });
  if (j?.result === true) return j.txid || txID;
  if (/DUP_TRANSACTION/i.test(j?.code || '')) return txID; // already on its way
  throw new TronError(nodeMessage(j) || j?.code || 'Tron: refused', { code: j?.code });
}

/** What a transaction cost and how it went, once in a block (null before): { fee, energy, bandwidth, ok, result }. */
export async function txInfo(chain, id) {
  const j = await tronApi(chain, '/wallet/gettransactioninfobyid', { value: id });
  if (!j || !j.id) return null;
  const rc = j.receipt || {};
  return {
    id: j.id, block: j.blockNumber, time: j.blockTimeStamp, fee: BigInt(j.fee || 0),
    energy: Number(rc.energy_usage_total || 0), energyFee: BigInt(rc.energy_fee || 0), bandwidth: Number(rc.net_usage || 0), bandwidthFee: BigInt(rc.net_fee || 0),
    ok: !j.result || j.result === 'SUCCESS' ? rc.result == null || rc.result === 'SUCCESS' : false, result: rc.result || j.result || 'SUCCESS',
    message: j.resMessage ? nodeMessage({ message: j.resMessage }) : '',
    contract: j.contract_address ? toBase58(j.contract_address) : null, // a deployment: the new contract
  };
}

/** Waits until a transaction is in a block (about 3 s on Tron) -> txInfo; throws when it failed. */
export async function waitTx(chain, id, { timeout = 90e3 } = {}) {
  const until = Date.now() + timeout;
  await sleep(2500);
  while (Date.now() < until) {
    const info = await txInfo(chain, id).catch(() => null);
    if (info) {
      if (!info.ok) throw new TronError(info.message || info.result, { code: info.result });
      return info;
    }
    await sleep(2000);
  }
  throw new TronError('Tron: not confirmed yet');
}
