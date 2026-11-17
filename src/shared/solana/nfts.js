// Solana NFTs read from the network alone (no Helius or Alchemy key): the classic ones (a Metaplex metadata account
// on a token with one unit), Token-2022 ones (their metadata inside the mint) and Metaplex Core assets (found by
// owner on the public node). Compressed NFTs live in a tree only an indexer (DAS) reads: with a key they show too.
// Images come from each NFT's JSON (its uri), fetched only for the NFTs that don't look like spam.
import { rpc, multipleAccounts } from './api.js';
import { tokenAccounts, onchainMints, metaplexAddress, parseMetaplex } from './tokens.js';
import { PROGRAMS } from './tx.js';
import { CORE, readCore } from './templates.js';
import { addressOf } from './core.js';
import * as b58 from './base58.js';
import { mediaUrl, spamNft, traitsOf } from '../nftMeta.js';

const MAX = 200; // NFTs read per wallet
const MAX_JSON = 120; // JSON documents fetched (the images)

/** A Metaplex metadata account read to its collection: { name, symbol, uri, collection: { key, verified } | null }. */
export function metaplexFull(data) {
  const head = parseMetaplex(data);
  if (!head) return null;
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.length);
    let o = 1 + 32 + 32;
    for (let i = 0; i < 3; i++) o += 4 + dv.getUint32(o, true); // name, symbol, uri (padded on chain)
    o += 2; // seller fee
    if (data[o++]) o += 4 + dv.getUint32(o, true) * 34; // creators
    o += 2; // primary sale, mutable
    if (data[o++]) o += 1; // edition nonce
    if (data[o++]) o += 1; // token standard
    const collection = data[o] ? { verified: !!data[o + 1], key: addressOf(data.slice(o + 2, o + 34)) } : null;
    return { ...head, collection };
  } catch { return { ...head, collection: null }; }
}

async function json(uri) {
  const url = mediaUrl(uri);
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** The wallet's NFTs in the shared shape (src/shared/nft.js), without an indexer. */
export async function keylessNfts(chain, owner) {
  const accs = await tokenAccounts(chain, owner).catch(() => []);
  const ones = accs.filter((a) => a.decimals === 0 && a.amount === '1').slice(0, MAX);
  const classic = ones.filter((a) => a.program === PROGRAMS.token), t22 = ones.filter((a) => a.program === PROGRAMS.token2022);
  const [metas, t22data, coreAccs] = await Promise.all([
    classic.length ? multipleAccounts(chain, classic.map((a) => metaplexAddress(a.mint))).catch(() => []) : [],
    t22.length ? onchainMints(chain, t22.map((a) => a.mint)).catch(() => []) : [],
    // Core assets: AssetV1 accounts (first byte 1) whose owner (bytes 1-33) is the wallet
    rpc(chain, 'getProgramAccounts', [CORE, { encoding: 'base64', filters: [{ memcmp: { offset: 0, bytes: b58.encode(Uint8Array.of(1)) } }, { memcmp: { offset: 1, bytes: owner } }] }], { timeout: 30000 })
      .catch(() => []),
  ]);
  const items = [];
  classic.forEach((a, i) => {
    const m = metas[i] ? metaplexFull(metas[i].data) : null;
    if (m) items.push({ key: a.mint, address: a.mint, name: m.name, symbol: m.symbol, uri: m.uri, collectionKey: m.collection?.verified ? m.collection.key : null, standard: 'Metaplex' });
  });
  t22.forEach((a, i) => {
    const m = t22data[i];
    if (m?.name) items.push({ key: a.mint, address: a.mint, name: m.name, symbol: m.symbol, uri: m.uri, collectionKey: null, standard: 'Token-2022' });
  });
  for (const x of coreAccs.slice(0, MAX)) {
    const c = readCore(Uint8Array.from(atob(x.account.data[0]), (ch) => ch.charCodeAt(0)));
    if (c?.kind === 'asset') items.push({ key: x.pubkey, address: x.pubkey, name: c.name, symbol: '', uri: c.uri, collectionKey: c.collection, standard: 'Metaplex Core' });
  }
  // collections' names: the Metaplex metadata of a collection NFT, or a Core collection account
  const keys = [...new Set(items.map((x) => x.collectionKey).filter(Boolean))];
  const names = new Map();
  if (keys.length) {
    const core = items.some((x) => x.standard === 'Metaplex Core' && x.collectionKey);
    const [asMeta, asCore] = await Promise.all([
      multipleAccounts(chain, keys.map(metaplexAddress)).catch(() => []),
      core ? multipleAccounts(chain, keys).catch(() => []) : [],
    ]);
    keys.forEach((k, i) => {
      const n = (asMeta[i] && parseMetaplex(asMeta[i].data)?.name) || (asCore[i] && readCore(asCore[i].data)?.name) || '';
      if (n) names.set(k, n);
    });
  }
  const out = items.map((x) => {
    const collection = (x.collectionKey && names.get(x.collectionKey)) || '';
    // spam: a lure in the name, or an NFT outside any verified collection (the usual shape of airdropped ads)
    const spam = spamNft(x.name, collection, { symbol: x.symbol }) || !x.collectionKey;
    return {
      key: x.key, address: x.address, contract: x.collectionKey || x.address, tokenId: x.address, name: x.name || collection || 'NFT', collection,
      image: null, description: '', traits: [], standard: x.standard, amount: '1', spam, _uri: x.uri,
    };
  });
  // images and descriptions from the JSON of the NFTs that look real
  const todo = out.filter((x) => !x.spam && x._uri).slice(0, MAX_JSON);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < todo.length) {
      const x = todo[next++];
      const j = await json(x._uri);
      if (!j) continue;
      x.image = mediaUrl(j.image) || mediaUrl(j.properties?.files?.find((f) => /^image\//.test(f?.type || ''))?.uri) || null;
      x.description = typeof j.description === 'string' ? j.description : '';
      x.traits = traitsOf(j.attributes);
      if (x.description && spamNft(x.name, x.collection, { description: x.description })) x.spam = true;
    }
  }));
  return out.map(({ _uri, ...x }) => x);
}
