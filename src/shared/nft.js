// NFTs held by an address, shown under the tokens on the home screen (view only). EVM here; TON in ton/api.js.
//  - Blockscout networks: the indexer lists them with their metadata (name, image, collection).
//  - Etherscan-compatible indexers: holdings from the NFT transfers (ERC-721 and ERC-1155), metadata read on-chain
//    (tokenURI / uri) for the first ones.
// Item: { key, contract, tokenId, name, collection, image, description, traits: [{ trait, value }], standard, amount, spam }.
// Spam (airdropped "claim your reward" NFTs, often used to track who opens them): flagged here, hidden by the home
// screen, and their images are never loaded.
import { Interface } from 'ethers';
import { rpc } from './rpc.js';
import { etherscanUrl } from './portfolio.js';
import { getJson as httpJson } from './http.js';
import { mediaUrl, spamNft, fakeBrand, traitsOf } from './nftMeta.js';

const getJson = (url, timeout = 20000) => httpJson(url, { timeout, label: 'NFT HTTP' });
const META_ON_CHAIN = 24; // Etherscan-compatible networks: metadata read for the first N items
const MAX_ITEMS = 200;
const nftIface = new Interface(['function tokenURI(uint256) view returns (string)', 'function uri(uint256) view returns (string)']);

export { mediaUrl, spamNft, fakeBrand, hasDomain, traitsOf } from './nftMeta.js';

/** Blockscout /api/v2/addresses/:a/nft items -> items. */
export function fromBlockscout(list) {
  return (list || []).map((x) => {
    const tk = x.token || {};
    const contract = String(tk.address_hash || tk.address || '').toLowerCase();
    const name = x.metadata?.name || (tk.name ? `${tk.name} #${x.id}` : `#${x.id}`);
    const rep = String(tk.reputation || '').toLowerCase();
    return {
      key: `${contract}:${x.id}`, contract, tokenId: String(x.id), name, collection: tk.name || tk.symbol || '',
      image: mediaUrl(x.image_url || x.metadata?.image), description: x.metadata?.description || '', traits: traitsOf(x.metadata?.attributes),
      standard: x.token_type || tk.type || 'ERC-721', amount: String(x.value ?? '1'),
      spam: rep === 'scam' || rep === 'spam' || spamNft(x.metadata?.name, tk.name, { symbol: tk.symbol, description: x.metadata?.description }) || fakeBrand(tk.name, tk.holders_count ?? tk.holders ?? null),
    };
  });
}

/**
 * Etherscan-compatible tokennfttx / token1155tx results -> what the address still holds:
 * [{ contract, tokenId, collection, standard, amount }] (newest transfer first).
 */
export function holdingsFromTransfers(address, erc721 = [], erc1155 = []) {
  const me = String(address).toLowerCase();
  const map = new Map();
  const add = (x, standard, delta) => {
    const contract = String(x.contractAddress).toLowerCase(), tokenId = String(x.tokenID ?? x.tokenId);
    const k = `${contract}:${tokenId}`;
    const cur = map.get(k) || { contract, tokenId, collection: x.tokenName || x.tokenSymbol || '', symbol: x.tokenSymbol || '', standard, amount: 0n, time: 0 };
    cur.amount += delta;
    cur.time = Math.max(cur.time, Number(x.timeStamp || 0));
    map.set(k, cur);
  };
  // oldest first, so the balance adds up in order
  const sorted = (l) => [...l].sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
  for (const x of sorted(erc721)) {
    if (String(x.to).toLowerCase() === me) add(x, 'ERC-721', 1n);
    if (String(x.from).toLowerCase() === me) add(x, 'ERC-721', -1n);
  }
  for (const x of sorted(erc1155)) {
    const v = BigInt(x.tokenValue || x.value || 1);
    if (String(x.to).toLowerCase() === me) add(x, 'ERC-1155', v);
    if (String(x.from).toLowerCase() === me) add(x, 'ERC-1155', -v);
  }
  return [...map.values()].filter((h) => h.amount > 0n).sort((a, b) => b.time - a.time)
    .map(({ time, amount, ...h }) => ({ ...h, amount: amount.toString() }));
}

/** Metadata of one EVM NFT, read on-chain (tokenURI / uri) and fetched: { name, image, description } | null. */
async function onChainMeta(chain, h) {
  try {
    const fn = h.standard === 'ERC-1155' ? 'uri' : 'tokenURI';
    const out = await rpc(chain, 'eth_call', [{ to: h.contract, data: nftIface.encodeFunctionData(fn, [BigInt(h.tokenId)]) }, 'latest']);
    let uri = nftIface.decodeFunctionResult(fn, out)[0];
    // ERC-1155: {id} = the id in hex, 64 characters
    if (fn === 'uri') uri = uri.replace('{id}', BigInt(h.tokenId).toString(16).padStart(64, '0'));
    let meta;
    const inline = /^data:application\/json(;base64)?,(.*)$/is.exec(uri);
    if (inline) meta = JSON.parse(inline[1] ? atob(inline[2]) : decodeURIComponent(inline[2]));
    else { const u = mediaUrl(uri); if (!u || u.startsWith('data:')) return null; meta = await getJson(u, 12000); }
    return meta ? { name: meta.name || null, image: mediaUrl(meta.image || meta.image_url), description: meta.description || '', traits: traitsOf(meta.attributes) } : null;
  } catch { return null; }
}

/** NFTs of an EVM address: { items, unsupported } (unsupported: no indexer, or one that needs a key not set). */
export async function loadEvmNfts(chain, address, { etherscanKey = '' } = {}) {
  const idx = chain.indexer;
  if (!idx || (idx.needsKey && !etherscanKey)) return { items: [], unsupported: true };
  if (idx.type === 'blockscout') {
    const items = [];
    let next = null;
    for (let page = 0; page < 4 && items.length < MAX_ITEMS; page++) {
      const q = new URLSearchParams({ type: 'ERC-721,ERC-404,ERC-1155', ...(next || {}) });
      const r = await getJson(`${idx.url}/api/v2/addresses/${address}/nft?${q}`);
      items.push(...fromBlockscout(r?.items));
      next = r?.next_page_params;
      if (!next) break;
    }
    return { items: items.slice(0, MAX_ITEMS), unsupported: false };
  }
  const list = async (action) => {
    const r = await getJson(etherscanUrl(chain, { module: 'account', action, address, page: 1, offset: 1000, sort: 'desc' }, etherscanKey));
    return Array.isArray(r?.result) ? r.result : [];
  };
  const [e721, e1155] = await Promise.all([list('tokennfttx'), list('token1155tx').catch(() => [])]);
  const held = holdingsFromTransfers(address, e721, e1155).slice(0, MAX_ITEMS);
  const metas = await Promise.all(held.slice(0, META_ON_CHAIN).map((h) => (spamNft('', h.collection, { symbol: h.symbol }) ? null : onChainMeta(chain, h))));
  const items = held.map((h, i) => {
    const m = metas[i] || {};
    return {
      key: `${h.contract}:${h.tokenId}`, contract: h.contract, tokenId: h.tokenId, name: m.name || `${h.collection || 'NFT'} #${h.tokenId}`,
      collection: h.collection, image: m.image || null, description: m.description || '', traits: m.traits || [], standard: h.standard, amount: h.amount,
      spam: spamNft(m.name, h.collection, { symbol: h.symbol, description: m.description }) || fakeBrand(h.collection),
    };
  });
  return { items, unsupported: false };
}
