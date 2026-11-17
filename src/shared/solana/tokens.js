// Solana tokens (SPL Token and Token-2022): the token accounts of a wallet, names / symbols / icons, prices, and the
// wallet's balances in the shape the shared screens use (src/ui/chains/driver.d.md).
// Names and icons: Jupiter's token list (mainnet; also tells verified tokens and suspicious ones), else the token's own
// metadata on chain (Token-2022's metadata extension, Metaplex's metadata account). Prices: DefiLlama
// ("solana:<mint>", as everywhere in the app), else Jupiter's price for verified tokens.
import { rpc, multipleAccounts, multipleParsed, solBalance } from './api.js';
import { PROGRAMS, WSOL, ataAddress } from './tx.js';
import { findProgramAddress, addressBytes, utf8, isAddress } from './core.js';
import { getPrices } from '../prices.js';
import { isSpamToken } from '../portfolio.js';
import { ENDPOINTS } from '../endpoints.js';
import { jupFetch } from './jupiter.js';

export const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const shortMint = (m) => `${m.slice(0, 4)}…${m.slice(-4)}`;
export const llamaKey = (mint) => `solana:${mint}`;

/** Well-known tokens: offered by Swap, watched for notifications. [mint, symbol, decimals] */
export const POPULAR_SPL = [
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 6],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT', 6],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP', 6],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'Bonk', 5],
  ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'JitoSOL', 9],
  ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'mSOL', 9],
  ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'RAY', 6],
  ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF', 6],
  ['HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 'PYTH', 6],
];

// ------------------------------------------------------------ token accounts
/**
 * A wallet's token accounts (both token programs): [{ account, mint, amount (raw, string), decimals, program, frozen }].
 */
export async function tokenAccounts(chain, owner) {
  const lists = await Promise.all([PROGRAMS.token, PROGRAMS.token2022].map((programId, i) => rpc(chain, 'getTokenAccountsByOwner', [
    owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' },
  ], { start: i }).then((r) => r.value.map((x) => ({ account: x.pubkey, program: programId, info: x.account?.data?.parsed?.info })))));
  return lists.flat().filter((x) => x.info?.mint && x.info.tokenAmount).map((x) => ({
    account: x.account, program: x.program, mint: x.info.mint, amount: String(x.info.tokenAmount.amount),
    decimals: Number(x.info.tokenAmount.decimals), frozen: x.info.state === 'frozen',
  }));
}

/**
 * One line per mint: the amounts of all its accounts summed; `parts`: its accounts with a balance, the largest first
 * (sends take from them in this order); `account` = the first of them, else the associated account.
 */
export function holdings(owner, accounts) {
  const by = new Map();
  for (const a of accounts) {
    const h = by.get(a.mint) || { mint: a.mint, amount: 0n, decimals: a.decimals, program: a.program, account: null, accounts: [], parts: [], frozen: false };
    h.amount += BigInt(a.amount);
    h.accounts.push(a.account);
    if (BigInt(a.amount) > 0n && !a.frozen) h.parts.push({ account: a.account, amount: a.amount });
    h.frozen ||= a.frozen;
    by.set(a.mint, h);
  }
  for (const h of by.values()) {
    const ata = ataAddress(owner, h.mint, h.program);
    h.parts.sort((x, y) => (BigInt(y.amount) > BigInt(x.amount) ? 1 : BigInt(y.amount) < BigInt(x.amount) ? -1 : x.account === ata ? -1 : 1));
    h.account = h.parts[0]?.account || (h.accounts.includes(ata) ? ata : h.accounts[0]);
  }
  return [...by.values()];
}

// ------------------------------------------------------------ names, symbols, icons
const metaCache = new Map(); // `${chainId}:${mint}` -> meta
const unlisted = new Map(); // `${chainId}:${mint}` -> when Jupiter answered without it
const META_TTL = 60 * 60e3;

/**
 * Jupiter's data of mints, 100 per request: { list: [{ id, name, symbol, icon, decimals, usdPrice, isVerified, tags,
 * organicScoreLabel, liquidity, audit, tokenProgram }], asked: Set of the mints whose request was answered }.
 */
async function jupiterTokens(mints) {
  const list = [], asked = new Set();
  for (let i = 0; i < mints.length; i += 100) {
    const part = mints.slice(i, i + 100);
    try {
      const res = await jupFetch(`/tokens/v2/search?query=${part.join(',')}`);
      if (!res.ok) continue;
      list.push(...(await res.json()));
      for (const m of part) asked.add(m);
    } catch { /* this part stays unknown: asked again next time */ }
  }
  return { list, asked };
}

/** Metaplex's metadata account -> { name, symbol, uri } (the strings are padded with zero bytes on chain). */
export function parseMetaplex(data) {
  try {
    let o = 1 + 32 + 32;
    const str = () => {
      const n = new DataView(data.buffer, data.byteOffset + o, 4).getUint32(0, true);
      o += 4;
      if (n > 1000 || o + n > data.length) throw new Error('bad');
      const s = new TextDecoder().decode(data.slice(o, o + n)).replace(/\0+$/, '').trim();
      o += n;
      return s;
    };
    return { name: str(), symbol: str(), uri: str() };
  } catch { return null; }
}
export const metaplexAddress = (mint) => findProgramAddress([utf8('metadata'), addressBytes(METAPLEX), addressBytes(mint)], METAPLEX)[0];

/**
 * A mint's data on chain: { decimals, program, name, symbol, uri, mintAuthority, freezeAuthority, supply } or null
 * when the address isn't a mint.
 */
export async function onchainMints(chain, mints) {
  const parsed = await multipleParsed(chain, mints);
  const out = mints.map((mint, i) => {
    const v = parsed[i];
    const info = v?.data?.parsed?.type === 'mint' ? v.data.parsed.info : null;
    if (!info || (v.owner !== PROGRAMS.token && v.owner !== PROGRAMS.token2022)) return null;
    const md = (info.extensions || []).find((e) => e.extension === 'tokenMetadata')?.state;
    return {
      decimals: Number(info.decimals), program: v.owner, supply: String(info.supply ?? '0'),
      mintAuthority: info.mintAuthority || null, freezeAuthority: info.freezeAuthority || null,
      name: md?.name?.trim() || '', symbol: md?.symbol?.trim() || '', uri: md?.uri || '',
      extensions: (info.extensions || []).map((e) => e.extension),
    };
  });
  const need = mints.map((m, i) => (out[i] && !out[i].symbol ? i : -1)).filter((i) => i >= 0);
  if (need.length) {
    const accs = await multipleAccounts(chain, need.map((i) => metaplexAddress(mints[i]))).catch(() => []);
    need.forEach((i, j) => {
      const m = accs[j] ? parseMetaplex(accs[j].data) : null;
      if (m) Object.assign(out[i], { name: m.name, symbol: m.symbol, uri: m.uri });
    });
  }
  return out;
}

/**
 * Names and icons of mints: Map mint -> { symbol, name, decimals, icon, known (verified by Jupiter), spam (flagged
 * suspicious), duplicate (a copy of a known token, for Jupiter), listed (in Jupiter's list), organic (Jupiter's
 * "organic score" label: low / medium / high), liquidity (USD), jupPrice, program }. Cached in memory for an hour.
 * The map's `unlisted` set: mints Jupiter was asked about and doesn't know (not set when Jupiter couldn't be asked).
 */
export async function tokenMetas(chain, mints, { onchain = true } = {}) {
  const now = Date.now();
  const key = (m) => `${chain.id}:${m}`;
  const todo = [...new Set(mints)].filter((m) => { const c = metaCache.get(key(m)); return !c || now - c.t > META_TTL; });
  if (todo.length) {
    if (!chain.testnet && ENDPOINTS.jupiter) {
      const { list, asked } = await jupiterTokens(todo);
      {
        const seen = new Set();
        for (const j of list) {
          if (!todo.includes(j.id)) continue;
          seen.add(j.id);
          metaCache.set(key(j.id), {
            t: now, symbol: j.symbol || shortMint(j.id), name: j.name || '', decimals: j.decimals, icon: j.icon || '',
            known: !!j.isVerified, spam: !!j.audit?.isSus, duplicate: (j.tags || []).includes('duplicate'), listed: true,
            organic: j.organicScoreLabel || null, liquidity: j.liquidity ?? null, jupPrice: j.usdPrice ?? null, program: j.tokenProgram || null,
          });
        }
        for (const m of asked) if (!seen.has(m)) unlisted.set(key(m), now);
      }
    }
    const rest = onchain ? todo.filter((m) => !metaCache.has(key(m)) || metaCache.get(key(m)).t !== now) : [];
    if (rest.length) {
      const chainData = await onchainMints(chain, rest).catch(() => rest.map(() => null));
      rest.forEach((m, i) => {
        const c = chainData[i];
        if (c) metaCache.set(key(m), { t: now, symbol: c.symbol || shortMint(m), name: c.name || '', decimals: c.decimals, icon: '', known: false, spam: false, listed: false, jupPrice: null, program: c.program, uri: c.uri });
      });
    }
  }
  const out = new Map(mints.map((m) => [m, metaCache.get(key(m)) || null]));
  out.unlisted = new Set(mints.filter((m) => now - (unlisted.get(key(m)) ?? -Infinity) <= META_TTL && !metaCache.get(key(m))?.listed));
  return out;
}
/** The image of a token's metadata (its uri points to a JSON with `image`): for tokens the user adds by hand. */
export async function uriImage(uri) {
  if (!/^https:\/\//i.test(uri || '')) return '';
  try {
    const r = await fetch(uri, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return typeof j.image === 'string' && /^(https|ipfs|ar):/i.test(j.image) ? j.image : '';
  } catch { return ''; }
}

/** Symbols fakes imitate: such a token at another mint than the real one is a fake. */
const IMITATED = new Set(['USDC', 'USDT', 'SOL', 'WSOL', 'JUP', 'BONK', 'JITOSOL', 'MSOL', 'PYUSD', 'USDS', 'ETH', 'BTC', 'WBTC']);
const REAL = new Set([...POPULAR_SPL.map(([m]) => m), WSOL, '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' /* PYUSD */]);
/** A token that is spam: flagged by Jupiter (suspicious, or a copy), a lure in its name, or a well-known symbol at the wrong mint. */
export function spamSplToken(mint, meta) {
  if (!meta) return false;
  if (meta.spam || meta.duplicate || isSpamToken({ symbol: meta.symbol, name: meta.name })) return true;
  return !meta.known && IMITATED.has(String(meta.symbol || '').toUpperCase().replace(/[^A-Z]/g, '')) && !REAL.has(mint);
}

// ------------------------------------------------------------ prices
/**
 * Probable junk (mainnet, a token not added by hand): not verified by Jupiter and either with a "low" organic score
 * and almost no liquidity (the usual airdropped memecoin), or unknown to Jupiter and without any price. Out of the
 * list and of the total, among the hidden tokens (shown again on request).
 */
export const JUNK_LIQUIDITY = 1000;
export function junkSplToken(meta, { unlisted = false, price = null } = {}) {
  if (meta?.known) return false;
  if (meta?.listed) return meta.organic === 'low' && (meta.liquidity ?? 0) < JUNK_LIQUIDITY;
  return unlisted && price == null;
}

/** Tokens of a wallet asked to Jupiter for names and checks (the most valuable first). */
export const JUPITER_CAP = 500;

/** USD prices: { [mint]: price | null } (DefiLlama, else Jupiter's for verified tokens) and the SOL price. */
export async function tokenPrices(chain, mints, metas) {
  if (chain.testnet) return { sol: null, prices: {} };
  const keys = [chain.native.priceId, ...mints.map(llamaKey)];
  const p = await getPrices(keys).catch(() => ({}));
  const prices = {};
  for (const m of mints) {
    const meta = metas?.get(m);
    prices[m] = p[llamaKey(m)] ?? (meta?.known ? meta.jupPrice : null) ?? null;
  }
  return { sol: p[chain.native.priceId] ?? null, prices };
}

// ------------------------------------------------------------ the wallet's balances
/**
 * A Solana wallet's balances as a shared portfolio: { native, tokens, hidden, totalUsd, updated, … }, numbers and
 * strings only (cached on the device). Tokens: { address (mint), symbol, name, decimals, balance, amount, price, usd,
 * icon, account (the token account to send from), program, known, priceKey }. NFTs (one unit, no decimals) and
 * tokens flagged as suspicious stay out, unless added by hand.
 */
export async function loadSolPortfolio(chain, owner, { hiddenTokens = [], customTokens = [] } = {}) {
  const [lamports, accounts] = await Promise.all([solBalance(chain, owner), tokenAccounts(chain, owner)]);
  const held = holdings(owner, accounts);
  const custom = new Map(customTokens.map((c) => [c.address, c]));
  const mints = [...new Set([...held.map((h) => h.mint), ...custom.keys()])];
  // prices first (DefiLlama), then names from Jupiter's list for the tokens that matter most (added by hand, then by
  // value): its free API answers 5 requests every 10 s, and wallets that received hundreds of airdrops would wait for
  // minutes. Tokens Jupiter doesn't know are read on chain, again only the most valuable ones.
  const { sol: solPrice, prices } = await tokenPrices(chain, mints, null);
  const amountOf = (m) => { const h = held.find((x) => x.mint === m); return h ? Number(h.amount) / 10 ** h.decimals : 0; };
  const byValue = [...mints].sort((a, b) => Number(custom.has(b)) - Number(custom.has(a)) || amountOf(b) * (prices[b] || 0) - amountOf(a) * (prices[a] || 0));
  const asked = byValue.slice(0, JUPITER_CAP);
  const beyond = new Set(byValue.slice(JUPITER_CAP)); // not asked to Jupiter: judged by their price alone
  let metas = await tokenMetas(chain, asked, { onchain: false }).catch(() => new Map());
  const unlistedSet = metas.unlisted || new Set();
  for (const m of mints) if (prices[m] == null && metas.get(m)?.known) prices[m] = metas.get(m).jupPrice ?? null; // Jupiter's price for verified tokens
  const unnamed = asked.filter((m) => !metas.get(m));
  if (unnamed.length) {
    const pick = [...unnamed.filter((m) => custom.has(m)), ...unnamed.filter((m) => !custom.has(m)).sort((a, b) => amountOf(b) * (prices[b] || 0) - amountOf(a) * (prices[a] || 0)).slice(0, 40)];
    const more = await tokenMetas(chain, pick).catch(() => new Map());
    metas = new Map([...metas, ...[...more].filter(([, v]) => v)]);
  }
  const hidden = new Set(hiddenTokens);
  const row = (mint, h) => {
    const m = metas.get(mint), c = custom.get(mint);
    const decimals = h?.decimals ?? m?.decimals ?? c?.decimals ?? 0;
    const balance = (h?.amount ?? 0n).toString();
    const amount = Number(balance) / 10 ** decimals;
    const price = prices[mint] ?? null;
    return {
      address: mint, symbol: m?.symbol || c?.symbol || shortMint(mint), name: m?.name || c?.name || '', decimals, balance, amount, price,
      usd: price != null ? amount * price : null, icon: m?.icon || c?.icon || '', account: h?.account || null, program: h?.program || m?.program || c?.program || PROGRAMS.token,
      ...(h?.parts.length > 1 ? { parts: h.parts } : {}), // spread over several token accounts: sends take from each
      known: mint === WSOL || !!m?.known, priceKey: chain.testnet ? null : llamaKey(mint), ...(h?.frozen ? { frozen: true } : {}), ...(c ? { custom: true } : {}),
      _spam: spamSplToken(mint, m), _nft: decimals === 0 && balance === '1' && !m?.known,
      ...(!c && !chain.testnet && junkSplToken(m, { unlisted: unlistedSet.has(mint) || (beyond.has(mint) && !m), price }) ? { junk: true } : {}),
    };
  };
  const rows = mints.map((mint) => row(mint, held.find((h) => h.mint === mint)))
    .filter((x) => x.custom || (!x._spam && !x._nft && x.balance !== '0'))
    .map(({ _spam, _nft, ...x }) => x)
    .sort((a, b) => (b.usd || 0) - (a.usd || 0) || Number(b.known) - Number(a.known) || a.symbol.localeCompare(b.symbol));
  const away = (x) => hidden.has(x.address) || x.junk; // hidden by the user, or probable junk
  const tokens = rows.filter((x) => !away(x));
  const amount = Number(lamports) / 1e9;
  const nativeUsd = solPrice != null ? amount * solPrice : null;
  // empty token accounts: each holds its rent (about 0.002 SOL), which closing it gives back
  const empty = accounts.filter((a) => a.amount === '0' && !a.frozen).map((a) => ({ account: a.account, program: a.program }));
  return {
    native: { balance: lamports.toString(), amount, price: solPrice, usd: nativeUsd },
    tokens,
    hidden: rows.filter(away).map((x) => ({ ...x, hidden: true })),
    totalUsd: (nativeUsd || 0) + tokens.reduce((s, x) => s + (x.usd || 0), 0),
    emptyAccounts: empty.length, empty: empty.slice(0, 200),
    indexerOk: true, indexerError: '', noIndexer: false, updated: Date.now(),
  };
}

/** A mint typed by the user, as a custom token: { address, symbol, name, decimals, icon, program, known, scam } or null. */
export async function mintInfo(chain, mint) {
  if (!isAddress(mint)) return null;
  const [c] = await onchainMints(chain, [mint]);
  if (!c) return null;
  const m = (await tokenMetas(chain, [mint]).catch(() => new Map())).get(mint);
  const icon = m?.icon || (await uriImage(c.uri));
  return {
    address: mint, symbol: m?.symbol || c.symbol || shortMint(mint), name: m?.name || c.name || '', decimals: c.decimals, icon,
    program: c.program, known: !!m?.known, scam: !!m?.spam,
  };
}
