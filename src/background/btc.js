// Bitcoin in the background (registered by src/background/chainModules.js): the accounts' public keys,
// signing and broadcasting, speed up / cancel (RBF) and speeding up a payment on its way in (CPFP), importing wallets
// from other Bitcoin apps. Keys never leave the background: the screens get the accounts' extended public keys (to
// derive addresses) and send here a plan of the transaction. Before signing, every coin spent must be the account's,
// every output said to come back to the account must really be its own, the fee must be sane; a replacement must keep
// what the transaction it replaces paid to others (speed up) or pay nobody else (cancel), and pay more, as nodes ask.
//
// Accounts: every account of a recovery phrase is a full HD account, n-th account of BIP84 (bc1q…) and BIP86 (bc1p…)
// - m/84'/0'/n', m/86'/0'/n' (coin 1 on test networks) - plus, for a phrase typed in (not created by Chakra), the older
// types BIP49 (3…) and BIP44 (1…) where funds of another app may be; an Ethereum private key (imported or generated) is also a Bitcoin key (one address per type);
// wallets imported from other Bitcoin apps are accounts of their own (families.js): a BIP39 phrase (one account of
// it), an Electrum seed, or a WIF key.
import * as vault from './vault.js';
import { i18nError } from '../shared/i18n.js';
import { local } from '../shared/ext.js';
import { BTC_CHAINS } from '../shared/btc/networks.js';
import {
  TYPES, RECEIVE_TYPES, seedOfPhrase, isBip39, cleanWords, hdAccountPublic, branchKey, electrumSeedType, electrumSeed, electrumPublic,
  decodeWif, isUncompressedWif, pubOf, toHex, fromHex, addressOf, decodeAddress, branchPub,
} from '../shared/btc/keys.js';
import { signPlan, MAX_FEE_RATE } from '../shared/btc/build.js';
import { broadcast, txStatus } from '../shared/btc/esplora.js';
import { SENT_KEY } from '../shared/btc/history.js';

const ALL_TYPES = Object.keys(TYPES);
const chainOf = (id) => { const c = BTC_CHAINS[id]; if (!c) throw i18nError('btc.err.network'); return c; };

// ------------------------------------------------------------ the accounts' public side
const singleBranches = (pub) => ALL_TYPES.map((type) => ({ type, pub: toHex(pub), single: true }));

/** The public account of a key source (see vault.familyKeySource). */
function publicOf(src, chain, id) {
  // a phrase created by Chakra never had the older address types (1…, 3…): only those of a phrase typed in are looked at
  if (src.phrase) return { id, kind: 'hd', ...hdAccountPublic(seedOfPhrase(src.phrase), chain.coin, src.index, src.generated ? RECEIVE_TYPES : ALL_TYPES), receive: RECEIVE_TYPES };
  if (src.evmKey) return { id, kind: 'single', fp: null, branches: singleBranches(pubOf(fromHex(src.evmKey))), receive: RECEIVE_TYPES };
  if (src.scheme === 'wif') return { id, kind: 'single', fp: null, branches: singleBranches(decodeWif(src.secret).publicKey), receive: RECEIVE_TYPES };
  if (src.scheme === 'bip39') return { id, kind: 'hd', ...hdAccountPublic(seedOfPhrase(src.secret), chain.coin, src.index || 0), receive: RECEIVE_TYPES };
  if (src.scheme === 'electrum') { const e = electrumPublic(src.secret); return e && { id, kind: 'electrum', fp: e.fp, branches: e.branches, receive: [e.branches[0].type] }; }
  return null;
}
const cache = new Map(); // `${chainId}|${account}|${sig}` -> public account (public data; the derivation is slow)
async function accountPublic(chain, address) {
  const src = await vault.familyKeySource('bitcoin', address, { evmKeys: true });
  if (!src) return null;
  const k = `${chain.id}|${address}|${src.phrase ? `p${src.index}${src.generated ? 'g' : ''}` : src.evmKey ? 'e' : src.scheme}`;
  if (!cache.has(k)) { if (cache.size > 200) cache.clear(); cache.set(k, publicOf(src, chain, address)); }
  return cache.get(k);
}

/** The private key of an address of an account, by its place: { privateKey, publicKey, type }. */
function keyFinder(src, chain, pub) {
  let seed = null;
  const seedOf = () => (seed ??= src.phrase ? seedOfPhrase(src.phrase) : src.scheme === 'bip39' ? seedOfPhrase(src.secret) : electrumSeed(src.secret));
  return ({ b, c, i }) => {
    const br = pub.branches[b];
    if (!br) throw i18nError('btc.err.notOwner');
    if (br.single) {
      const privateKey = src.evmKey ? fromHex(src.evmKey) : decodeWif(src.secret).privateKey;
      return { privateKey, publicKey: pubOf(privateKey), type: br.type };
    }
    if (!Number.isInteger(c) || !Number.isInteger(i) || c < 0 || c > 1 || i < 0 || i > 1_000_000) throw i18nError('btc.err.notOwner');
    return { ...branchKey(seedOf(), br.path, c, i), type: br.type };
  };
}

// ------------------------------------------------------------ checks before signing
/** Outputs said to come back to the account must be its own addresses. -> { others: [{ address, value }], own, data } */
function checkOutputs(plan, chain, find) {
  const others = [], own = [], data = [];
  for (const o of plan.outputs || []) {
    const value = BigInt(o.value);
    if (value < 0n) throw i18nError('btc.err.badPlan');
    if (o.script) {
      if (!/^6a/i.test(o.script) || value !== 0n) throw i18nError('btc.err.badPlan'); // only OP_RETURN data, worth nothing
      data.push(o);
    } else if (o.own) {
      const k = find(o.own);
      if (addressOf(k.type, k.publicKey, chain.net) !== o.address) throw i18nError('btc.err.notOwnChange');
      own.push({ address: o.address, value });
    } else {
      if (!decodeAddress(o.address, chain.net)) throw i18nError('btc.err.badAddress');
      others.push({ address: o.address, value });
    }
  }
  if (!plan.inputs?.length || !(plan.outputs || []).length) throw i18nError('btc.err.badPlan');
  return { others, own, data };
}
const outpoints = (plan) => plan.inputs.map((x) => `${x.txid}:${x.vout}`);
const sameMultiset = (a, b) => {
  const key = (x) => `${x.address}|${x.value}`;
  const m = new Map();
  for (const x of a) m.set(key(x), (m.get(key(x)) || 0) + 1);
  for (const x of b) { const n = m.get(key(x)); if (!n) return false; m.set(key(x), n - 1); }
  return true;
};

/** The transactions this wallet sent, kept for history, speed up and cancel (public data). */
async function logSent(chain, entry) {
  await local.update(SENT_KEY(chain), {}, (all) => {
    const out = { ...all, [entry.txid]: entry };
    const list = Object.values(out).sort((a, b) => b.time - a.time);
    return Object.fromEntries(list.filter((x, k) => k < 150 && Date.now() - x.time < 30 * 864e5).map((x) => [x.txid, x]));
  });
}

/**
 * Signs and broadcasts a plan of an account (src/shared/btc/build.js), after checking it. meta: { title, origin, mode
 * ('speedUp' | 'cancel' | 'cpfp'), replaces (txid), parent (txid, CPFP) }. -> { txid, fee, vsize }
 */
async function sendPlan(from, chainId, plan, meta = {}) {
  const chain = chainOf(chainId);
  const src = await vault.familyKeySource('bitcoin', from, { evmKeys: true });
  if (!src) throw i18nError('errors.accountUnavailable');
  const pub = await accountPublic(chain, from);
  const find = keyFinder(src, chain, pub);
  const outs = checkOutputs(plan, chain, find);
  let signed;
  try { signed = signPlan(plan, chain.net, find); } catch (e) { throw i18nError(/not of this account/.test(e.message) ? 'btc.err.notOwner' : 'btc.err.badPlan'); }
  const rate = Number(signed.fee) / signed.vsize;
  if (rate > MAX_FEE_RATE) throw i18nError('btc.err.feeTooHigh');
  if (signed.fee * 2n > signed.inValue && signed.fee > 50_000n) throw i18nError('btc.err.feeTooHigh');
  // a replacement (BIP125): the same coins, more fee, nothing taken from the people it paid
  const log = await local.get(SENT_KEY(chain), {});
  if (meta.replaces) {
    const orig = log[meta.replaces];
    if (!orig || orig.account !== from) throw i18nError('replace.err.unknown');
    if ((await txStatus(chain, orig.txid).catch(() => null))?.confirmed) throw i18nError('replace.err.done');
    const mine = new Set(outpoints(plan));
    if (!outpoints(orig.plan).every((op) => mine.has(op))) throw i18nError('btc.err.badPlan');
    if (signed.fee < BigInt(orig.fee) + BigInt(signed.vsize) || rate <= Number(orig.fee) / orig.vsize) throw i18nError('btc.replace.lowFee');
    const paid = orig.plan.outputs.filter((o) => o.address && !o.own).map((o) => ({ address: o.address, value: BigInt(o.value) }));
    if (meta.mode === 'cancel' ? outs.others.length > 0 : !sameMultiset(paid, outs.others) || outs.others.length !== paid.length) throw i18nError('btc.err.badPlan');
  } else if (meta.mode === 'cpfp') {
    if (!plan.inputs.some((x) => x.txid === meta.parent) || outs.others.length) throw i18nError('btc.err.badPlan');
  }
  const txid = await broadcast(chain, signed.hex).catch((e) => { throw i18nError('btc.err.broadcast', { reason: String(e.message || e).slice(0, 200) }); });
  const keep = (x) => ({ txid: x.txid, vout: x.vout, value: String(x.value), b: x.b, c: x.c, i: x.i, address: x.address });
  await logSent(chain, {
    txid, account: from, time: Date.now(), fee: signed.fee.toString(), vsize: signed.vsize, rate,
    plan: { inputs: plan.inputs.map(keep), outputs: plan.outputs.map((o) => ({ ...o, value: String(o.value) })), clean: !!plan.clean },
    title: String(meta.title || '').slice(0, 120), origin: meta.origin || 'Chakra',
    ...(meta.mode ? { mode: meta.mode } : {}), ...(meta.replaces ? { replaces: meta.replaces } : {}), ...(meta.parent ? { parent: meta.parent } : {}),
  });
  return { txid, fee: signed.fee.toString(), vsize: signed.vsize };
}

// ------------------------------------------------------------ wallets of other Bitcoin apps
/** What a text typed by the user is: a BIP39 phrase, an Electrum seed or a WIF key, with its public side. */
function inspect(text, chain) {
  const s = String(text || '').trim();
  if (isUncompressedWif(s)) throw i18nError('btc.import.uncompressed');
  if (s.split(/\s+/).length >= 12) {
    if (isBip39(s)) {
      const seed = seedOfPhrase(s);
      return { scheme: 'bip39', secret: cleanWords(s), accounts: [0, 1, 2].map((index) => ({ index, ...hdAccountPublic(seed, chain.coin, index) })) };
    }
    const type = electrumSeedType(s);
    if (type) return { scheme: 'electrum', secret: s.trim().split(/\s+/).join(' '), seedType: type, accounts: [{ index: 0, ...electrumPublic(s) }] };
    throw i18nError('errors.invalidPhrase');
  }
  let k;
  try { k = decodeWif(s); } catch { throw i18nError('errors.invalidPrivateKey'); }
  return { scheme: 'wif', secret: s, accounts: [{ index: 0, fp: null, branches: singleBranches(k.publicKey) }] };
}

/** { [account address]: public account } for the active wallet's accounts that have a Bitcoin key on a network. */
async function btcAccounts({ chainId }) {
  const chain = chainOf(chainId);
  const out = {};
  for (const a of await vault.activeAccounts()) {
    const p = await accountPublic(chain, a.address).catch(() => null);
    if (p) out[a.address] = p;
  }
  return out;
}

export const btcHandlers = {
  btcAccounts,

  /** Signs and broadcasts a send (also Ordinals, Runes, bridges) after the password. -> { txid, fee, vsize } */
  async btcSend({ from, chainId, plan, meta, password }) {
    await vault.verifyPassword(password);
    return sendPlan(from, chainId, plan, { ...meta, mode: meta?.mode === 'cpfp' ? 'cpfp' : undefined, replaces: undefined });
  },
  /** Speeds up or cancels a transaction this wallet sent (RBF). */
  async btcReplace({ from, chainId, txid, mode, plan, password }) {
    await vault.verifyPassword(password);
    if (mode !== 'speedUp' && mode !== 'cancel') throw i18nError('replace.err.unknown');
    const orig = (await local.get(SENT_KEY(chainOf(chainId)), {}))[txid];
    return sendPlan(from, chainId, plan, { mode, replaces: txid, title: orig?.title, origin: orig?.origin });
  },

  /** The accounts a phrase or a key of another Bitcoin app gives (public side), to look for its funds. */
  async btcInspectKey({ text, chainId }) {
    const r = inspect(text, chainOf(chainId));
    return { scheme: r.scheme, seedType: r.seedType || null, accounts: r.accounts };
  },
  /** Imports one account of another Bitcoin app's phrase, Electrum seed or key as a Bitcoin account of the active wallet. */
  async btcImport({ text, index = 0, name }) {
    const main = BTC_CHAINS[-8333];
    const r = inspect(text, main);
    const acc = r.accounts.find((x) => x.index === index) || r.accounts[0];
    const br = acc.branches[0];
    const address = br.single ? addressOf(br.type, fromHex(br.pub), main.net) : addressOf(br.type, branchPub(br.xpub, 0, 0), main.net);
    // the same key already in the wallet (e.g. as an Ethereum account): its Bitcoin addresses are there already
    const mine = await btcAccounts({ chainId: main.id });
    if (Object.values(mine).some((p) => p.branches.some((b) => (b.xpub && b.xpub === br.xpub) || (b.pub && b.pub === br.pub)))) throw i18nError('errors.accountExists');
    return vault.addFamilyAccount('bitcoin', { address, secret: r.secret, scheme: r.scheme, index: r.scheme === 'bip39' ? acc.index : 0 }, name);
  },
};
