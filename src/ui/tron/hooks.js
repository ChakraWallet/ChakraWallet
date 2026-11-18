// Tron addresses of the accounts (public data from the background), the Tron balances of the accounts' summary, and
// Tron's part of the background check (notifications with the app closed). Balances and history of the wallet screens
// come from the driver (driver.js) through the shared hooks.
import { useEffect, useState } from 'preact/hooks';
import { bg, local } from '../../shared/ext.js';
import { useApp } from '../components.jsx';
import { TRON_CHAINS, TRON_MAINNET } from '../../shared/tron/api.js';
import { loadTronPortfolio, POPULAR_TRC20 } from '../../shared/tron/tokens.js';
import { isChainEnabled } from '../../shared/chains.js';

let accountsCache = { sig: '', map: null, promise: null };

/** Tron addresses of the active wallet's accounts: { [account address]: { address } }, cached until they change. */
export function useTronAccounts() {
  const { state } = useApp();
  const sig = `${state.activeWallet}|${state.accounts.map((a) => a.address).join()}`;
  const [map, setMap] = useState(accountsCache.sig === sig ? accountsCache.map : null);
  useEffect(() => {
    let alive = true;
    if (accountsCache.sig !== sig || !accountsCache.promise) accountsCache = { sig, map: null, promise: bg('tronAccounts').catch(() => ({})) };
    accountsCache.promise.then((m) => { accountsCache.map = m; if (alive) setMap(m); });
    return () => { alive = false; };
  }, [sig]);
  return map;
}

// ------------------------------------------------------------ accounts screen: Tron in the multichain summary
const MULTI_TTL = 5 * 60e3;
const multi = new Map(); // address -> portfolio

/**
 * Tron (mainnet) balances of the active wallet's accounts that have a Tron address, for the multichain summary:
 * { per: { [account address]: { chain, p, pending } }, busy, reload }. Cached values first (memory, then the device),
 * refreshed one account at a time (TronGrid without a key allows few requests).
 */
export function useTronSummaries() {
  const { state } = useApp();
  const all = useTronAccounts();
  const map = isChainEnabled(TRON_MAINNET, state.settings) ? all : null;
  const chain = TRON_CHAINS[TRON_MAINNET];
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
        const c = await local.get(`trxsum:${x.raw}`, null);
        if (c) multi.set(x.raw, { ...c, stale: true });
      }
      if (cancelled) return;
      setTick((n) => n + 1);
      const todo = list.filter((x) => { const p = multi.get(x.raw); return force > 0 || !p || p.stale || Date.now() - p.updated > MULTI_TTL; });
      setPending(Object.fromEntries(todo.map((x) => [x.address, true])));
      const custom = ((await local.get('customTokens', {}))[chain.id] || []);
      for (const x of todo) {
        if (cancelled) return;
        try {
          const p = await loadTronPortfolio(chain, x.raw, { customTokens: custom });
          multi.set(x.raw, p);
          local.set(`trxsum:${x.raw}`, p).catch(() => {});
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
 * Tron's part of the background check (useBackgroundWatch in src/ui/hooks.js -> WatchWorker.java): the accounts' Tron
 * addresses on mainnet, TronGrid (with the key, if any) and the tokens worth a notification (the well-known ones and
 * those added by hand; unknown tokens that just arrive are mostly scams). Tron addresses can be read only with the
 * wallet unlocked: while it's locked, and for the other wallets' accounts, the ones written before stay.
 */
export async function tronWatch(state, prev) {
  const main = TRON_CHAINS[TRON_MAINNET];
  try {
    if (!isChainEnabled(main.id, state.settings)) return { tron: null };
    if (!state.unlocked) return { tron: prev.tron || null };
    const map = await bg('tronAccounts');
    const all = await local.get('accounts', []);
    const exists = new Set(all.map((a) => a.address));
    const active = new Set(state.accounts.map((a) => a.address));
    const accounts = [
      ...all.filter((a) => map[a.address]).map((a) => ({ id: a.address, address: map[a.address].address, name: a.name })),
      ...(prev.tron?.accounts || []).filter((x) => exists.has(x.id) && !active.has(x.id)),
    ];
    const custom = ((await local.get('customTokens', {}))[main.id] || []).filter((c) => !c.trc10).map((c) => ({ address: c.address, symbol: c.symbol, decimals: c.decimals }));
    const seen = new Set();
    const tokens = [...POPULAR_TRC20[TRON_MAINNET].map(([address, symbol, , decimals]) => ({ address, symbol, decimals })), ...custom].filter((x) => !seen.has(x.address) && seen.add(x.address));
    return {
      tron: {
        name: main.name, symbol: main.native.symbol, decimals: main.native.decimals, api: main.api,
        key: String(state.settings.tronGridKey || '').trim(), accounts, tokens,
      },
    };
  } catch { return { tron: prev.tron || null }; }
}
