// Tron in the background (registered by src/background/chainModules.js): Tron addresses of the accounts,
// signing transactions and messages, importing wallets from other Tron apps. Keys never leave the background: the UI
// gets addresses only and sends here the bytes to sign, after the password. Every transaction is decoded before it is
// signed: it must be the account's own (its owner), and a change of the account's permissions (the way scams take an
// account over) is refused whatever asks for it.
import * as vault from './vault.js';
import { hdKey, keyOfPrivate, privateKeyText, signRawData, signHash, messageHashV2, messageHashV1, fromHex } from '../shared/tron/core.js';
import { decodeRawData } from '../shared/tron/proto.js';
import { i18nError } from '../shared/i18n.js';

/** Key of an account of the active wallet: { privateKey, address } or null (e.g. a TON-only account). */
export async function keyOf(account) {
  const src = await vault.familyKeySource('tron', account, { evmKeys: true });
  if (!src) return null;
  if (src.phrase) return hdKey(src.phrase, src.index);
  return keyOfPrivate(src.evmKey || src.secret);
}
async function mustKey(account) {
  const k = await keyOf(account);
  if (!k) throw i18nError('errors.accountUnavailable');
  return k;
}

/** Contracts never signed, whoever asks: they hand the account to someone else. */
export const FORBIDDEN = new Set(['AccountPermissionUpdateContract']);

/**
 * Checks a transaction before signing it: decodable, only contracts of this account, none forbidden.
 * -> the decoded transaction; throws an i18n error otherwise.
 */
export function checkTransaction(rawDataHex, address) {
  let d;
  try { d = decodeRawData(rawDataHex); } catch { throw i18nError('tron.err.badTx'); }
  if (!d.contracts.length) throw i18nError('tron.err.badTx');
  for (const c of d.contracts) {
    if (FORBIDDEN.has(c.type)) throw i18nError('tron.err.permissionUpdate');
    const owner = c.parameter?.owner_address;
    if (!owner || owner !== address) throw i18nError('tron.err.notOwner');
    if (c.permissionId) throw i18nError('tron.err.multisig');
  }
  return d;
}

/** Signs transactions (raw_data hex) with an account's key. The caller has checked the password. -> { txIDs, signatures } */
export async function signWith(account, txs) {
  const k = await mustKey(account);
  const out = txs.map((raw) => { checkTransaction(raw, k.address); return signRawData(raw, k.privateKey); });
  return { txIDs: out.map((x) => x.txID), signatures: out.map((x) => x.signature) };
}

/**
 * A message signed by an account (dapps: proofs of ownership). v2 (signMessageV2): text, or hex bytes (0x…); v1 (the
 * old signMessage): a 32-byte hex value. -> signature hex (0x…, v = 27 / 28, as TronLink returns it).
 */
export async function signMessageWith(account, { message, hex = false, version = 2 }) {
  const k = await mustKey(account);
  const hash = version === 1 ? messageHashV1(message) : messageHashV2(hex ? fromHex(message) : String(message));
  return `0x${signHash(hash, k.privateKey)}`;
}

/** Keys typed by the user (wallet import): a phrase (TronLink's path, the first accounts) or a private key. */
function keysOf({ phrase, secret }) {
  if (phrase) {
    const words = String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
    try { return [0, 1, 2, 3, 4].map((index) => ({ index, path: `m/44'/195'/0'/0/${index}`, ...hdKey(words, index) })); }
    catch { throw i18nError('errors.invalidPhrase'); }
  }
  try { return [{ index: 0, path: null, ...keyOfPrivate(String(secret).trim()) }]; } catch { throw i18nError('errors.invalidPrivateKey'); }
}

/** { [account address]: { address } } for the active wallet's accounts that have a Tron key. */
async function tronAccounts() {
  const out = {};
  for (const a of await vault.activeAccounts()) {
    const k = await keyOf(a.address).catch(() => null);
    if (k) out[a.address] = { address: k.address };
  }
  return out;
}

export const tronHandlers = {
  tronAccounts,

  /** Signs transactions after the password (sends, stake, swaps, bridges, contracts). -> { txIDs, signatures } */
  async tronSign({ from, txs, password }) {
    await vault.verifyPassword(password);
    return signWith(from, txs);
  },

  /** The addresses a phrase or a key from another Tron app gives, to find the one in use. */
  async tronInspectKey(input) {
    return { found: keysOf(input).map(({ index, path, address }) => ({ index, path, address })) };
  },

  /** Imports one account of another Tron app's phrase or key as a Tron account of the active wallet. */
  async tronImport({ phrase, secret, index = 0, name }) {
    const pick = keysOf({ phrase, secret }).find((x) => x.index === (phrase ? index : 0));
    if (!pick) throw i18nError('errors.invalidPrivateKey');
    // the same key already in the wallet (e.g. as an Ethereum account): its Tron address is there already
    if (Object.values(await tronAccounts()).some((x) => x.address === pick.address)) throw i18nError('errors.accountExists');
    return vault.addFamilyAccount('tron', { address: pick.address, secret: privateKeyText(pick.privateKey) }, name);
  },
};
