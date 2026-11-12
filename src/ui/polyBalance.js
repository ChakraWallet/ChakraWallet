// Polymarket funds of an address, for the wallet's totals (home on Polygon, "Your accounts"): cash on the
// separate Polymarket account (Deposit Wallet / Safe) + value of the open positions. What sits on the address
// itself is not counted again: it is already among its tokens.
// Silent: any failure (Polymarket unreachable, blocked by the network or the country) -> null, nothing shown.
import { useEffect, useState } from 'preact/hooks';
import { ethCall, erc20 } from '../shared/rpc.js';
import { BUILTIN_CHAINS } from '../shared/chains.js';
import { openValueOf } from '../shared/polymarket.js';

const POLYGON = BUILTIN_CHAINS.find((c) => c.id === 137);
export const POLY_CHAIN = 137;
// cash on a Polymarket account: pUSD, and USDC.e on older (Safe) accounts
export const CASH_TOKENS = ['0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'];
export const POLY_COLOR = '#2e5cff'; // its segment in the accounts bar
const TTL = 5 * 60 * 1000;
const PARALLEL = 3; // addresses read at the same time (each one is 2-4 requests)

/** What is shown: { cash, positions, total } or null when there is nothing worth a cent. */
export function polyFundsOf(cash, positions) {
  const c = Math.max(0, Number(cash) || 0), p = Math.max(0, Number(positions) || 0);
  return c + p >= 0.01 ? { cash: c, positions: p, total: c + p } : null;
}

// ---- reading, with a small queue and a short cache
const memo = new Map(); // address -> { at, p }
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

async function read(address) {
  const { proxy, value } = await openValueOf(address);
  const cash = proxy
    ? (await Promise.all(CASH_TOKENS.map((tok) => ethCall(POLYGON, tok, erc20.encodeFunctionData('balanceOf', [proxy])).then((r) => Number(BigInt(r)) / 1e6)))).reduce((s, x) => s + x, 0)
    : 0;
  return polyFundsOf(cash, value);
}

/** Polymarket funds of an address, or null (nothing there, or no answer). Never throws. */
export function polyFunds(address, force = false) {
  const k = String(address || '').toLowerCase();
  const hit = memo.get(k);
  if (hit && !force && Date.now() - hit.at < TTL) return hit.p;
  const p = k ? slot(() => read(k)).catch(() => null) : Promise.resolve(null);
  memo.set(k, { at: Date.now(), p });
  return p;
}

/** Funds of one address; a higher `tick` reloads them. */
export function usePolyFunds(address, { enabled = true, tick = 0 } = {}) {
  const [f, setF] = useState({ address: null, funds: null }); // a reload keeps the figure on screen until the new one
  useEffect(() => {
    if (!enabled || !address) return undefined;
    let alive = true;
    polyFunds(address, tick > 0).then((funds) => alive && setF({ address, funds }));
    return () => { alive = false; };
  }, [address, enabled, tick]);
  return enabled && f.address === address ? f.funds : null;
}

/** Funds of several addresses: { address: funds | null }. */
export function usePolyFundsMany(addresses, tick = 0) {
  const [m, setM] = useState({});
  const sig = addresses.join();
  useEffect(() => {
    let alive = true;
    for (const a of addresses) polyFunds(a, tick > 0).then((x) => alive && setM((o) => (o[a] === x ? o : { ...o, [a]: x })));
    return () => { alive = false; };
  }, [sig, tick]);
  return m;
}
