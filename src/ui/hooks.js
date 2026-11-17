import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { local } from '../shared/ext.js';
import { getNativePrice } from '../shared/prices.js';
import { useApp } from './components.jsx';
import { BUILTIN_CHAINS, normalizeCustom, isChainEnabled, getChain } from '../shared/chains.js';
import { bridgeStatus } from '../shared/bridge.js';
import { t, getLang } from '../shared/i18n.js';
import { driverFor, familyOf, isEvmAccount, useAccountAddresses } from './chains/index.js';
import { POPULAR_TOKENS } from '../shared/tokens.js';
import { nftFloor, nftValueKey } from '../shared/nftPrices.js';
import { loadCustomNfts } from '../shared/nft.js';

// ---- failed balance / history scans
// One toast (at most every 20 s) naming the networks that could not be updated; "you're offline" when that's
// the reason. Every failure is also kept in globalThis.__CK_scanLog (last 30) for diagnostics.
let lastScanToast = 0, pendingNets = new Set(), flushTimer = null;
export function reportScanError(info = {}) {
  const log = (globalThis.__CK_scanLog ??= []);
  log.unshift({ at: new Date().toISOString(), online: globalThis.navigator?.onLine, ...info });
  log.length = Math.min(log.length, 30);
  if (info.chain) pendingNets.add(info.chain);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { // gather the failures of one refresh round into one message
    const nets = [...pendingNets]; pendingNets = new Set();
    if (Date.now() - lastScanToast < 20000) return;
    lastScanToast = Date.now();
    const msg = globalThis.navigator?.onLine === false ? t('net.offline') : nets.length ? t('net.scanFailedOn', { chains: nets.join(', ') }) : t('net.scanFailed');
    globalThis.__CK_toast?.(msg, 'warn');
  }, 1500);
}
const checkScan = (p, chain, address) => {
  if (p && p.indexerOk === false && !p.noIndexer) reportScanError({ chain: chain.name, what: 'indexer', error: p.indexerError, address: address?.slice(0, 8) });
  return p;
};
const scanFailed = (e, chain, address) => reportScanError({ chain: chain.name, what: 'rpc', error: e?.message || String(e), address: address?.slice(0, 8) });

export async function tokenPrefs(chainId) {
  const [custom, hidden] = await Promise.all([local.get('customTokens', {}), local.get('hiddenTokens', {})]);
  return { customTokens: custom[chainId] || [], hiddenTokens: hidden[chainId] || [] };
}

// ---- the selected account on the current network (every family through its driver: src/ui/chains)
/**
 * The selected account's address on the current network: { address (as shown), raw (as the network's APIs want it),
 * ready, missing (the account has no key for this family, e.g. an Ethereum private key on TON) }.
 */
export function useChainAddress() {
  const { account, chain } = useApp();
  const map = useAccountAddresses(chain, account ? [account] : []);
  if (!account || !map) return { ready: false };
  const a = map[account.address];
  return a ? { ...a, ready: true } : { ready: true, missing: true };
}

/** Balances of an address on a network (the same portfolio shape for every family). */
export const loadAnyPortfolio = (chain, raw, opts) => driverFor(chain).loadPortfolio(chain, raw, opts);

export function usePortfolio() {
  const { chain, account, state, portfolioCache, setPortfolioCache } = useApp();
  const addr = useChainAddress();
  const key = `${chain.id}:${account?.address}`;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const data = portfolioCache[key];

  const load = useCallback(async () => {
    if (!account || !addr.raw) return;
    setLoading(true); setError('');
    try {
      const prefs = await tokenPrefs(chain.id);
      const p = checkScan(await loadAnyPortfolio(chain, addr.raw, { ...prefs, etherscanKey: state.settings.etherscanKey }), chain, addr.raw);
      setPortfolioCache((c) => ({ ...c, [key]: p }));
      local.set(`cache:${key}`, p).catch(() => {});
    } catch (e) { setError(e.message); scanFailed(e, chain, addr.raw); }
    setLoading(false);
  }, [key, addr.raw]);

  useEffect(() => {
    if (!data) local.get(`cache:${key}`, null).then((c) => c && setPortfolioCache((x) => (x[key] ? x : { ...x, [key]: { ...c, stale: true } })));
    if (!data || Date.now() - data.updated > 30000 || data.stale) load();
  }, [key, addr.raw]);

  return { data, loading, error, reload: load };
}

/** Networks scanned by the multichain view: every mainnet + custom networks (+ the current one if it's a testnet). */
export function scanChains(state, chain) {
  const list = [...BUILTIN_CHAINS.filter((c) => !c.testnet), ...(state.customChains || []).map(normalizeCustom)].filter((c) => isChainEnabled(c.id, state.settings));
  if (!list.some((c) => c.id === chain.id) && familyOf(chain) === 'evm') list.push(chain); // other families: their own summary (driver ui.useSummaries)
  return list;
}

const MULTI_TTL = 5 * 60e3;
/**
 * Portfolios of all accounts of the active wallet on all networks. Cached values (same cache as the home
 * screen, per network+address) are shown at once; stale ones (> 5 min) are refreshed 4 at a time.
 */
export function useMultichainPortfolios() {
  const { chain, state, portfolioCache, setPortfolioCache } = useApp();
  const chains = scanChains(state, chain);
  const [pending, setPending] = useState({});
  const [tick, setTick] = useState(0);
  const cacheRef = useRef(portfolioCache);
  cacheRef.current = portfolioCache;
  const sig = `${state.accounts.map((a) => a.address).join()}|${chains.map((c) => c.id).join()}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pairs = [];
      for (const a of state.accounts) if (isEvmAccount(a)) for (const c of chains) pairs.push({ a, c, key: `${c.id}:${a.address}` }); // accounts of one other family only: no EVM networks
      // 1) cached values first
      const fromDisk = {};
      await Promise.all(pairs.filter((p) => !cacheRef.current[p.key]).map(async (p) => {
        const v = await local.get(`cache:${p.key}`, null);
        if (v) fromDisk[p.key] = { ...v, stale: true };
      }));
      if (cancelled) return;
      if (Object.keys(fromDisk).length) setPortfolioCache((x) => ({ ...fromDisk, ...x }));
      // 2) refresh what is missing or older than 5 minutes (everything on a manual refresh)
      const todo = pairs.filter((p) => {
        const d = cacheRef.current[p.key] || fromDisk[p.key];
        return tick > 0 || !d || Date.now() - d.updated > MULTI_TTL;
      });
      setPending(Object.fromEntries(todo.map((p) => [p.key, true])));
      const prefs = {};
      const worker = async () => {
        while (todo.length && !cancelled) {
          const p = todo.shift();
          try {
            prefs[p.c.id] ??= await tokenPrefs(p.c.id);
            const r = checkScan(await loadAnyPortfolio(p.c, p.a.address, { ...prefs[p.c.id], etherscanKey: state.settings.etherscanKey }), p.c, p.a.address);
            if (!cancelled) setPortfolioCache((c) => ({ ...c, [p.key]: r }));
            local.set(`cache:${p.key}`, r).catch(() => {});
          } catch (e) { if (!cancelled) scanFailed(e, p.c, p.a.address); /* keep the cached value */ }
          if (!cancelled) setPending((x) => { const n = { ...x }; delete n[p.key]; return n; });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    })();
    return () => { cancelled = true; };
  }, [sig, tick]);

  const get = (address) => chains.map((c) => ({ chain: c, p: portfolioCache[`${c.id}:${address}`], pending: !!pending[`${c.id}:${address}`] }));
  return { chains, get, busy: Object.keys(pending).length > 0, pendingCount: Object.keys(pending).length, reload: () => setTick((x) => x + 1) };
}

/** Sums one account's per-network portfolios: totals, networks with funds, holdings sorted by value. */
export function summarize(per, showUnpriced) {
  let usd = 0, unpriced = 0, loaded = 0;
  const nets = [], holdings = [];
  for (const { chain, p } of per) {
    if (!p) continue;
    loaded++;
    const native = { symbol: chain.native.symbol, name: chain.native.name, amount: p.native.amount, usd: p.native.usd, native: true, chain };
    const priced = p.tokens.filter((x) => !x.spam && (x.price != null || x.custom)).map((x) => ({ ...x, chain }));
    const noPrice = p.tokens.filter((x) => x.price == null && !x.custom).map((x) => ({ ...x, chain, unpriced: true }));
    const netUsd = (p.native.usd || 0) + priced.reduce((s, x) => s + (x.usd || 0), 0);
    const hasFunds = netUsd >= 0.01 || p.native.amount > 0 || priced.some((x) => x.amount > 0) || (showUnpriced && noPrice.length > 0);
    usd += netUsd;
    unpriced += noPrice.length;
    if (hasFunds) nets.push({ chain, usd: netUsd, native, priced, noPrice });
    if (p.native.amount > 0) holdings.push(native);
    holdings.push(...priced.filter((x) => x.amount > 0));
  }
  nets.sort((a, b) => b.usd - a.usd || b.native.amount - a.native.amount);
  holdings.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);
  return { usd, nets, holdings, unpriced, loaded, total: per.length, pending: per.filter((x) => x.pending).length };
}

/**
 * Android: keeps the background check (WatchWorker) configured: accounts of every wallet, main networks with
 * their RPCs and well-known tokens, language; asks the notification permission once.
 */
// Families that add their part to the background check (TON in the Android app: src/ui/ton/hooks.js, tonWatch):
// fn(state, prev) -> fields merged into the "watch" config; prev: the config written last time.
const watchExtras = [];
export const registerWatchExtra = (fn) => { watchExtras.push(fn); };

export function useBackgroundWatch(state) {
  const enabled = state?.settings?.notifications !== false;
  const sig = `${state?.initialized}|${state?.unlocked}|${state?.accounts?.length}|${state?.wallets?.length}|${enabled}|${state?.settings?.language}|${state?.settings?.disabledChains}|${state?.settings?.tonCenterKey}`;
  useEffect(() => {
    const n = globalThis.__CK_NOTIFY__;
    if (!n || !state?.initialized) return;
    (async () => {
      const accounts = (await local.get('accounts', [])).map((a) => ({ address: a.address, name: a.name }));
      const chains = BUILTIN_CHAINS.filter((c) => !c.testnet && isChainEnabled(c.id, state.settings)).map((c) => ({
        id: c.id, name: c.name, symbol: c.native.symbol, decimals: c.native.decimals, rpc: c.rpc,
        tokens: (POPULAR_TOKENS[c.id] || []).map((x) => ({ address: x.address, symbol: x.symbol, decimals: x.decimals })),
      }));
      const prev = await local.get('watch', {});
      const extra = Object.assign({}, ...(await Promise.all(watchExtras.map((f) => f(state, prev).catch(() => ({}))))));
      await local.set('watch', { enabled, lang: getLang(), accounts, chains, ...extra });
      await n.schedule({ enabled }).catch(() => {});
      if (enabled && !(await local.get('notifAsked', false))) {
        await local.set('notifAsked', true);
        await n.requestPermission().catch(() => {});
      }
    })();
  }, [sig]);
}

/** While the app is open: checks the transfers still in transit every 15 s and announces their arrival. */
export function useBridgeTracker(toast) {
  useEffect(() => {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const list = await local.get('bridges', []);
        const pending = list.filter((b) => b.status === 'pending' && Date.now() - b.created < 3 * 864e5);
        for (const b of pending) {
          let r;
          try { r = await bridgeStatus(b); } catch { continue; }
          if (r.status === 'pending') continue;
          await local.update('bridges', [], (l) => l.map((x) => (x.id === b.id ? { ...x, status: r.status, destTxHash: r.destTxHash || x.destTxHash, updated: Date.now() } : x)));
          const to = getChain(b.toChainId)?.name || ''; // also TON (Android app)
          toast(t(`bridge.toast.${r.status}`, { symbol: b.toToken.symbol, chain: to }));
          // app in background: a system notification (the native side shows it only if not in the foreground)
          if (document.hidden) globalThis.__CK_NOTIFY__?.notify({ id: `bridge${b.id}`, title: t(`bridge.toast.${r.status}`, { symbol: b.toToken.symbol, chain: to }), body: `${b.provider}`, positive: r.status === 'done' }).catch(() => {});
        }
      } finally { busy = false; }
    };
    tick();
    const iv = setInterval(tick, 15000);
    return () => clearInterval(iv);
  }, []);
}

export function useNativePrice(chain) {
  const [p, setP] = useState(null);
  useEffect(() => { getNativePrice(chain).then(setP).catch(() => setP(null)); }, [chain.id]);
  return p;
}

export function useAsync(fn, deps) {
  const [s, setS] = useState({ loading: true, data: null, error: null });
  const run = useCallback(() => {
    setS((x) => ({ ...x, loading: true, error: null }));
    return fn().then((data) => setS({ loading: false, data, error: null }), (error) => setS({ loading: false, data: null, error }));
  }, deps);
  useEffect(() => { run(); }, deps);
  return { ...s, reload: run };
}

// ---- NFTs of the account on the current network (home screen, under the tokens)
const nftMem = new Map(); // key -> { items, unsupported, updated }
/** The NFTs of a network change (one added or removed by hand): every account's list is read again. */
export function forgetNfts(chainId) {
  for (const k of [...nftMem.keys()]) if (k.startsWith(`${chainId}:`)) nftMem.delete(k);
}
/** NFTs added by hand on a network: [{ contract, tokenId }] (storage 'customNfts', per network). */
export async function saveCustomNft(chainId, ref, add = true) {
  const same = (x) => x.contract === ref.contract && x.tokenId === ref.tokenId;
  await local.update('customNfts', {}, (all) => ({ ...all, [chainId]: [...(all[chainId] || []).filter((x) => !same(x)), ...(add ? [{ contract: ref.contract, tokenId: ref.tokenId }] : [])] }));
  forgetNfts(chainId);
}
/** { data: { items, unsupported, updated } | null, loading, error, reload }. Kept on the device; refreshed after 5 min. */
export function useNfts(enabled = true) {
  const { chain, account, state } = useApp();
  const addr = useChainAddress();
  const drv = driverFor(chain);
  const key = `${chain.id}:${account?.address}`;
  const [data, setData] = useState(() => nftMem.get(key) || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!drv.loadNfts || !addr.raw) return;
    setLoading(true); setError('');
    let r = null;
    try { r = await drv.loadNfts(chain, addr.raw, { etherscanKey: state.settings.etherscanKey }); } catch (e) { setError(e.message || 'NFT'); }
    // NFTs added by hand (EVM): shown while the account owns them, also where the indexer lists nothing
    const refs = drv.features?.customNfts ? (await local.get('customNfts', {}))[chain.id] || [] : [];
    if (refs.length) {
      const extra = await loadCustomNfts(chain, addr.raw, refs).catch(() => []);
      const items = [...(r?.items || [])];
      for (const x of extra) {
        const i = items.findIndex((y) => y.key === x.key);
        if (i >= 0) items[i] = { ...items[i], custom: true, spam: false }; else items.unshift(x);
      }
      r = { ...(r || { unsupported: false }), items };
    }
    if (r) {
      r = { ...r, updated: Date.now() };
      nftMem.set(key, r); setData(r);
      local.set(`nfts:${key}`, r).catch(() => {});
    }
    setLoading(false);
  }, [key, addr.raw]);
  useEffect(() => {
    if (!enabled || !drv.loadNfts) return;
    const mem = nftMem.get(key);
    setData(mem || null);
    if (!mem) local.get(`nfts:${key}`, null).then((c) => { if (c && !nftMem.has(key)) setData(c); }).catch(() => {});
    if (!mem || Date.now() - mem.updated > 300000) load();
  }, [key, addr.raw, enabled]);
  return { data: drv.loadNfts ? data : null, loading, error, reload: load };
}

// ---- NFT values: the floor price of each collection held (src/shared/nftPrices.js), and their sum in USD
const nftPriceMem = new Map(); // value key -> price | null
/** { priceOf(nft) -> { native, symbol, usd, source } | null | undefined (loading), total (USD) }. Spam is never priced. */
export function useNftPrices(items) {
  const { chain, state } = useApp();
  const s = state.settings;
  const keys = `${s.openseaKey || ''}|${s.getgemsKey || ''}|${s.nftHistory || ''}`;
  const [prices, setPrices] = useState({});
  useEffect(() => {
    const byCollection = new Map();
    for (const n of items || []) if (!n.spam) { const k = nftValueKey(chain, n); if (!byCollection.has(k)) byCollection.set(k, n); }
    const list = chain.testnet ? [] : [...byCollection.entries()].slice(0, 40); // the free services allow a few requests a minute
    setPrices(Object.fromEntries(list.filter(([k]) => nftPriceMem.has(k)).map(([k]) => [k, nftPriceMem.get(k)])));
    let alive = true;
    const queue = [...list];
    const worker = async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        const [k, n] = e;
        const v = await nftFloor(chain, n, s).catch(() => null);
        nftPriceMem.set(k, v);
        if (alive) setPrices((p) => ({ ...p, [k]: v }));
      }
    };
    Promise.all([worker(), worker()]);
    return () => { alive = false; };
  }, [chain.id, items, keys]);
  const priceOf = (n) => (n.spam ? null : prices[nftValueKey(chain, n)]);
  const total = (items || []).reduce((sum, n) => { const v = priceOf(n); return v?.usd ? sum + v.usd * Math.min(Math.max(1, Number(n.amount) || 1), 1000) : sum; }, 0);
  return { priceOf, total };
}

// ---- NFT visibility chosen by the user: over the automatic spam check, kept on the device per network
const nftVisibilitySubs = new Set(); // every screen using it reloads after a change (home + the NFT's page)
/**
 * { apply(items) -> items with `spam` as the user wants and `autoSpam` (what the check said), of(nft) -> 'show' |
 * 'hide' | null, set(nft, 'show' | 'hide' | null) }. null = the automatic choice.
 */
export function useNftVisibility() {
  const { chain } = useApp();
  const key = `nftVisibility:${chain.id}`;
  const [map, setMap] = useState({});
  useEffect(() => {
    let alive = true;
    const load = () => local.get(key, {}).then((m) => { if (alive) setMap(m || {}); }).catch(() => {});
    load(); nftVisibilitySubs.add(load);
    return () => { alive = false; nftVisibilitySubs.delete(load); };
  }, [key]);
  const set = async (nft, v) => {
    await local.update(key, {}, (m) => { const n = { ...(m || {}) }; if (v) n[nft.key] = v; else delete n[nft.key]; return n; });
    nftVisibilitySubs.forEach((f) => f());
  };
  const of = (nft) => map[nft.key] || null;
  // stable while the choices don't change (the price hook reloads when its items change)
  const apply = useCallback((items) => items?.map((n) => {
    const auto = n.autoSpam ?? n.spam, v = map[n.key];
    return { ...n, autoSpam: auto, spam: v ? v === 'hide' : auto };
  }), [map]);
  return { apply, of, set };
}
