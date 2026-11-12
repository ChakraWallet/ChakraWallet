// TON (The Open Network, coin: GRAM, formerly Toncoin) - keys, wallet contracts, addresses, message bodies.
// No network and no UI here. Android app only (registered by src/mobile/tonPlugin.js).
//
// Keys: from the wallet's recovery phrase (BIP-39) with SLIP-0010 Ed25519 at m/44'/607'/{i}' - the TON "multichain"
// standard - so account i has its Ethereum and its TON address from the same phrase. Native 24-word TON phrases and
// raw keys (other TON wallets) are handled by tonKeyFromPhrase / tonKeyFromSecret.
// Wallet contract: W5 (v5r1) by default; v4r2 and v3r2 for wallets imported from other apps.
import { Buffer } from './buffer.js';
import { Mnemonic } from 'ethers';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { keyPairFromSeed, mnemonicValidate, mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, internal, external, storeMessage, SendMode, Cell, storeStateInit } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton/dist/wallets/v5r1/WalletContractV5R1.js';
import { WalletContractV4 } from '@ton/ton/dist/wallets/v4/WalletContractV4.js';
import { WalletContractV3R2 } from '@ton/ton/dist/wallets/v3/r2.js';

export const TON_DECIMALS = 9;
export const VERSIONS = ['v5r1', 'v4r2', 'v3r2'];
export const DEFAULT_VERSION = 'v5r1';
const NET = { mainnet: -239, testnet: -3 }; // global ids (also the chain ids used in the app)
export const isTestnetId = (chainId) => Number(chainId) === NET.testnet;

// ------------------------------------------------------------ keys
const H = 0x80000000;
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

export const tonPath = (index) => [44 + H, 607 + H, (index >>> 0) + H];
export const TON_PATH_TEXT = (index) => `m/44'/607'/${index}'`;

const seeds = new Map(); // phrase -> BIP-39 seed (the PBKDF2 is the slow part; kept only in memory, in the background)
function bip39Seed(phrase) {
  let s = seeds.get(phrase);
  if (!s) {
    s = Uint8Array.from(Buffer.from(Mnemonic.fromPhrase(phrase).computeSeed().slice(2), 'hex'));
    seeds.set(phrase, s);
  }
  return s;
}
export const forgetSeeds = () => seeds.clear();

/** Key pair of account `index` of a BIP-39 phrase: { publicKey (32), secretKey (64, nacl format) } as Buffers. */
export function hdKeyPair(phrase, index) {
  return keyPairFromSeed(Buffer.from(slip10Ed25519(bip39Seed(phrase), tonPath(index))));
}

/** Native TON phrase (24 words, Tonkeeper & co.) -> key pair; null if the words aren't a valid TON phrase. */
export async function tonKeyFromPhrase(words) {
  const list = String(words).trim().toLowerCase().split(/\s+/);
  if (!(await mnemonicValidate(list))) return null;
  return mnemonicToPrivateKey(list);
}

/** Raw Ed25519 key: 32-byte seed or 64-byte secret key, hex or base64. */
export function tonKeyFromSecret(text) {
  const s = String(text).trim().replace(/^0x/, '');
  let b = /^[0-9a-fA-F]+$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (b.length === 64) b = b.subarray(0, 32);
  if (b.length !== 32) throw new Error('bad key');
  return keyPairFromSeed(b);
}

// ------------------------------------------------------------ wallet contracts
/** Wallet contract of a public key, for a version and network. */
export function walletContract(publicKey, { version = DEFAULT_VERSION, testnet = false } = {}) {
  const pk = Buffer.from(publicKey);
  if (version === 'v5r1') return WalletContractV5R1.create({ publicKey: pk, walletId: { networkGlobalId: testnet ? NET.testnet : NET.mainnet } });
  if (version === 'v4r2') return WalletContractV4.create({ workchain: 0, publicKey: pk });
  if (version === 'v3r2') return WalletContractV3R2.create({ workchain: 0, publicKey: pk });
  throw new Error(`unknown wallet version ${version}`);
}

/** User-friendly address. Receiving: non-bounceable (UQ…), as wallets show it; testnet addresses carry their flag. */
export const friendly = (address, { testnet = false, bounceable = false } = {}) => address.toString({ urlSafe: true, bounceable, testOnly: testnet });
export const rawOf = (address) => address.toRawString();

/** Parses an address typed or scanned by the user: { address, bounceable, testOnly, raw } or null. Accepts ton:// links. */
export function parseAddress(text) {
  let s = String(text || '').trim();
  const link = /^ton:\/\/transfer\/([^?#]+)/i.exec(s);
  if (link) s = decodeURIComponent(link[1]);
  try {
    if (Address.isFriendly(s)) {
      const f = Address.parseFriendly(s);
      return { address: f.address, bounceable: f.isBounceable, testOnly: f.isTestOnly, raw: false };
    }
    if (Address.isRaw(s)) return { address: Address.parseRaw(s), bounceable: true, testOnly: false, raw: true };
  } catch { /* invalid */ }
  return null;
}

/** ton://transfer/<address>?amount=<nano>&text=<comment> (wallets and QR codes). */
export function parseTonLink(text) {
  const m = /^ton:\/\/transfer\/([^?#]+)(?:\?([^#]*))?/i.exec(String(text || '').trim());
  if (!m) return null;
  const q = new URLSearchParams(m[2] || '');
  const amount = q.get('amount');
  return { address: decodeURIComponent(m[1]), amount: amount && /^\d+$/.test(amount) ? BigInt(amount) : null, text: q.get('text') || null, jetton: q.get('jetton') || null };
}
export const tonLink = (address, { amount, text } = {}) => `ton://transfer/${address}${amount || text ? '?' : ''}${new URLSearchParams({ ...(amount ? { amount: String(amount) } : {}), ...(text ? { text } : {}) })}`;

// ------------------------------------------------------------ message bodies
/** Text comment (op 0): exchanges ask for it on deposits. Long texts go into reference cells. */
export const commentCell = (text) => beginCell().storeUint(0, 32).storeStringTail(String(text)).endCell();

export const JETTON_TRANSFER = 0x0f8a7ea5;
export const DEFAULT_JETTON_FORWARD = 1n; // 1 nanoGRAM: the recipient's wallet gets the transfer notification (and the comment)
export const DEFAULT_JETTON_VALUE = 50_000_000n; // 0.05 GRAM attached to the sender's jetton wallet for fees; the rest comes back

/** Jetton transfer (TEP-74) sent to the sender's own jetton wallet. */
export function jettonTransferCell({ amount, to, responseTo, forwardAmount = DEFAULT_JETTON_FORWARD, comment, queryId = 0n, forwardPayload }) {
  const b = beginCell()
    .storeUint(JETTON_TRANSFER, 32).storeUint(queryId, 64)
    .storeCoins(amount).storeAddress(to).storeAddress(responseTo)
    .storeBit(0) // no custom payload
    .storeCoins(forwardAmount);
  const payload = forwardPayload || (comment ? commentCell(comment) : null);
  if (payload) b.storeBit(1).storeRef(payload); else b.storeBit(0);
  return b.endCell();
}

/** Comment of a cell body (op 0 + text), or null. */
export function readComment(cell) {
  try {
    const s = cell.beginParse();
    if (s.remainingBits < 32 || s.loadUint(32) !== 0) return null;
    return s.loadStringTail();
  } catch { return null; }
}

export const cellFromBase64 = (b64) => Cell.fromBase64(b64);
export const cellToBase64 = (cell) => cell.toBoc().toString('base64');

// ------------------------------------------------------------ transfers
/**
 * Signed external message for a wallet: messages [{ to: Address, value: bigint, bounce, body?: Cell, init? }].
 * sendAll (one message): sends the whole balance, fees included.
 * seqno 0 on a wallet that isn't deployed yet: its code goes with it (deployed by this first transfer).
 * -> { boc (base64), hash (hex of the external message cell, as explorers index it), wallet address }
 */
export function signTransfer({ wallet, secretKey, seqno, deployed, messages, timeout, sendAll, mode }) {
  const relaxed = messages.map((m) => internal({ to: m.to, value: m.value, bounce: !!m.bounce, body: m.body || undefined, init: m.init || undefined }));
  // sendAll: the whole balance goes, fees included (mode 128): the wallet is left at exactly zero.
  // mode: as asked by a service that built the messages (e.g. Relay: 1)
  const sendMode = mode ?? (sendAll ? SendMode.CARRY_ALL_REMAINING_BALANCE : SendMode.PAY_GAS_SEPARATELY) + SendMode.IGNORE_ERRORS;
  const args = { seqno, secretKey: Buffer.from(secretKey), messages: relaxed, sendMode };
  if (timeout) args.timeout = timeout;
  const body = wallet.createTransfer(args);
  const ext = external({ to: wallet.address, init: deployed ? undefined : wallet.init, body });
  const cell = beginCell().store(storeMessage(ext)).endCell();
  return { boc: cell.toBoc().toString('base64'), hash: cell.hash().toString('hex'), body };
}

/** Pieces the fee estimate needs (TON Center estimateFee): body and, before deployment, code and data. */
export function feeQuery(wallet, body, deployed) {
  return {
    address: wallet.address.toString(),
    body: body.toBoc().toString('base64'),
    init_code: deployed ? '' : wallet.init.code.toBoc().toString('base64'),
    init_data: deployed ? '' : wallet.init.data.toBoc().toString('base64'),
    ignore_chksig: true,
  };
}

/** StateInit cell of a wallet (base64), e.g. for a recipient-side check. */
export const stateInitOf = (wallet) => beginCell().store(storeStateInit(wallet.init)).endCell().toBoc().toString('base64');

export { Address };
