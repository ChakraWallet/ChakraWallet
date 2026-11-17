// Solana - keys, addresses, program-derived addresses, byte helpers. No network and no UI here.
// Android app only (registered by src/mobile/solanaPlugin.js).
//
// Keys: Ed25519, from the wallet's recovery phrase (BIP-39) with SLIP-0010 at m/44'/501'/{i}'/0' - the path of Phantom,
// Solflare, Backpack and Ledger - so account i has its Ethereum and its Solana address from the same phrase. Wallets
// imported from other Solana apps: their phrase on one of the paths below, or their private key (base58, as Phantom
// exports it, or the JSON array of a solana-keygen file).
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { slip10Ed25519, bip39Seed, HARDENED } from '../hd25519.js';
import * as b58 from './base58.js';

export const base58 = b58;
export const SOL_DECIMALS = 9;
export const LAMPORTS = 1_000_000_000n;

// ------------------------------------------------------------ bytes
const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(String(s));
export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('invalid hex');
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromBase64 = (s) => Uint8Array.from(atob(String(s).trim()), (c) => c.charCodeAt(0));
export const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ------------------------------------------------------------ addresses
/** An address (base58 text) -> its 32 bytes; bytes are returned as they are. Throws when it isn't one. */
export function addressBytes(a) {
  if (a instanceof Uint8Array) { if (a.length !== 32) throw new Error('invalid address'); return a; }
  const b = b58.decode(String(a).trim());
  if (b.length !== 32) throw new Error('invalid address');
  return b;
}
export const addressOf = (bytes) => b58.encode(bytes);
/** Is the text a Solana address (32 bytes in base58)? Wallets and program-derived addresses alike. */
export function isAddress(text) {
  const s = String(text ?? '').trim();
  if (s.length < 32 || s.length > 44) return false;
  try { return b58.decode(s).length === 32; } catch { return false; }
}
/** Is a 32-byte value a point of the curve (an address someone can hold the key of)? PDAs are off the curve. */
export function isOnCurve(a) {
  try { ed25519.ExtendedPoint.fromHex(addressBytes(a)); return true; } catch { return false; }
}

const PDA_MARK = utf8('ProgramDerivedAddress');
const seedBytes = (s) => (s instanceof Uint8Array ? s : utf8(s));
/** A program address from its seeds (bytes - addresses as addressBytes(a) - or text) - throws when on the curve. */
export function createProgramAddress(seeds, programId) {
  const parts = seeds.map(seedBytes);
  if (parts.length > 16 || parts.some((p) => p.length > 32)) throw new Error('invalid seeds');
  const h = sha256(concat([...parts, addressBytes(programId), PDA_MARK]));
  if (isOnCurve(h)) throw new Error('on curve');
  return addressOf(h);
}
/** The canonical program-derived address of seeds: [address, bump]. */
export function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    try { return [createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump]; } catch { /* next bump */ }
  }
  throw new Error('no program address');
}
/** SystemProgram.createWithSeed's address: sha256(base, seed, owner program). */
export const createWithSeed = (base, seed, programId) => addressOf(sha256(concat([addressBytes(base), utf8(seed), addressBytes(programId)])));

// ------------------------------------------------------------ keys
/**
 * Derivation schemes of other Solana apps (wallet import): Phantom / Solflare / Backpack / Ledger (m/44'/501'/i'/0',
 * also the wallet's own), Trust Wallet and older apps (m/44'/501'/i'), and solana-keygen without a path (the first 32
 * bytes of the BIP-39 seed: one account only).
 */
export const SCHEMES = {
  bip44Change: { text: (i) => `m/44'/501'/${i}'/0'`, path: (i) => [44, 501, i, 0], many: true },
  bip44: { text: (i) => `m/44'/501'/${i}'`, path: (i) => [44, 501, i], many: true },
  cli: { text: () => 'solana-keygen', path: null, many: false },
};
export const DEFAULT_SCHEME = 'bip44Change';

/** The 32-byte private seed of account `index` of a BIP-39 phrase on a scheme. */
export function hdSeed(phrase, index = 0, scheme = DEFAULT_SCHEME) {
  const seed = bip39Seed(phrase);
  const s = SCHEMES[scheme];
  if (!s) throw new Error(`unknown scheme ${scheme}`);
  if (!s.path) return seed.slice(0, 32);
  return slip10Ed25519(seed, s.path(index >>> 0).map((x) => (x + HARDENED) >>> 0));
}

/** Public key (32 bytes) and address of a 32-byte private seed. */
export function keyOfSeed(seed) {
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, address: addressOf(publicKey) };
}
/** Ed25519 signature (64 bytes) of a message with a 32-byte private seed. */
export const signBytes = (message, seed) => ed25519.sign(message, seed);
export const verifyBytes = (signature, message, address) => { try { return ed25519.verify(signature, message, addressBytes(address)); } catch { return false; } };

/** A key as Phantom and Solflare export it: base58 of the 64-byte secret key (seed + public key). */
export const secretText = (seed) => b58.encode(concat([seed, ed25519.getPublicKey(seed)]));

/**
 * A private key typed or pasted: base58 (64 bytes, as Phantom exports it, or a 32-byte seed), the JSON array of a
 * solana-keygen file ([12, 34, …], 64 numbers), or hex (32 or 64 bytes). -> the 32-byte seed; throws when it isn't one,
 * or when the public half of a 64-byte key doesn't match its private half.
 */
export function seedFromSecret(text) {
  const s = String(text || '').trim();
  let b;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr) || arr.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('invalid key');
    b = Uint8Array.from(arr);
  } else if (/^(0x)?[0-9a-fA-F]{64}([0-9a-fA-F]{64})?$/.test(s)) b = fromHex(s);
  else b = b58.decode(s);
  if (b.length !== 32 && b.length !== 64) throw new Error('invalid key');
  const seed = b.slice(0, 32);
  if (b.length === 64 && !equalBytes(ed25519.getPublicKey(seed), b.slice(32))) throw new Error('invalid key');
  return seed;
}

/** Amounts: lamports (bigint or text) <-> SOL as a number, for display only. */
export const sol = (lamports) => Number(lamports || 0) / 1e9;
