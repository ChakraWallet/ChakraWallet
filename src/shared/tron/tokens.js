// Tron balances: TRX (spendable, staked, being unstaked), TRC-20 tokens (TronGrid lists them all in one call) and TRC-10
// tokens (the old built-in standard: almost only airdrops today, kept apart until the user shows one). Names, symbols
// and decimals: the well-known tokens below, then the contract itself (cached on the device). Prices: DefiLlama.
// Shapes: the shared portfolio (src/ui/chains/driver.d.md).
import { local } from '../ext.js';
import { getPrices } from '../prices.js';
import { isSpamToken } from '../portfolio.js';
import { TRON_MAINNET, TRON_NILE, getV1Account, getAccount, tronApi, trc20Read, TronError } from './api.js';
import { isAddress } from './core.js';

const TW = (a) => `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/tron/assets/${a}/logo.png`;
const CG = 'https://assets.coingecko.com/coins/images/';
/** [address, symbol, name, decimals, icon]: verified on chain (symbol and decimals of each contract). */
export const POPULAR_TRC20 = {
  [TRON_MAINNET]: [
    ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT', 'Tether USD', 6, TW('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')],
    ['TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 'USDC', 'USD Coin', 6, TW('TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8')],
    ['TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz', 'USDD', 'Decentralized USD', 18, TW('TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz')],
    ['TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn', 'USDD', 'Decentralized USD (old)', 18, TW('TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn')],
    ['TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4', 'TUSD', 'TrueUSD', 18, TW('TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4')],
    ['TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', 'WTRX', 'Wrapped TRX', 6, TW('TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR')],
    ['TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5', 'sTRX', 'Staked TRX', 18, ''],
    ['TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9', 'BTC', 'Bitcoin (on Tron)', 8, `${CG}1/small/bitcoin.png`],
    ['THb4CqiFdwNHsWsQCs4JhzwjMWys4aqCbF', 'ETH', 'Ethereum (on Tron)', 18, `${CG}279/small/ethereum.png`],
    ['TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4', 'BTT', 'BitTorrent', 18, TW('TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4')],
    ['TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9', 'JST', 'JUST', 18, TW('TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9')],
    ['TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S', 'SUN', 'SUN', 18, TW('TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S')],
    ['TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', 'WIN', 'WINkLink', 6, TW('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7')],
    ['TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq', 'NFT', 'APENFT', 6, TW('TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq')],
  ],
  [TRON_NILE]: [
    ['TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', 'USDT', 'Tether USD (Nile)', 6, TW('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')],
  ],
};
export const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const popularOf = (chain) => (POPULAR_TRC20[chain.id] || []).map(([address, symbol, name, decimals, icon]) => ({ address, symbol, name, decimals, icon, known: true }));
const popularMap = (chain) => new Map(popularOf(chain).map((p) => [p.address, p]));
export const llamaKey = (address) => `tron:${address}`;
export const shortToken = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// ------------------------------------------------------------ token details
const META_KEY = 'tronTokenMeta';
let metaCache = null; // `${chainId}:${address}` -> { symbol, name, decimals }
async function metaStore() { metaCache ||= await local.get(META_KEY, {}).catch(() => ({})); return metaCache; }
const remember = (all) => local.set(META_KEY, Object.fromEntries(Object.entries(all).slice(-500))).catch(() => {});

/** A TRC-20 contract's symbol, name and decimals, read on chain (cached). null when it isn't a token. */
export async function trc20Meta(chain, address, { cacheOnly = false } = {}) {
  const known = popularMap(chain).get(address);
  if (known) return known;
  const store = await metaStore();
  const k = `${chain.id}:${address}`;
  if (store[k]) return store[k];
  if (cacheOnly) return null;
  const decimals = await trc20Read(chain, address, 'decimals');
  if (decimals == null) return null;
  const [symbol, name] = await Promise.all([trc20Read(chain, address, 'symbol').catch(() => null), trc20Read(chain, address, 'name').catch(() => null)]);
  const m = { symbol: String(symbol || shortToken(address)).slice(0, 32), name: String(name || '').slice(0, 64), decimals: Number(decimals) };
  store[k] = m; remember(store);
  return m;
}
/**
 * Details of many TRC-20 tokens: cached ones, then TronGrid's token list in one request per 20 tokens. -> Map address
 * -> { symbol, name, decimals } (tokens it doesn't know are left out).
 */
export async function trc20Metas(chain, addrs) {
  const store = await metaStore();
  const popular = popularMap(chain);
  const out = new Map();
  const missing = [];
  for (const a of addrs) {
    const m = popular.get(a) || store[`${chain.id}:${a}`];
    if (m) out.set(a, m); else missing.push(a);
  }
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const j = await tronApi(chain, `/v1/trc20/info?contract_list=${chunk.join(',')}`).catch(() => null);
    for (const x of j?.data || []) {
      if (x.decimals == null || !chunk.includes(x.contract_address)) continue;
      const m = { symbol: String(x.symbol || shortToken(x.contract_address)).slice(0, 32), name: String(x.name || '').slice(0, 64), decimals: Number(x.decimals) };
      store[`${chain.id}:${x.contract_address}`] = m;
      out.set(x.contract_address, m);
    }
    if (!j) break; // TronGrid busy: the rest next time
  }
  if (missing.length) remember(store);
  return out;
}

/** Learns token details seen elsewhere (TronGrid's history gives them with each transfer). */
export async function learnMeta(chain, list) {
  const store = await metaStore();
  let added = false;
  for (const x of list) {
    const k = `${chain.id}:${x.address}`;
    if (!store[k] && x.symbol != null && x.decimals != null) { store[k] = { symbol: x.symbol, name: x.name || '', decimals: Number(x.decimals) }; added = true; }
  }
  if (added) remember(store);
}

/** TRC-10 details (/wallet/getassetissuebyid), cached. */
async function trc10Meta(chain, id, { cacheOnly = false } = {}) {
  const store = await metaStore();
  const k = `${chain.id}:trc10:${id}`;
  if (store[k] || cacheOnly) return store[k] || null;
  const j = await tronApi(chain, '/wallet/getassetissuebyid', { value: String(id) }).catch(() => null);
  if (!j?.id) return null;
  const m = { symbol: String(j.abbr || j.name || id).slice(0, 32), name: String(j.name || '').slice(0, 64), decimals: Number(j.precision || 0) };
  store[k] = m; remember(store);
  return m;
}

// ------------------------------------------------------------ spam
const LOOKALIKE = /^(USDT|USDC|USDD|TRX|WTRX|TUSD|BTC|ETH)$/i;
/** A TRC-20 that is surely not what it says: a link in its name, or the symbol of a well-known token at another address. */
export function spamTrc20(chain, t) {
  if (popularMap(chain).has(t.address)) return false;
  if (isSpamToken({ symbol: t.symbol, name: t.name }, null)) return true;
  return LOOKALIKE.test(String(t.symbol || '').replace(/[^a-z]/gi, ''));
}

// ------------------------------------------------------------ portfolio
const num = (raw, decimals) => Number(BigInt(raw || 0)) / 10 ** decimals;

/** TRX locked in Stake 2.0 (sun): staked for energy / bandwidth (also what is delegated to others) and being unstaked. */
export function stakeOf(acc) {
  let energy = 0n, bandwidth = 0n, power = 0n;
  for (const f of acc?.frozenV2 || []) {
    const a = BigInt(f.amount || 0);
    if (f.type === 'ENERGY') energy += a; else if (f.type === 'TRON_POWER') power += a; else bandwidth += a;
  }
  energy += BigInt(acc?.account_resource?.delegated_frozenV2_balance_for_energy || 0);
  bandwidth += BigInt(acc?.delegated_frozenV2_balance_for_bandwidth || 0);
  const unstaking = (acc?.unfrozenV2 || []).map((u) => ({ amount: BigInt(u.unfreeze_amount || 0), type: u.type || 'BANDWIDTH', at: Number(u.unfreeze_expire_time || 0) }));
  return { energy, bandwidth, power, unstaking, unstakingTotal: unstaking.reduce((s, u) => s + u.amount, 0n) };
}

/** The account: TronGrid's view (with the TRC-20 balances), else the node's (the tokens are then read one by one). */
async function accountView(chain, owner) {
  try { return { acc: await getV1Account(chain, owner), indexed: true }; }
  catch (e) {
    const acc = await getAccount(chain, owner).catch(() => { throw e; });
    return { acc: acc && Object.keys(acc).length ? acc : null, indexed: false };
  }
}

/**
 * The portfolio of a Tron address. opts: { hiddenTokens, customTokens } (custom: { address, symbol, name, decimals,
 * icon, trc10? }). Extra field `tron`: { activated, staked: { energy, bandwidth } (sun strings), unstaking (sun) }.
 */
export async function loadTronPortfolio(chain, owner, { hiddenTokens = [], customTokens = [] } = {}) {
  const { acc, indexed } = await accountView(chain, owner);
  const popular = popularMap(chain);
  const custom = new Map(customTokens.map((c) => [c.address, c]));
  // raw balances: TRC-20 from TronGrid ([{ address: raw }]); without it, the well-known and custom tokens one by one
  const held = new Map();
  for (const x of acc?.trc20 || []) for (const [a, v] of Object.entries(x)) held.set(a, String(v));
  if (!indexed || !acc) {
    const ask = [...new Set([...popular.keys(), ...[...custom.values()].filter((c) => !c.trc10).map((c) => c.address)])];
    const got = await Promise.all(ask.map((a) => trc20Read(chain, a, 'balanceOf', [owner], owner).catch(() => null)));
    ask.forEach((a, i) => { if (got[i] != null && got[i] > 0n) held.set(a, got[i].toString()); });
  }
  const trc10 = new Map((acc?.assetV2 || []).filter((x) => Number(x.value) > 0).map((x) => [String(x.key), String(x.value)]));
  for (const c of custom.values()) if (c.trc10 && !trc10.has(c.address)) trc10.set(c.address, '0');

  const addrs = [...new Set([...held.keys(), ...[...custom.values()].filter((c) => !c.trc10).map((c) => c.address)])].filter(isAddress);
  const keys = ['coingecko:tron', ...(chain.testnet ? [] : addrs.map(llamaKey))];
  const prices = await getPrices(keys).catch(() => ({}));
  const trxPrice = chain.testnet ? null : prices['coingecko:tron'] ?? null;
  // details: the well-known and custom tokens, the cache, then TronGrid's token list (one request for 20 tokens); a
  // token with a market price TronGrid doesn't list is read on the contract itself
  const metas = await trc20Metas(chain, addrs.filter((a) => !custom.has(a)));
  for (const [a, c] of custom) if (!c.trc10) metas.set(a, metas.get(a) || c);
  for (const a of addrs.filter((x) => !metas.has(x) && prices[llamaKey(x)] != null).slice(0, 4)) { const m = await trc20Meta(chain, a).catch(() => null); if (m) metas.set(a, m); }

  const hidden = new Set(hiddenTokens);
  const rows = [];
  for (const a of addrs) {
    const m = metas.get(a), c = custom.get(a), p = popular.get(a);
    const decimals = m?.decimals ?? c?.decimals ?? 0;
    const balance = held.get(a) || '0';
    const price = chain.testnet ? null : prices[llamaKey(a)] ?? null;
    const amount = num(balance, decimals);
    const t = {
      address: a, symbol: m?.symbol || c?.symbol || shortToken(a), name: m?.name || c?.name || '', decimals, balance, amount,
      price: typeof price === 'number' ? price : null, usd: typeof price === 'number' ? amount * price : null,
      icon: p?.icon || c?.icon || '', known: !!p, priceKey: chain.testnet ? null : llamaKey(a), ...(c ? { custom: true } : {}),
    };
    if (!c && spamTrc20(chain, t)) continue; // a fake: not even among the hidden ones
    if (!c && !p && (t.price == null || !m)) t.junk = true; // unknown and without a market price: apart, shown on request
    if (balance === '0' && !c) continue;
    rows.push(t);
  }
  for (const [id, balance] of trc10) {
    const c = custom.get(id);
    // TRC-10: details only for the ones the user added (the rest are airdrops: their id is enough)
    const m = c || (await trc10Meta(chain, id, { cacheOnly: true }));
    const decimals = m?.decimals ?? 0;
    rows.push({
      address: id, symbol: m?.symbol || `#${id}`, name: m?.name || 'TRC-10', decimals, balance, amount: num(balance, decimals),
      price: null, usd: null, icon: c?.icon || '', known: false, trc10: true, priceKey: null, ...(c ? { custom: true } : { junk: true }),
    });
  }
  rows.sort((a, b) => (b.usd || 0) - (a.usd || 0) || Number(b.known) - Number(a.known) || a.symbol.localeCompare(b.symbol));
  const away = (x) => hidden.has(x.address) || x.junk;
  const tokens = rows.filter((x) => !away(x));

  const sun = BigInt(acc?.balance || 0);
  const stake = stakeOf(acc);
  const locked = stake.energy + stake.bandwidth + stake.power + stake.unstakingTotal; // still the user's TRX
  const amount = num(sun, 6);
  const nativeUsd = trxPrice != null ? amount * trxPrice : null;
  const lockedUsd = trxPrice != null ? num(locked, 6) * trxPrice : 0;
  return {
    native: { balance: sun.toString(), amount, price: trxPrice, usd: nativeUsd, staked: locked.toString() },
    tokens,
    hidden: rows.filter(away).map((x) => ({ ...x, hidden: true })),
    totalUsd: (nativeUsd || 0) + lockedUsd + tokens.reduce((s, x) => s + (x.usd || 0), 0),
    tron: {
      activated: !!acc, staked: { energy: stake.energy.toString(), bandwidth: stake.bandwidth.toString() },
      unstaking: stake.unstakingTotal.toString(), indexed,
    },
    indexerOk: true, indexerError: '', noIndexer: false, updated: Date.now(),
  };
}

/** A token typed by the user (TRC-20 contract, or a TRC-10 id) as a custom token; null when it isn't one. */
export async function tronTokenInfo(chain, text) {
  const s = String(text || '').trim();
  if (/^\d{7}$/.test(s)) {
    const m = await trc10Meta(chain, s);
    return m ? { address: s, ...m, icon: '', trc10: true, known: false } : null;
  }
  if (!isAddress(s)) return null;
  const m = await trc20Meta(chain, s).catch((e) => { if (e instanceof TronError && e.limited) throw e; return null; });
  if (!m) return null;
  const p = popularMap(chain).get(s);
  return { address: s, symbol: m.symbol, name: m.name, decimals: m.decimals, icon: p?.icon || '', known: !!p, scam: !p && spamTrc20(chain, { address: s, ...m }) };
}
