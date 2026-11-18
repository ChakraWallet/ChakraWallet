// Tron NFTs (TRC-721) without an indexer key: TronGrid lists the account's token transfers with the NFTs among them
// (no decimals, the value is the token id); the ids still held are replayed from them, each checked on its contract
// (ownerOf), and described by its own metadata (tokenURI). Only contracts that say they are TRC-721 (supportsInterface)
// count; the latest transfers are enough for most wallets. Shapes: the shared NFT items (src/shared/nft.js).
import { Interface } from 'ethers';
import { tronApi, constantCall } from './api.js';
import { toBase58 } from './core.js';
import { mediaUrl, spamNft, traitsOf } from '../nftMeta.js';

const NFT = new Interface([
  'function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)',
  'function supportsInterface(bytes4) view returns (bool)', 'function name() view returns (string)',
]);
const MAX_ITEMS = 30, PER_COLLECTION = 12;

async function read(chain, contract, fn, args, owner) {
  const r = await constantCall(chain, { owner, contract, data: NFT.encodeFunctionData(fn, args).slice(2) }).catch(() => null);
  if (!r?.ok || !r.result) return null;
  try { return NFT.decodeFunctionResult(fn, `0x${r.result}`)[0]; } catch { return null; }
}

/** The token's metadata (JSON), or { image } when its URI is the picture itself (common among older Tron NFTs). */
async function metadata(uri) {
  const url = mediaUrl(uri) || (/^https?:\/\//.test(uri) ? uri.replace(/^http:/, 'https:') : null);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    if (/^image\//i.test(res.headers.get('content-type') || '')) return { image: url };
    return await res.json();
  } catch { return null; }
}

/** The NFTs held by a Tron address: { items, unsupported: false }. */
export async function loadTronNfts(chain, owner) {
  const j = await tronApi(chain, `/v1/accounts/${owner}/transactions/trc20?limit=200`);
  const collections = new Map(); // contract -> { name, ids: Set }
  for (const x of [...(j?.data || [])].reverse()) { // oldest first
    const ti = x.token_info || {};
    if (x.type !== 'Transfer' || Number(ti.decimals) !== 0 || !ti.address) continue;
    const c = collections.get(ti.address) || { name: ti.name || ti.symbol || '', ids: new Set() };
    const id = String(x.value);
    if (x.to === owner) c.ids.add(id); else if (x.from === owner) c.ids.delete(id);
    collections.set(ti.address, c);
  }
  const items = [];
  for (const [contract, c] of collections) {
    if (!c.ids.size || items.length >= MAX_ITEMS) continue;
    if ((await read(chain, contract, 'supportsInterface', ['0x80ac58cd'], owner)) !== true) continue; // not a TRC-721
    for (const id of [...c.ids].slice(-PER_COLLECTION)) {
      if (items.length >= MAX_ITEMS) break;
      const holder = await read(chain, contract, 'ownerOf', [BigInt(id)], owner);
      if (!holder || toBase58(holder) !== owner) continue;
      const uri = await read(chain, contract, 'tokenURI', [BigInt(id)], owner);
      const md = uri ? await metadata(String(uri)) : null;
      const name = md?.name || `${c.name || 'NFT'} #${id}`;
      items.push({
        key: `${contract}:${id}`, contract, tokenId: id, name, collection: c.name, image: mediaUrl(md?.image) || (typeof md?.image === 'string' && /^https?:/.test(md.image) ? md.image : ''),
        description: md?.description || '', traits: traitsOf(md?.attributes), standard: 'TRC-721', amount: '1',
        spam: spamNft(md?.name, c.name, { description: md?.description || '' }),
      });
    }
  }
  return { items, unsupported: false };
}

