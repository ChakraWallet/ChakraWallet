// Bitcoin balances of the accounts' summary, and Bitcoin's part of the background check (notifications with the app
// closed: WatchWorker.java). Balances and history of the wallet screens come from the driver through the shared hooks.
import { useEffect, useState } from 'preact/hooks';
import { bg, local } from '../../shared/ext.js';
import { useApp } from '../components.jsx';
import { isChainEnabled } from '../../shared/chains.js';
import { BTC_CHAINS, BTC_MAINNET } from '../../shared/btc/networks.js';
import { encodeAccount, loadState, addressAt } from '../../shared/btc/account.js';
import { btcDriver } from './driver.js';

const MAIN = BTC_CHAINS[BTC_MAINNET];
let accountsCache = { sig: '', promise: null };
/** The public Bitcoin accounts (mainnet) of the active wallet: { [account address]: public account }. */
function btcAccounts(sig) {
  if (accountsCache.sig !== sig || !accountsCache.promise) accountsCache = { sig, promise: bg('btcAccounts', { chainId: BTC_MAINNET }).catch(() => ({})) };
  return accountsCache.promise;
}

const MULTI_TTL = 5 * 60e3;
const multi = new Map(); // account address -> portfolio
/** Bitcoin (mainnet) balances of the active wallet's accounts, for the multichain summary: { per, busy, reload }. */
export function useBtcSummaries() {
  const { state } = useApp();
  const on = isChainEnabled(BTC_MAINNET, state.settings);
  const sig = `${state.activeWallet}|${state.accounts.map((a) => a.address).join()}`;
  const [map, setMap] = useState(null);
  const [, setTick] = useState(0);
  const [pending, setPending] = useState({});
  const [force, setForce] = useState(0);
  useEffect(() => { if (on) btcAccounts(sig).then(setMap); else setMap(null); }, [sig, on]);
  useEffect(() => {
    if (!map) return undefined;
    let cancelled = false;
    (async () => {
      const list = Object.entries(map);
      for (const [address] of list) {
        if (multi.has(address)) continue;
        const c = await local.get(`btcsum:${address}`, null);
        if (c) multi.set(address, { ...c, stale: true });
      }
      if (cancelled) return;
      setTick((n) => n + 1);
      const todo = list.filter(([address]) => { const p = multi.get(address); return force > 0 || !p || p.stale || Date.now() - p.updated > MULTI_TTL; });
      setPending(Object.fromEntries(todo.map(([address]) => [address, true])));
      for (const [address, a] of todo) {
        if (cancelled) return;
        try {
          const p = await btcDriver.loadPortfolio(MAIN, encodeAccount(a));
          multi.set(address, p);
          local.set(`btcsum:${address}`, p).catch(() => {});
        } catch { /* keep the cached value */ }
        if (cancelled) return;
        setPending((s) => { const n = { ...s }; delete n[address]; return n; });
        setTick((n) => n + 1);
      }
    })();
    return () => { cancelled = true; };
  }, [map, force]);
  const out = {};
  if (map) for (const address of Object.keys(map)) out[address] = { chain: MAIN, p: multi.get(address) || null, pending: !!pending[address] };
  return { per: out, busy: Object.keys(pending).length > 0, reload: () => setForce((n) => n + 1) };
}

/**
 * Bitcoin's part of the background check (useBackgroundWatch -> WatchWorker.java): for every account, the addresses
 * to look at - the used ones and the next receive addresses of each type - on mainnet. Read only with the wallet
 * unlocked: while it's locked, and for the other wallets' accounts, the ones written before stay.
 */
export async function btcWatch(state, prev) {
  try {
    if (!isChainEnabled(BTC_MAINNET, state.settings)) return { bitcoin: null };
    if (!state.unlocked) return { bitcoin: prev.bitcoin || null };
    const map = await bg('btcAccounts', { chainId: BTC_MAINNET });
    const all = await local.get('accounts', []);
    const exists = new Set(all.map((a) => a.address));
    const active = new Set(state.accounts.map((a) => a.address));
    const accounts = [];
    for (const acc of all) {
      const a = map[acc.address];
      if (!a) continue;
      const s = await loadState(MAIN, a);
      const addrs = new Set(Object.keys(s.addrs));
      a.branches.forEach((br, b) => {
        if (!(a.receive || []).includes(br.type)) return;
        const next = br.single ? 0 : s.next[`${b}:0`] || 0;
        for (let i = next; i < next + (br.single ? 1 : 3); i++) addrs.add(addressAt(MAIN, a, b, 0, br.single ? 0 : i));
      });
      accounts.push({ id: acc.address, name: acc.name, addresses: [...addrs].slice(0, 60) });
    }
    accounts.push(...(prev.bitcoin?.accounts || []).filter((x) => exists.has(x.id) && !active.has(x.id) && !accounts.some((y) => y.id === x.id)));
    return { bitcoin: { name: MAIN.name, symbol: MAIN.native.symbol, decimals: MAIN.native.decimals, api: MAIN.esplora[0], accounts } };
  } catch { return { bitcoin: prev.bitcoin || null }; }
}
