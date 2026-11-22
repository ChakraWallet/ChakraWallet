// Solana in the background (registered by src/background/chainModules.js): Solana addresses of the accounts,
// signing transactions and messages, importing wallets from other Solana apps. Keys never leave the
// background: the UI gets addresses only, and sends transactions here to be signed after the password.
import * as vault from './vault.js';
import { hdSeed, keyOfSeed, seedFromSecret, secretText, signBytes, fromBase64, toBase64, SCHEMES, DEFAULT_SCHEME } from '../shared/solana/core.js';
import { signTransaction, parseTransaction } from '../shared/solana/tx.js';
import * as b58 from '../shared/solana/base58.js';
import { i18nError } from '../shared/i18n.js';

/** Key of an account of the active wallet: { seed, publicKey, address } or null (e.g. an imported Ethereum key). */
export async function keyOf(account) {
  const src = await vault.familyKeySource('solana', account);
  if (!src) return null;
  if (src.phrase) return keyOfSeed(hdSeed(src.phrase, src.index, DEFAULT_SCHEME));
  return keyOfSeed(seedFromSecret(src.secret));
}
async function mustKey(account) {
  const k = await keyOf(account);
  if (!k) throw i18nError('errors.accountUnavailable');
  return k;
}

/**
 * Signs transactions (base64 wire bytes) with an account's key, in its slot among the signers; signatures already
 * there (e.g. a new account's own key, added by the UI) are kept. The caller has checked the password.
 * -> { txs: [base64], signatures: [base58: each transaction's id] }
 */
export async function signWith(account, txs) {
  const k = await mustKey(account);
  const out = txs.map((t) => {
    const bytes = fromBase64(t);
    const { msg } = parseTransaction(bytes);
    if (!msg.keys.slice(0, msg.header.signatures).includes(k.address)) throw i18nError('sol.err.notSigner');
    return signTransaction(bytes, [k.seed]);
  });
  return { txs: out.map((x) => toBase64(x.bytes)), signatures: out.map((x) => x.signature) };
}

/** A message signed by an account (dapps: "sign in", proofs of ownership) -> signature (64 bytes, base58). */
export async function signMessageWith(account, message) {
  const k = await mustKey(account);
  return b58.encode(signBytes(fromBase64(message), k.seed));
}

/** A key typed by the user (wallet import): a phrase, or a private key. */
function seedsOf({ phrase, secret }) {
  if (phrase) {
    const words = String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
    const out = [];
    try {
      for (const [scheme, s] of Object.entries(SCHEMES)) {
        for (let i = 0; i < (s.many ? 5 : 1); i++) out.push({ scheme, index: i, path: s.text(i), seed: hdSeed(words, i, scheme) });
      }
    } catch { throw i18nError('errors.invalidPhrase'); }
    return out;
  }
  try { return [{ scheme: 'key', index: 0, path: null, seed: seedFromSecret(secret) }]; } catch { throw i18nError('errors.invalidPrivateKey'); }
}

export const solanaHandlers = {
  /** { [account address]: { address } } for the active wallet's accounts that have a Solana key. */
  async solanaAccounts() {
    const out = {};
    for (const a of await vault.activeAccounts()) {
      const k = await keyOf(a.address).catch(() => null);
      if (k) out[a.address] = { address: k.address };
    }
    return out;
  },

  /** Signs transactions after the password (sends, swaps, bridges, contracts). -> { txs, signatures } */
  async solanaSign({ from, txs, password }) {
    await vault.verifyPassword(password);
    return signWith(from, txs);
  },

  /** The addresses a phrase or a key from another Solana app gives (several paths), to find the one in use. */
  async solanaInspectKey(input) {
    return { found: seedsOf(input).map(({ scheme, index, path, seed }) => ({ scheme, index, path, address: keyOfSeed(seed).address })) };
  },

  /** Imports one account of another Solana app's phrase or key as a Solana account of the active wallet. */
  async solanaImport({ phrase, secret, scheme, index = 0, name }) {
    const pick = seedsOf({ phrase, secret }).find((x) => x.scheme === (phrase ? scheme : 'key') && x.index === index);
    if (!pick) throw i18nError('errors.invalidPrivateKey');
    const { address } = keyOfSeed(pick.seed);
    return vault.addFamilyAccount('solana', { address, secret: secretText(pick.seed) }, name);
  },
};
