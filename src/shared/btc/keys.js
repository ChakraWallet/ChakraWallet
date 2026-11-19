// Bitcoin keys and addresses: the four address types (Native SegWit bc1q… BIP84, Taproot bc1p… BIP86, and the older
// ones a wallet imported from another app may hold funds on: P2SH-SegWit 3… BIP49, legacy 1… BIP44), HD accounts from
// a BIP39 phrase, Electrum's own seeds, WIF private keys, and the output descriptors that let another wallet follow an
// account (watch-only). Pure functions, shared by the background (which alone sees private keys) and the screens
// (which derive addresses from the accounts' public keys).
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { secp256k1 } from '@noble/curves/secp256k1';

/** Address types: BIP purpose of their HD paths, whether new addresses are offered for receiving, input/output vsize. */
export const TYPES = {
  p2wpkh: { purpose: 84, receive: true, label: 'SegWit', inVb: 68, outVb: 31 },
  p2tr: { purpose: 86, receive: true, label: 'Taproot', inVb: 57.5, outVb: 43 },
  'p2sh-p2wpkh': { purpose: 49, receive: false, label: 'P2SH-SegWit', inVb: 91, outVb: 32 },
  p2pkh: { purpose: 44, receive: false, label: 'Legacy', inVb: 148, outVb: 34 },
};
export const RECEIVE_TYPES = ['p2wpkh', 'p2tr'];
export const LEGACY_TYPES = ['p2sh-p2wpkh', 'p2pkh'];

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h || '').replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ------------------------------------------------------------ addresses
/** The payment of a public key (33 bytes, compressed) for an address type: { address, script, … signing fields }. */
export function payment(type, pub, net) {
  switch (type) {
    case 'p2wpkh': return btc.p2wpkh(pub, net);
    case 'p2tr': return btc.p2tr(pub.length === 33 ? pub.slice(1) : pub, undefined, net);
    case 'p2sh-p2wpkh': return btc.p2sh(btc.p2wpkh(pub, net), net);
    case 'p2pkh': return btc.p2pkh(pub, net);
    default: throw new Error(`unknown address type ${type}`);
  }
}
export const addressOf = (type, pub, net) => payment(type, pub, net).address;

const OUT_TYPES = { wpkh: 'p2wpkh', tr: 'p2tr', sh: 'p2sh', pkh: 'p2pkh', wsh: 'p2wsh', unknown: 'unknown' };
/**
 * A typed address: { type ('p2wpkh' | 'p2tr' | 'p2sh' | 'p2pkh' | 'p2wsh' | 'unknown' (future SegWit versions)),
 * script (Uint8Array) } or null when it isn't an address of this network.
 */
export function decodeAddress(text, net) {
  try {
    const out = btc.Address(net).decode(String(text || '').trim());
    return { type: OUT_TYPES[out.type] || out.type, script: btc.OutScript.encode(out) };
  } catch { return null; }
}
/** The address an output script pays (null for OP_RETURN and non-standard scripts). */
export function scriptAddress(script, net) {
  try { return btc.Address(net).encode(btc.OutScript.decode(typeof script === 'string' ? fromHex(script) : script)); } catch { return null; }
}
/** The vsize an output of this script adds to a transaction. */
export const outputVbytes = (script) => 8 + 1 + (script.length >= 0xfd ? 2 : 0) + script.length;
/** The type of an input spent from this output script (for the size of its signature). */
export function inputTypeOfScript(script) {
  const s = typeof script === 'string' ? fromHex(script) : script;
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return 'p2wpkh';
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return 'p2tr';
  if (s.length === 23 && s[0] === 0xa9) return 'p2sh-p2wpkh';
  if (s.length === 25 && s[0] === 0x76) return 'p2pkh';
  return null;
}

// ------------------------------------------------------------ HD accounts (BIP39 phrase)
export const isBip39 = (phrase) => validateMnemonic(cleanWords(phrase), wordlist);
export const cleanWords = (s) => String(s || '').trim().toLowerCase().split(/\s+/).join(' ');
export const seedOfPhrase = (phrase) => mnemonicToSeedSync(cleanWords(phrase));
/** The HD path of an account of an address type (coin: 0 mainnet, 1 test networks). */
export const accountPath = (type, coin, index) => `m/${TYPES[type].purpose}'/${coin}'/${index}'`;

/**
 * The public side of an HD account: one branch per address type, each with its account-level extended public key.
 * -> { fp (the master key's fingerprint, hex), branches: [{ type, path, xpub }] }
 */
export function hdAccountPublic(seed, coin, index, types = Object.keys(TYPES)) {
  const root = HDKey.fromMasterSeed(seed);
  return {
    fp: fingerprintHex(root.fingerprint),
    branches: types.map((type) => {
      const path = accountPath(type, coin, index);
      return { type, path, xpub: root.derive(path).publicExtendedKey };
    }),
  };
}
const fingerprintHex = (n) => (n >>> 0).toString(16).padStart(8, '0');

/** Private key of an address in an HD branch (background only). */
export function branchKey(seed, branchPath, chain, index) {
  const k = HDKey.fromMasterSeed(seed).derive(`${branchPath}/${chain}/${index}`);
  return { privateKey: k.privateKey, publicKey: k.publicKey };
}

/** Public keys of addresses of a branch from its extended public key: cached, derivation is the slow part. */
const nodes = new Map();
function chainNode(xpub, chain) {
  const k = `${xpub}/${chain}`;
  if (!nodes.has(k)) {
    if (nodes.size > 200) nodes.clear();
    nodes.set(k, HDKey.fromExtendedKey(xpub).deriveChild(chain));
  }
  return nodes.get(k);
}
const derived = new Map();
export function branchPub(xpub, chain, index) {
  const k = `${xpub}/${chain}/${index}`;
  let v = derived.get(k);
  if (!v) {
    if (derived.size > 20000) derived.clear();
    v = chainNode(xpub, chain).deriveChild(index).publicKey;
    derived.set(k, v);
  }
  return v;
}
export const branchAddress = (branch, chain, index, net) => addressOf(branch.type, branchPub(branch.xpub, chain, index), net);

// ------------------------------------------------------------ Electrum seeds (Electrum's own format, not BIP39)
const CJK = [[0x4E00, 0x9FFF], [0x3400, 0x4DBF], [0x20000, 0x2A6DF], [0x2A700, 0x2B73F], [0x2B740, 0x2B81F], [0xF900, 0xFAFF], [0x2F800, 0x2FA1D], [0x2E80, 0x2EFF], [0x2F00, 0x2FDF], [0x2FF0, 0x2FFF], [0x3000, 0x303F], [0x31C0, 0x31EF], [0x3200, 0x32FF], [0x3300, 0x33FF], [0xF900, 0xFAFF], [0xFE30, 0xFE4F], [0x1F200, 0x1F2FF], [0x3040, 0x309F], [0x30A0, 0x30FF], [0x31F0, 0x31FF], [0xFF00, 0xFFEF], [0xAC00, 0xD7AF], [0x1100, 0x11FF], [0x3130, 0x318F]];
const isCjk = (c) => { const n = c?.codePointAt(0); return n != null && CJK.some(([a, b]) => n >= a && n <= b); };
/** Electrum's normalisation of a seed (NFKD, lower case, no accents, single spaces, none between CJK characters). */
export function electrumNormalize(seed) {
  const s = [...String(seed || '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').trim().split(/\s+/).join(' ')];
  return s.filter((c, i) => !(c === ' ' && isCjk(s[i - 1]) && isCjk(s[i + 1]))).join('');
}
const enc = new TextEncoder();
/** 'standard' (legacy addresses 1…) | 'segwit' (bc1q…) | null: what kind of Electrum seed the words are (2FA ones aren't supported). */
export function electrumSeedType(words) {
  const n = electrumNormalize(words);
  if (!n || n.split(' ').length < 12) return null;
  const h = toHex(hmac(sha512, enc.encode('Seed version'), enc.encode(n)));
  if (h.startsWith('01')) return 'standard';
  if (h.startsWith('100')) return 'segwit';
  return null;
}
export const electrumSeed = (words, passphrase = '') => pbkdf2(sha512, enc.encode(electrumNormalize(words)), enc.encode(`electrum${electrumNormalize(passphrase)}`), { c: 2048, dkLen: 64 });
/** The one branch of an Electrum wallet: SegWit seeds at m/0' (bc1q…), standard ones at m (1…), chains 0 and 1. */
export function electrumPublic(words) {
  const type = electrumSeedType(words);
  if (!type) return null;
  const root = HDKey.fromMasterSeed(electrumSeed(words));
  const path = type === 'segwit' ? "m/0'" : 'm';
  return { kind: type, fp: fingerprintHex(root.fingerprint), branches: [{ type: type === 'segwit' ? 'p2wpkh' : 'p2pkh', path, xpub: (path === 'm' ? root : root.derive(path)).publicExtendedKey }] };
}

// ------------------------------------------------------------ WIF private keys
/** A WIF key -> { privateKey, publicKey (compressed), testnet }. Uncompressed keys (very old wallets) are refused. */
export function decodeWif(text) {
  const s = String(text || '').trim();
  for (const [net, testnet] of [[{ wif: 0x80 }, false], [{ wif: 0xef }, true]]) {
    try {
      const privateKey = btc.WIF(net).decode(s);
      return { privateKey, publicKey: pubOf(privateKey), testnet };
    } catch { /* the other network, or not a WIF */ }
  }
  throw new Error('bad wif');
}
export const encodeWif = (privateKey, testnet = false) => btc.WIF({ wif: testnet ? 0xef : 0x80 }).encode(privateKey);
/** Whether a text looks like an uncompressed WIF key (5…, 9…): Chakra can't use those. */
export const isUncompressedWif = (s) => /^[59][1-9A-HJ-NP-Za-km-z]{50}$/.test(String(s || '').trim());
/** The compressed public key of a private key. */
export const pubOf = (privateKey) => secp256k1.getPublicKey(privateKey, true);

// ------------------------------------------------------------ output descriptors (watch-only in another wallet)
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
function polymod(symbols) {
  let chk = 1n;
  for (const v of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i];
  }
  return chk;
}
function expand(s) {
  const groups = [], symbols = [];
  for (const c of s) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v < 0) return null;
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) { symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]); groups.length = 0; }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  return symbols;
}
/** A descriptor with its BIP380 checksum (desc#checksum). */
export function withChecksum(desc) {
  const sym = expand(desc);
  if (!sym) throw new Error('bad descriptor');
  const c = polymod([...sym, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = '';
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - i))) & 31n)];
  return `${desc}#${out}`;
}
const WRAP = { p2wpkh: (k) => `wpkh(${k})`, p2tr: (k) => `tr(${k})`, 'p2sh-p2wpkh': (k) => `sh(wpkh(${k}))`, p2pkh: (k) => `pkh(${k})` };
/** The output descriptor of a branch (receive and change: <0;1>/*), e.g. wpkh([73c5da0a/84h/0h/0h]xpub…/<0;1>/*)#… */
export function branchDescriptor(branch, fp, testnet = false) {
  const origin = branch.path === 'm' ? fp : `${fp}/${branch.path.slice(2).replace(/'/g, 'h')}`;
  return withChecksum(WRAP[branch.type](`[${origin}]${toNetworkXpub(branch.xpub, testnet)}/<0;1>/*`));
}
/** The extended public key with the version of its network (tpub… on test networks). */
export function toNetworkXpub(xpub, testnet) {
  if (!testnet) return xpub;
  const k = HDKey.fromExtendedKey(xpub);
  return new HDKey({ versions: { private: 0x04358394, public: 0x043587cf }, depth: k.depth, index: k.index, parentFingerprint: k.parentFingerprint, chainCode: k.chainCode, publicKey: k.publicKey }).publicExtendedKey;
}
