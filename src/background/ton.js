// TON in the background (registered by src/background/chainModules.js): TON addresses of the accounts,
// signing and broadcasting transfers, importing wallets from other TON apps. Keys never leave the background:
// the UI gets addresses and public keys only.
import * as vault from './vault.js';
import { Buffer } from '../shared/ton/buffer.js';
import { Address, Cell, loadStateInit } from '@ton/core';
import { hdKeyPair, tonKeyFromPhrase, tonKeyFromSecret, walletContract, friendly, signTransfer, VERSIONS, DEFAULT_VERSION, isTestnetId } from '../shared/ton/core.js';
import { TON_CHAINS, tonAccount, tonSendBoc } from '../shared/ton/api.js';
import { i18nError } from '../shared/i18n.js';

const hex = (b) => Buffer.from(b).toString('hex');

/** Key pair and wallet version of an account of the active wallet, or null (e.g. an imported Ethereum key). */
export async function keyOf(address) {
  const src = await vault.familyKeySource('ton', address);
  if (!src) return null;
  if (src.phrase) return { ...hdKeyPair(src.phrase, src.index), version: DEFAULT_VERSION };
  return { ...tonKeyFromSecret(src.secret), version: src.version };
}

const addresses = (publicKey, version) => {
  const m = walletContract(publicKey, { version }).address, t = walletContract(publicKey, { version, testnet: true }).address;
  return { mainnet: { raw: m.toRawString(), friendly: friendly(m) }, testnet: { raw: t.toRawString(), friendly: friendly(t, { testnet: true }) } };
};

/** A key typed by the user: native TON phrase (24 words) or raw Ed25519 key. */
async function keyFromInput({ phrase, secret }) {
  if (phrase) { const k = await tonKeyFromPhrase(phrase); if (!k) throw i18nError('errors.invalidPhrase'); return k; }
  try { return tonKeyFromSecret(secret); } catch { throw i18nError('errors.invalidPrivateKey'); }
}

/**
 * Signs and broadcasts messages from an account of the active wallet (the caller has checked the password).
 * messages: [{ to (any address format), value (nanoGRAM, string), bounce, body? (base64 BoC), init? (base64 StateInit) }];
 * sendAll: whole balance; mode: send mode asked by the service that built the messages; validUntil: unix seconds after
 * which the wallet refuses the message (at most 5 minutes from now).
 * -> { hash (base64, of the message as indexed), seqno (before), wallet (raw), boc (base64, the external message) }
 */
export async function signAndBroadcast({ from, chainId, messages, sendAll, mode, validUntil }) {
  const chain = TON_CHAINS[chainId];
  if (!chain) throw i18nError('ton.err.network');
  const k = await keyOf(from);
  if (!k) throw i18nError('errors.accountUnavailable');
  const wallet = walletContract(k.publicKey, { version: k.version, testnet: isTestnetId(chainId) });
  const acc = await tonAccount(chain, wallet.address.toString());
  const deployed = acc.status === 'active';
  const max = Math.floor(Date.now() / 1000) + 300;
  const signed = signTransfer({
    wallet, secretKey: k.secretKey, seqno: deployed ? acc.seqno : 0, deployed, sendAll: !!sendAll, mode: Number.isInteger(mode) ? mode : undefined,
    timeout: Number.isFinite(validUntil) ? Math.min(Math.floor(validUntil), max) : max,
    messages: messages.map((m) => ({
      to: Address.parse(m.to), value: BigInt(m.value), bounce: !!m.bounce, body: m.body ? Cell.fromBase64(m.body) : undefined,
      init: m.init ? loadStateInit(Cell.fromBase64(m.init).beginParse()) : undefined,
    })),
  });
  const r = await tonSendBoc(chain, signed.boc);
  return { hash: r.hash || Buffer.from(signed.hash, 'hex').toString('base64'), seqno: deployed ? acc.seqno : 0, wallet: wallet.address.toRawString(), boc: signed.boc };
}

export const tonHandlers = {
  /** { [account address]: { version, publicKey, mainnet: { raw, friendly }, testnet: {...} } } for the active wallet. */
  async tonAccounts() {
    const out = {};
    for (const a of await vault.activeAccounts()) {
      const k = await keyOf(a.address).catch(() => null);
      if (k) out[a.address] = { version: k.version, publicKey: hex(k.publicKey), ...addresses(k.publicKey, k.version) };
    }
    return out;
  },

  /**
   * Signs and broadcasts a transfer from an account (after the password / fingerprint, like any send).
   * messages: [{ to (any address format), value (nanoGRAM, string), bounce, body? (base64 BoC), init? (base64 StateInit) }];
   * sendAll: whole balance; mode: send mode asked by the service that built the messages.
   * -> { hash (base64, of the message as indexed), seqno (before), wallet (raw) }
   */
  async tonSend({ from, chainId, messages, sendAll, mode, password }) {
    await vault.verifyPassword(password);
    const { boc: _, ...sent } = await signAndBroadcast({ from, chainId, messages, sendAll, mode });
    return sent;
  },

  /** Wallet addresses (mainnet) of a key from another TON app, per contract version: to find the one in use. */
  async tonInspectKey(input) {
    const k = await keyFromInput(input);
    return { publicKey: hex(k.publicKey), versions: VERSIONS.map((version) => ({ version, ...addresses(k.publicKey, version) })) };
  },

  /** Imports a wallet from another TON app as a TON account of the active wallet. */
  async tonImport({ phrase, secret, version, name }) {
    if (!VERSIONS.includes(version)) throw i18nError('errors.invalidPrivateKey');
    const k = await keyFromInput({ phrase, secret });
    const address = walletContract(k.publicKey, { version }).address.toRawString();
    return vault.addFamilyAccount('ton', { address, secret: hex(k.secretKey.subarray(0, 32)), version }, name);
  },
};
