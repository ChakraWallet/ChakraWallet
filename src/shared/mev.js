// MEV protection: on networks with a public mempool where bots front-run and "sandwich" swaps (Ethereum), a signed
// transaction is sent to a private channel to the block builders (Flashbots Protect) instead of the public nodes.
// It is the same signed transaction: only who receives it first changes. The private channel never sees a reverted
// transaction land on-chain (no fee paid for a failed swap). If the channel can't be reached, the transaction goes to
// the network's usual nodes, as without protection. Settings > Security: on by default.
import { rpc, RpcError } from './rpc.js';
import { ENDPOINTS } from './endpoints.js';
import { getJson } from './http.js';

/** Private channel of a network, or null (L2s have no public mempool: their sequencer orders transactions). */
export const mevRpc = (chainId) => (Number(chainId) === 1 ? ENDPOINTS.mevEth || null : null);
export const mevAvailable = (chainId) => !!mevRpc(chainId);

/**
 * The private channel's answer: the hash, an RpcError (its verdict on the transaction: nonce, funds... it answers
 * with HTTP 400 and the error in the body), or null when it can't be reached or is busy (then: the nodes).
 */
async function sendPrivate(url, signed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signed] }) });
    const j = await res.json().catch(() => null);
    if (j?.result) return j.result;
    if (j?.error && res.status !== 429 && res.status < 500 && j.error.code !== -32005) throw new RpcError(j.error.message, j.error.code, j.error.data);
    return null;
  } catch (e) { if (e instanceof RpcError) throw e; return null; } finally { clearTimeout(timer); }
}

/**
 * What the private channel did with a transaction it received: 'PENDING', 'INCLUDED', 'FAILED' (given up after 25
 * blocks: never mined), 'CANCELLED' (by a cancellation of the sender), 'UNKNOWN'; null when it can't be asked.
 */
export async function privateStatus(chainId, hash) {
  const base = mevRpc(chainId) && ENDPOINTS.mevStatus;
  if (!base) return null;
  try {
    const j = await getJson(`${base}/${hash}`, { timeout: 8000, retries: 0, label: 'Flashbots' });
    return typeof j?.status === 'string' ? j.status.toUpperCase() : null;
  } catch { return null; }
}

/** Sends a signed transaction: through the private channel when protected, else (or if unreachable) the nodes (Alchemy first, when set). */
export async function sendRaw(chain, signed, { protect = true } = {}) {
  const url = protect ? mevRpc(chain.id) : null;
  if (url) {
    const hash = await sendPrivate(url, signed); // its errors stand: the nodes would say the same, and see the swap
    if (hash) return { hash, protected: true };
  }
  return { hash: await rpc(chain, 'eth_sendRawTransaction', [signed], { send: true }), protected: false }; // Alchemy first, when set
}
