// Tron - keys, addresses, transaction ids and signatures, message signing. No network and no UI here.
// Android app only (registered by src/mobile/tronPlugin.js).
//
// Keys: secp256k1, the curve of Ethereum. From the wallet's recovery phrase (BIP-39 + BIP-32) at m/44'/195'/0'/0/{i},
// the path of TronLink, Trust Wallet and Ledger, so account i has its Ethereum and its Tron address from the same
// phrase. An Ethereum private key (an imported or generated account) is also a Tron key: same 20 bytes of address,
// written the Tron way. Addresses: 0x41 + the last 20 bytes of keccak256(public key), in base58 with a checksum (T…).
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { HDNodeWallet } from 'ethers';
import { bip39Seed } from '../hd25519.js';
import * as b58 from '../solana/base58.js';

export const TRX_DECIMALS = 6;
export const SUN = 1_000_000n; // 1 TRX = 1,000,000 sun
export const ADDRESS_PREFIX = 0x41;
export const hdPath = (index) => `m/44'/195'/0'/0/${index >>> 0}`;

// ------------------------------------------------------------ bytes
const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(String(s));
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('invalid hex');
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}
export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ------------------------------------------------------------ addresses
const checksum = (bytes) => sha256(sha256(bytes)).slice(0, 4);

/** 21 bytes (0x41 + 20) -> base58 text with its checksum (T…). */
export function encodeAddress(bytes) {
  if (bytes.length !== 21 || bytes[0] !== ADDRESS_PREFIX) throw new Error('invalid Tron address bytes');
  return b58.encode(concat([bytes, checksum(bytes)]));
}
/** base58 address -> its 21 bytes, or null when it isn't a Tron address (checksum, length, prefix). */
export function decodeAddress(text) {
  try {
    const b = b58.decode(String(text || '').trim());
    if (b.length !== 25) return null;
    const body = b.slice(0, 21);
    if (body[0] !== ADDRESS_PREFIX || !same(checksum(body), b.slice(21))) return null;
    return body;
  } catch { return null; }
}
export const isAddress = (text) => !!decodeAddress(text);
/** Any form of an address (T…, 41… hex, 0x… hex) -> T…, or null. */
export function toBase58(a) {
  const s = String(a || '').trim();
  if (isAddress(s)) return s;
  const h = s.replace(/^0x/i, '');
  if (/^41[0-9a-f]{40}$/i.test(h)) return encodeAddress(fromHex(h));
  if (/^[0-9a-f]{40}$/i.test(h)) return encodeAddress(fromHex(`41${h}`));
  return null;
}
/** T… -> 41… hex (lower case), as the node's API writes addresses without visible: true. */
export function toHexAddress(text) {
  const b = decodeAddress(text);
  if (!b) throw new Error('invalid Tron address');
  return toHex(b);
}
/** The Ethereum form of a Tron address (0x + the same 20 bytes): what contracts see. */
export const toEvmAddress = (text) => `0x${toHexAddress(text).slice(2)}`;
/** An Ethereum address written the Tron way (same key, same 20 bytes). */
export const fromEvmAddress = (evm) => toBase58(String(evm).replace(/^0x/i, ''));

/** Uncompressed (65 bytes) or compressed (33) public key -> T… address. */
export function addressOfPublicKey(publicKey) {
  const pub = publicKey.length === 65 ? publicKey : secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  return encodeAddress(concat([Uint8Array.of(ADDRESS_PREFIX), keccak_256(pub.slice(1)).slice(12)]));
}

// ------------------------------------------------------------ keys
/** A private key (hex, with or without 0x) -> { privateKey: Uint8Array(32), address }; throws when invalid. */
export function keyOfPrivate(hex) {
  const privateKey = fromHex(String(hex).trim());
  if (privateKey.length !== 32 || !secp256k1.utils.isValidPrivateKey(privateKey)) throw new Error('invalid private key');
  return { privateKey, address: addressOfPublicKey(secp256k1.getPublicKey(privateKey, false)) };
}
/** Account `index` of a recovery phrase on Tron's path (m/44'/195'/0'/0/index) -> { privateKey, address }. */
export function hdKey(phrase, index = 0) {
  const node = HDNodeWallet.fromSeed(bip39Seed(phrase)).derivePath(hdPath(index));
  return keyOfPrivate(node.privateKey);
}
/** Text of a private key as other Tron apps export it (64 hex characters, no 0x). */
export const privateKeyText = (privateKey) => toHex(privateKey);

// ------------------------------------------------------------ transactions and messages
/** A transaction's id: sha256 of its raw_data bytes (hex). */
export const txIdOf = (rawBytes) => toHex(sha256(rawBytes));

/** secp256k1 signature of a 32-byte hash: r ‖ s ‖ v (v = 27 + recovery id, as TronWeb writes it), hex. */
export function signHash(hash, privateKey) {
  const sig = secp256k1.sign(hash, privateKey);
  return toHex(concat([sig.toCompactRawBytes(), Uint8Array.of(27 + sig.recovery)]));
}
/** The address that signed a hash (signature hex, v as 0/1 or 27/28), or null. */
export function recoverSigner(hash, signatureHex) {
  try {
    const s = fromHex(signatureHex);
    if (s.length !== 65) return null;
    const v = s[64] >= 27 ? s[64] - 27 : s[64];
    const sig = secp256k1.Signature.fromCompact(s.slice(0, 64)).addRecoveryBit(v);
    return addressOfPublicKey(sig.recoverPublicKey(hash).toRawBytes(false));
  } catch { return null; }
}
/** Signs a transaction's raw_data (hex) -> { txID, signature }. */
export function signRawData(rawDataHex, privateKey) {
  const txID = txIdOf(fromHex(rawDataHex));
  return { txID, signature: signHash(fromHex(txID), privateKey) };
}

/**
 * Hash of a message as TronLink signs it (signMessageV2, TIP-191): keccak256("\x19TRON Signed Message:\n" + length +
 * message). message: text, or bytes (a dapp passing hex signs those bytes).
 */
export function messageHashV2(message) {
  const bytes = typeof message === 'string' ? utf8(message) : message;
  return keccak_256(concat([utf8(`\x19TRON Signed Message:\n${bytes.length}`), bytes]));
}
/** The old signMessage (v1): a 32-byte hex value, hashed with the fixed length 32. */
export function messageHashV1(hex32) {
  const bytes = fromHex(hex32);
  return keccak_256(concat([utf8('\x19TRON Signed Message:\n32'), bytes]));
}
