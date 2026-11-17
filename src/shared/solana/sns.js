// .sol names (Solana Name Service), read on chain: the domain's account is derived from its name; its owner is where
// funds go. A domain turned into an NFT (Name Tokenizer) belongs to whoever holds that NFT.
import { sha256 } from '@noble/hashes/sha256';
import { findProgramAddress, addressBytes, addressOf, utf8 } from './core.js';
import { accountInfo, rpc } from './api.js';

export const NAME_PROGRAM = 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX';
export const SOL_TLD = '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx'; // the .sol root
export const NAME_TOKENIZER = 'nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk';

/** "alice.sol" / "Alice.SOL" -> "alice" (second-level names only), else null. */
export function snsName(text) {
  const s = String(text || '').trim().toLowerCase();
  const m = /^([a-z0-9_-]{1,63})\.sol$/u.exec(s);
  return m ? m[1] : null;
}

/** The account of a domain under a parent (default: .sol). */
export function domainKey(name, parent = SOL_TLD) {
  const hashed = sha256(utf8(`SPL Name Service${name}`));
  return findProgramAddress([hashed, new Uint8Array(32), addressBytes(parent)], NAME_PROGRAM)[0];
}

/** The address a .sol name points to (its owner, or the holder of its NFT), or null when it doesn't exist. */
export async function resolveSns(chain, name) {
  const reg = await accountInfo(chain, domainKey(name));
  if (!reg || reg.owner !== NAME_PROGRAM || reg.data.length < 96) return null;
  const owner = addressOf(reg.data.slice(32, 64));
  const o = await accountInfo(chain, owner).catch(() => null);
  if (o?.owner !== NAME_TOKENIZER) return owner;
  // tokenized: the NFT record says which mint; its holder owns the name
  if (o.data.length < 98) return null;
  const mint = addressOf(o.data.slice(66, 98));
  const largest = await rpc(chain, 'getTokenLargestAccounts', [mint]);
  const holderAcc = largest.value.find((x) => x.amount === '1')?.address;
  if (!holderAcc) return null;
  const parsed = await rpc(chain, 'getAccountInfo', [holderAcc, { encoding: 'jsonParsed' }]);
  return parsed.value?.data?.parsed?.info?.owner || null;
}
