// Ed25519 keys from a BIP-39 recovery phrase (SLIP-0010, hardened derivation only), shared by the families whose keys
// are Ed25519 (TON: m/44'/607'/i', Solana: m/44'/501'/i'/0'). No network, no UI; used by the background.
import { Mnemonic } from 'ethers';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

export const HARDENED = 0x80000000;
const ser32 = (i) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, i >>> 0); return b; };

/** SLIP-0010 Ed25519 (hardened only): 32-byte private seed for a path of indexes (already hardened). */
export function slip10Ed25519(seed, path) {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let k = I.slice(0, 32), c = I.slice(32);
  for (const i of path) {
    const data = new Uint8Array(37);
    data.set(k, 1);
    data.set(ser32(i), 33);
    I = hmac(sha512, c, data);
    k = I.slice(0, 32); c = I.slice(32);
  }
  return k;
}

const hexBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const seeds = new Map(); // phrase -> BIP-39 seed (the PBKDF2 is the slow part; kept only in memory, in the background)
/** The BIP-39 seed (64 bytes) of a phrase, cached in memory. */
export function bip39Seed(phrase) {
  let s = seeds.get(phrase);
  if (!s) {
    s = hexBytes(Mnemonic.fromPhrase(phrase).computeSeed().slice(2));
    seeds.set(phrase, s);
  }
  return s;
}
export const forgetSeeds = () => seeds.clear();
