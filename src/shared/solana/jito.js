// MEV protection on Solana (Settings > Security, "MEV protection", like Flashbots on Ethereum): a swap goes to Jito's
// block engine as a private one-transaction bundle ("bundleOnly"), not to the public nodes, where whoever produces
// the next blocks could see it and trade around it ("sandwich"). Jito runs on the validators that produce most of the
// blocks; the transaction carries a small tip for them (Jupiter adds it) and, as a bundle, never lands if it fails (no
// fee for a failed swap). If Jito can't be reached the swap goes to the usual nodes, as without protection.
import { ENDPOINTS } from '../endpoints.js';
import { RpcError } from './api.js';
import { toBase64 } from './core.js';

export const jitoAvailable = (chain) => !!ENDPOINTS.jito && chain?.kind === 'solana' && !chain.testnet;

const TIP_MIN = 10_000n, TIP_MAX = 200_000n; // lamports: 0.00001 - 0.0002 SOL
let tipCache = { at: 0, lamports: null };

/** The tip to offer: what landed three bundles out of four in recent blocks, within sane bounds. */
export async function jitoTip() {
  if (Date.now() - tipCache.at < 60_000 && tipCache.lamports != null) return tipCache.lamports;
  let lamports = TIP_MIN;
  try {
    const r = await fetch(`${ENDPOINTS.jitoTips}/api/v1/bundles/tip_floor`, { signal: AbortSignal.timeout(8000) });
    const p75 = Number((await r.json())?.[0]?.landed_tips_75th_percentile);
    if (Number.isFinite(p75) && p75 > 0) lamports = BigInt(Math.ceil(p75 * 1e9));
  } catch { /* the minimum */ }
  lamports = lamports < TIP_MIN ? TIP_MIN : lamports > TIP_MAX ? TIP_MAX : lamports;
  tipCache = { at: Date.now(), lamports };
  return lamports;
}

/**
 * Sends a signed transaction (with its tip) as a private bundle: its signature, an RpcError when Jito refuses it (its
 * verdict on the transaction), or null when Jito can't be reached or is busy (then: the usual nodes).
 */
export async function sendViaJito(bytes) {
  try {
    const res = await fetch(`${ENDPOINTS.jito}/api/v1/transactions?bundleOnly=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [toBase64(bytes), { encoding: 'base64' }] }),
    });
    const j = await res.json().catch(() => null);
    if (j?.result) return j.result;
    if (j?.error && res.status !== 429 && res.status < 500) throw new RpcError(j.error.message || 'Jito', j.error.code, j.error.data);
    return null;
  } catch (e) { if (e instanceof RpcError) throw e; return null; }
}
