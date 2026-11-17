// Solana addresses of the accounts (public data from the background) and the Solana balances of the accounts'
// summary. Balances and history of the wallet screens come from the driver (driver.js) through the shared hooks.
import { useEffect, useState } from 'preact/hooks';
import { bg, local } from '../../shared/ext.js';
import { useApp } from '../components.jsx';
import { SOL_CHAINS, SOL_MAINNET } from '../../shared/solana/api.js';
import { loadSolPortfolio, POPULAR_SPL } from '../../shared/solana/tokens.js';
import { isChainEnabled } from '../../shared/chains.js';

let accountsCache = { sig: '', map: null, promise: null };

/** Solana addresses of the active wallet's accounts: { [account address]: { address } }, cached until they change. */
export function useSolAccounts() {
  const { state } = useApp();
  const sig = `${state.activeWallet}|${state.accounts.map((a) => a.address).join()}`;
  const [map, setMap] = useState(accountsCache.sig === sig ? accountsCache.map : null);
  useEffect(() => {
    let alive = true;
    if (accountsCache.sig !== sig || !accountsCache.promise) accountsCache = { sig, map: null, promise: bg('solanaAccounts').catch(() => ({})) };
    accountsCache.promise.then((m) => { accountsCache.map = m; if (alive) setMap(m); });
    return () => { alive = false; };
  }, [sig]);
  return map;
}

/** The selected account's Solana address: { address, raw } | null (no key) | undefined (loading). */
export function useSolWallet() {
  const { account } = useApp();
  const map = useSolAccounts();
  if (!map) return undefined;
  const w = map[account.address];
  return w ? { address: w.address, raw: w.address } : null;
}

// ------------------------------------------------------------ accounts screen: Solana in the multichain summary
const MULTI_TTL = 5 * 60e3;
const multi = new Map(); // address -> portfolio

/**
 * Solana (mainnet) balances of the active wallet's accounts that have a Solana address, for the multichain summary:
 * { per: { [account address]: { chain, p, pending } }, busy, reload }. Cached values first (memory, then the device),
 * refreshed one account at a time (the public nodes allow few requests).
 */
export function useSolSummaries() {
  const { state } = useApp();
  const all = useSolAccounts();
  const map = isChainEnabled(SOL_MAINNET, state.settings) ? all : null;
  const chain = SOL_CHAINS[SOL_MAINNET];
  const [, setTick] = useState(0);
  const [pending, setPending] = useState({});
  const [force, setForce] = useState(0);
  const sig = map ? Object.keys(map).join() : '';
  useEffect(() => {
    if (!map) return undefined;
    let cancelled = false;
    (async () => {
      const list = Object.entries(map).map(([address, w]) => ({ address, raw: w.address }));
      for (const x of list) {
        if (multi.has(x.raw)) continue;
        const c = await local.get(`solsum:${x.raw}`, null);
        if (c) multi.set(x.raw, { ...c, stale: true });
      }
      if (cancelled) return;
      setTick((n) => n + 1);
      const todo = list.filter((x) => { const p = multi.get(x.raw); return force > 0 || !p || p.stale || Date.now() - p.updated > MULTI_TTL; });
      setPending(Object.fromEntries(todo.map((x) => [x.address, true])));
      for (const x of todo) {
        if (cancelled) return;
        try {
          const p = await loadSolPortfolio(chain, x.raw);
          multi.set(x.raw, p);
          local.set(`solsum:${x.raw}`, p).catch(() => {});
        } catch { /* keep the cached value */ }
        if (cancelled) return;
        setPending((s) => { const n = { ...s }; delete n[x.address]; return n; });
        setTick((n) => n + 1);
      }
    })();
    return () => { cancelled = true; };
  }, [sig, force, state.activeWallet]);
  const out = {};
  if (map) for (const [address, w] of Object.entries(map)) out[address] = { chain, p: multi.get(w.address) || null, pending: !!pending[address] };
  return { per: out, busy: Object.keys(pending).length > 0, reload: () => setForce((n) => n + 1) };
}

// ------------------------------------------------------------ background check (notifications with the app closed)
/**
 * Solana's part of the background check (useBackgroundWatch in src/ui/hooks.js -> WatchWorker.java): the accounts'
 * Solana addresses on mainnet, the public node (or the Helius one) and the tokens worth a notification (the well-known
 * ones and those added by hand; unknown tokens that just arrive are mostly ads and scams). Solana addresses can be read
 * only with the wallet unlocked: while it's locked, and for the other wallets' accounts, the ones written before stay.
 */
export async function solWatch(state, prev) {
  const main = SOL_CHAINS[SOL_MAINNET];
  try {
    if (!isChainEnabled(main.id, state.settings)) return { solana: null };
    if (!state.unlocked) return { solana: prev.solana || null };
    const map = await bg('solanaAccounts');
    const all = await local.get('accounts', []);
    const exists = new Set(all.map((a) => a.address));
    const active = new Set(state.accounts.map((a) => a.address));
    const accounts = [
      ...all.filter((a) => map[a.address]).map((a) => ({ id: a.address, address: map[a.address].address, name: a.name })),
      ...(prev.solana?.accounts || []).filter((x) => exists.has(x.id) && !active.has(x.id)),
    ];
    const custom = ((await local.get('customTokens', {}))[main.id] || []).map((c) => ({ mint: c.address, symbol: c.symbol, decimals: c.decimals }));
    const seen = new Set();
    const tokens = [...POPULAR_SPL.map(([mint, symbol, decimals]) => ({ mint, symbol, decimals })), ...custom].filter((x) => !seen.has(x.mint) && seen.add(x.mint));
    const key = String(state.settings.heliusKey || '').trim();
    return {
      solana: {
        name: main.name, symbol: main.native.symbol, decimals: main.native.decimals,
        // nodes in order (the first that answers): Helius with a key; the public mainnet node before publicnode, which
        // refuses token-account queries
        rpc: [...(key ? [`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`] : []), ...[...main.rpc].reverse()], accounts, tokens,
      },
    };
  } catch { return { solana: prev.solana || null }; }
}
