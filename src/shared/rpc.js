// Minimal JSON-RPC client with fallback across the chain's RPC endpoints. With an Alchemy key whose app has the
// network switched on (shared/alchemy.js): transactions go to Alchemy first, reads to the public nodes first and to
// Alchemy only when none of them answers.
import { Interface } from 'ethers';
import { t, i18nError } from './i18n.js';
import { alchemyUrl } from './alchemy.js';

let reqId = 1;
const preferred = new Map(); // chainId -> index of last working rpc

export class RpcError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data; }
}

/** send: a transaction going out (Alchemy, when there, is asked first). */
export async function rpc(chain, method, params = [], { send = false } = {}) {
  const urls = chain.rpc || [];
  const alchemy = alchemyUrl(chain);
  if (!urls.length && !alchemy) throw i18nError('errors.noRpc', { chain: chain.name });
  const start = preferred.get(chain.id) || 0;
  // indexes into urls; -1 is Alchemy (never made the preferred node for reads: it stays the backup)
  const order = urls.map((_, k) => (start + k) % urls.length);
  if (alchemy) send ? order.unshift(-1) : order.push(-1);
  let lastErr;
  for (const i of order) {
    const url = i < 0 ? alchemy : urls[i];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: reqId++, method, params }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) {
        // A JSON-RPC error is a real answer from the node (e.g. revert): don't retry elsewhere.
        if (i >= 0) preferred.set(chain.id, i);
        throw new RpcError(json.error.message || t('errors.rpcGeneric'), json.error.code, json.error.data);
      }
      if (i >= 0) preferred.set(chain.id, i);
      return json.result;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      lastErr = e;
    }
  }
  throw i18nError('errors.rpcUnreachable', { chain: chain.name, reason: lastErr?.message || lastErr });
}

// ---------- ERC-20 helpers
export const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function transferFrom(address,address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

const multicall = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export async function ethCall(chain, to, data, from) {
  return rpc(chain, 'eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
}

/** calls: [{to, data}] -> array of hex results (or null on failure) */
export async function multiCall(chain, calls) {
  if (!calls.length) return [];
  const out = [];
  for (let i = 0; i < calls.length; i += 150) {
    const chunk = calls.slice(i, i + 150);
    try {
      const data = multicall.encodeFunctionData('aggregate3', [chunk.map((c) => [c.to, true, c.data])]);
      const res = await ethCall(chain, MULTICALL3, data);
      const [decoded] = multicall.decodeFunctionResult('aggregate3', res);
      decoded.forEach((r) => out.push(r.success && r.returnData !== '0x' ? r.returnData : null));
    } catch {
      // Multicall not available on this chain: fall back to individual calls
      for (const c of chunk) out.push(await ethCall(chain, c.to, c.data).catch(() => null));
    }
  }
  return out;
}

export async function getTokenInfo(chain, address) {
  const [sym, name, dec] = await multiCall(chain, [
    { to: address, data: erc20.encodeFunctionData('symbol') },
    { to: address, data: erc20.encodeFunctionData('name') },
    { to: address, data: erc20.encodeFunctionData('decimals') },
  ]);
  if (!dec) throw i18nError('errors.notErc20');
  const safe = (fn, v, d) => { try { return erc20.decodeFunctionResult(fn, v)[0]; } catch { return d; } };
  return {
    address: address.toLowerCase(),
    symbol: sym ? safe('symbol', sym, '???') : '???',
    name: name ? safe('name', name, '') : '',
    decimals: Number(safe('decimals', dec, 18)),
  };
}

export async function getAllowance(chain, token, owner, spender) {
  const res = await ethCall(chain, token, erc20.encodeFunctionData('allowance', [owner, spender]));
  return BigInt(res);
}

export async function waitForReceipt(chain, hash, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rpc(chain, 'eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw i18nError('errors.receiptTimeout');
}
