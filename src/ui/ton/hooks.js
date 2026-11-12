// TON data for the screens: the TON address of the selected account, balances (GRAM + jettons) and history.
// Kept in memory per network and address, so going back to a screen shows the last data at once.
import { useEffect, useState, useCallback } from 'preact/hooks';
import { bg, local } from '../../shared/ext.js';
import { useApp } from '../components.jsx';
import { tonAccount, tonJettons, tonHistory, gramPrice, TON_CHAINS } from '../../shared/ton/api.js';

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

const portfolio = new Map(); // `${chainId}:${raw}` -> data

/** GRAM + jettons of an address: { gram: { balance, amount, price, usd }, jettons, totalUsd, status, seqno, updated } */
export function useTonPortfolio(chain, raw) {
  const key = `${chain.id}:${raw}`;
  const [data, setData] = useState(() => portfolio.get(key) || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!raw) return;
    setLoading(true); setError('');
    try {
      const [acc, jettons, price] = await Promise.all([tonAccount(chain, raw), tonJettons(chain, raw), gramPrice(chain).catch(() => null)]);
      const amount = Number(acc.balance) / 1e9;
      const gram = { balance: acc.balance, amount, price, usd: price != null ? amount * price : null };
      const visible = jettons.filter((j) => !j.scam);
      const totalUsd = (gram.usd || 0) + visible.reduce((s, j) => s + (j.usd || 0), 0);
      const d = { gram, jettons: visible, totalUsd, status: acc.status, seqno: acc.seqno, updated: Date.now() };
      portfolio.set(key, d);
      setData(d);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [key]);
  useEffect(() => {
    const c = portfolio.get(key);
    setData(c || null);
    if (!c || Date.now() - c.updated > 30000) load();
  }, [key]);
  return { data, loading, error, reload: load };
}

/** History, newest first, with "load more". */
export function useTonHistory(chain, raw, limit = 20) {
  const [rows, setRows] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (more) => {
    if (!raw) return;
    setBusy(true); setError('');
    try {
      const r = await tonHistory(chain, raw, { limit, cursor: more ? cursor : undefined });
      setRows((prev) => (more && prev ? [...prev, ...r.rows] : r.rows));
      setCursor(r.cursor);
    } catch (e) { setError(e.message); if (!more) setRows((p) => p || []); }
    setBusy(false);
  }, [chain.id, raw, cursor]);
  useEffect(() => { setRows(null); setCursor(null); load(false); }, [chain.id, raw]);
  return { rows, busy, error, more: cursor ? () => load(true) : null, reload: () => load(false) };
}

/** Forget cached balances of an address (after a send). */
export const invalidateTon = (chainId, raw) => portfolio.delete(`${chainId}:${raw}`);

// ------------------------------------------------------------ accounts screen: TON in the multichain summary
const MULTI_TTL = 5 * 60e3;
const multi = new Map(); // raw -> p (same shape as an EVM portfolio: { native, tokens, updated })

/** A TON wallet's balances in the shape of an EVM portfolio (numbers and strings only: it is stored on the device). */
async function loadSummary(chain, raw) {
  const [acc, jettons, price] = await Promise.all([tonAccount(chain, raw), tonJettons(chain, raw), gramPrice(chain).catch(() => null)]);
  const amount = Number(acc.balance) / 1e9;
  return {
    native: { amount, usd: price != null ? amount * price : null, balance: acc.balance.toString() },
    tokens: jettons.filter((j) => !j.scam).map((j) => ({ address: j.master, symbol: j.symbol, name: j.name, decimals: j.decimals, amount: j.amount, usd: j.usd, price: j.price, icon: j.image, balance: j.balance.toString() })),
    updated: Date.now(),
  };
}

/**
 * TON (mainnet) balances of the active wallet's accounts that have a TON address, for the multichain summary:
 * { [account address]: { chain, p, pending } }. Cached values first (memory, then the device), refreshed one account
 * at a time (TON Center allows 1 request/s without a key). reload() refreshes all.
 */
export function useTonSummaries() {
  const { state } = useApp();
  const map = useTonAccounts();
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
