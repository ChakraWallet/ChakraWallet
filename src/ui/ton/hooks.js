// TON wallets of the accounts (public data from the background) and the TON balances of the accounts' summary.
// Balances and history of the wallet screens come from the driver (driver.js) through the shared hooks.
import { useEffect, useState } from 'preact/hooks';
import { bg, local } from '../../shared/ext.js';
import { useApp } from '../components.jsx';
import { TON_CHAINS } from '../../shared/ton/api.js';
import { Address } from '../../shared/ton/core.js';
import { POPULAR_JETTONS } from '../../shared/ton/swap.js';
import { isChainEnabled } from '../../shared/chains.js';
import { loadTonPortfolio } from './driver.js';

let accountsCache = { sig: '', map: null, promise: null };

/** TON wallets of the active wallet's accounts (public data from the background), cached until the accounts change. */
export function useTonAccounts() {
  const { state } = useApp();
  const sig = `${state.activeWallet}|${state.accounts.map((a) => a.address).join()}`;
  const [map, setMap] = useState(accountsCache.sig === sig ? accountsCache.map : null);
  useEffect(() => {
    let alive = true;
    if (accountsCache.sig !== sig || !accountsCache.promise) {
      accountsCache = { sig, map: null, promise: bg('tonAccounts').catch(() => ({})) };
    }
    accountsCache.promise.then((m) => { accountsCache.map = m; if (alive) setMap(m); });
    return () => { alive = false; };
  }, [sig]);
  return map;
}

/** The selected account's TON wallet on the current TON network: { address (friendly), raw, publicKey, version } | null | undefined (loading). */
export function useTonWallet() {
  const { account, chain } = useApp();
  const map = useTonAccounts();
  if (!map) return undefined;
  const w = map[account.address];
  if (!w) return null;
  const net = chain.testnet ? w.testnet : w.mainnet;
  return { address: net.friendly, raw: net.raw, publicKey: w.publicKey, version: w.version };
}

// ------------------------------------------------------------ accounts screen: TON in the multichain summary
const MULTI_TTL = 5 * 60e3;
const multi = new Map(); // raw -> p (same shape as an EVM portfolio: { native, tokens, updated })

/** A TON wallet's balances for the summary: the same portfolio the wallet home shows (driver.js). */
const loadSummary = (chain, raw) => loadTonPortfolio(chain, raw);

/**
 * TON (mainnet) balances of the active wallet's accounts that have a TON address, for the multichain summary:
 * { [account address]: { chain, p, pending } }. Cached values first (memory, then the device), refreshed one account
 * at a time (TON Center allows 1 request/s without a key). reload() refreshes all.
 */
export function useTonSummaries() {
  const { state } = useApp();
  const all = useTonAccounts();
  const map = isChainEnabled(-239, state.settings) ? all : null; // TON switched off in Settings: not in the summary
  const chain = TON_CHAINS[-239];
  const [, setTick] = useState(0);
  const [pending, setPending] = useState({});
  const [force, setForce] = useState(0);
  const sig = map ? Object.keys(map).join() : '';
  useEffect(() => {
    if (!map) return undefined;
    let cancelled = false;
    (async () => {
      const list = Object.entries(map).map(([address, w]) => ({ address, raw: w.mainnet.raw }));
      for (const x of list) {
        if (multi.has(x.raw)) continue;
        const c = await local.get(`tonsum:${x.raw}`, null);
        if (c) multi.set(x.raw, { ...c, stale: true });
      }
      if (cancelled) return;
      setTick((n) => n + 1);
      const todo = list.filter((x) => { const p = multi.get(x.raw); return force > 0 || !p || p.stale || Date.now() - p.updated > MULTI_TTL; });
      setPending(Object.fromEntries(todo.map((x) => [x.address, true])));
      for (const x of todo) {
        if (cancelled) return;
        try {
          const p = await loadSummary(chain, x.raw);
          multi.set(x.raw, p);
          local.set(`tonsum:${x.raw}`, p).catch(() => {});
        } catch { /* keep the cached value */ }
        if (cancelled) return;
        setPending((s) => { const n = { ...s }; delete n[x.address]; return n; });
        setTick((n) => n + 1);
      }
    })();
    return () => { cancelled = true; };
  }, [sig, force, state.activeWallet]);
  const out = {};
  if (map) for (const [address, w] of Object.entries(map)) out[address] = { chain, p: multi.get(w.mainnet.raw) || null, pending: !!pending[address] };
  return { per: out, busy: Object.keys(pending).length > 0, reload: () => setForce((n) => n + 1) };
}

// ------------------------------------------------------------ background check (notifications with the app closed)
// Jettons worth a notification: the well-known ones (STON.fi's list for swaps, src/shared/ton/swap.js) and the ones
// added by hand. Unknown jettons that just arrive (airdrops, mostly ads and scams) never notify.
const WATCH = [['USD₮', 6], ['STON', 9], ['NOT', 9], ['DOGS', 9]]; // symbol and decimals, in POPULAR_JETTONS' order
const upperRaw = (a) => Address.parse(a).toRawString().toUpperCase(); // TON Center's spelling

/**
 * TON's part of the background check (useBackgroundWatch in src/ui/hooks.js -> WatchWorker.java): the TON wallets of
 * the accounts on mainnet, TON Center's address (and key) and the jettons to watch. TON addresses can be read only with
 * the wallet unlocked: while it's locked, and for the accounts of the other wallets, the ones written before stay.
 */
export async function tonWatch(state, prev) {
  const main = TON_CHAINS[-239];
  try {
    if (!isChainEnabled(main.id, state.settings)) return { ton: null };
    if (!state.unlocked) return { ton: prev.ton || null };
    const map = await bg('tonAccounts'); // the active wallet's accounts that have a TON key
    const all = await local.get('accounts', []);
    const exists = new Set(all.map((a) => a.address));
    const active = new Set(state.accounts.map((a) => a.address));
    const accounts = [
      ...all.filter((a) => map[a.address]).map((a) => ({ id: a.address, address: map[a.address].mainnet.raw, name: a.name })),
      ...(prev.ton?.accounts || []).filter((x) => exists.has(x.id) && !active.has(x.id)),
    ];
    const custom = ((await local.get('customTokens', {}))[main.id] || []).map((c) => ({ master: c.address, symbol: c.symbol, decimals: c.decimals }));
    const known = POPULAR_JETTONS.map((m, i) => WATCH[i] && { master: m, symbol: WATCH[i][0], decimals: WATCH[i][1] }).filter(Boolean);
    const seen = new Set();
    const jettons = [...known, ...custom].map((j) => ({ ...j, master: upperRaw(j.master) })).filter((j) => !seen.has(j.master) && seen.add(j.master));
    return { ton: { name: main.name, symbol: main.native.symbol, decimals: main.native.decimals, api: main.api, key: state.settings.tonCenterKey || '', accounts, jettons } };
  } catch { return { ton: prev.ton || null }; }
}
