// Encrypted key vault: PBKDF2-SHA256 (600k) + AES-256-GCM via WebCrypto.
// Decrypted material lives only in storage.session (memory, never written to disk) while unlocked.
//
// Multi-wallet ("tenant") model, one global password:
//   secrets (encrypted)  { v: 2, wallets: [{ id, mnemonic|null, hd: [index…], hdNext, imported: [pk…], [family]?: [{ address, secret, … }] }] }
//   ([family]: wallets imported from another app of one family of networks, e.g. ton: [{ address, secret, version }];
//    see background/families.js. The key of an HD account on another family comes from its phrase)
//   storage.local        wallets:      [{ id, name, hasSeed }]
//                        activeWallet: id            -> the UI, dapps and signing only see this wallet's accounts
//                        accounts:     [{ address, name, type, index?, walletId }]   (all wallets)
//                                      type <family> (e.g. 'ton'): an account of that family only, address as the family stores it
//                        selected:     address (in the active wallet)
//                        lastSelected: { walletId: address }
// An address belongs to exactly one wallet; a recovery phrase to at most one wallet.
import { HDNodeWallet, Mnemonic, Wallet, getAddress } from 'ethers';
import { local, session } from '../shared/ext.js';
import { t, i18nError } from '../shared/i18n.js';
import { familyKinds, familyOf } from './families.js';

const ITER = 600_000;
const enc = new TextEncoder();
const b64 = (buf) => { let s = ''; for (const c of new Uint8Array(buf)) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const HD_PATH = (i) => `m/44'/60'/0'/0/${i}`;
const lc = (a) => String(a || '').toLowerCase();
const newId = () => 'w' + crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 12);
const cleanPhrase = (m) => String(m || '').trim().toLowerCase().split(/\s+/).join(' ');
const MAX_HD = 100_000;

async function deriveKey(password, salt, iterations = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}

async function encryptWith(key, salt, secrets) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secrets)));
  return { v: 1, kdf: 'pbkdf2-sha256', iter: ITER, salt: b64(salt), iv: b64(iv), data: b64(ct) };
}

function deriveHd(mnemonic, index) {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, HD_PATH(index));
}

// ------------------------------------------------------------------ migration from the single-wallet format
// Metadata (no secrets needed): runs once, gives every existing account to "Wallet principale".
async function migrateMeta() {
  if (await local.get('wallets', null)) return;
  const accounts = await local.get('accounts', null);
  if (!accounts) return;
  const id = newId();
  await local.set('wallets', [{ id, name: t('vault.mainWallet'), hasSeed: accounts.some((a) => a.type === 'hd') }]);
  await local.set('accounts', accounts.map((a) => ({ ...a, walletId: id })));
  await local.set('activeWallet', id);
}
let migrating = null;
const ready = () => (migrating ??= migrateMeta().finally(() => { migrating = null; }));

// Secrets v1 { mnemonic, hdCount, imported } -> v2 (in memory; persisted by unlock)
async function normalize(secrets) {
  if (secrets?.v === 2) return { secrets, migrated: false };
  await ready();
  const id = (await local.get('wallets', []))[0]?.id || newId();
  const hdCount = secrets.mnemonic ? secrets.hdCount || 0 : 0;
  return {
    migrated: true,
    secrets: { v: 2, wallets: [{ id, mnemonic: secrets.mnemonic || null, hd: [...Array(hdCount).keys()], hdNext: hdCount, imported: secrets.imported || [] }] },
  };
}

async function decryptVault(vault, password) {
  const salt = unb64(vault.salt);
  const key = await deriveKey(password, salt);
  let raw;
  try {
    raw = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data))));
  } catch {
    throw i18nError('errors.wrongPassword');
  }
  const { secrets, migrated } = await normalize(raw);
  return { secrets, key, salt, migrated };
}

function keysOf(secrets) {
  const keys = {};
  for (const w of secrets.wallets) {
    if (w.mnemonic && w.hd.length) {
      const root = HDNodeWallet.fromPhrase(w.mnemonic, undefined, "m/44'/60'/0'/0");
      for (const i of w.hd) { const k = root.deriveChild(i); keys[lc(k.address)] = k.privateKey; }
    }
    for (const pk of w.imported) keys[lc(new Wallet(pk).address)] = pk;
  }
  return keys;
}

async function openSession(secrets, key, salt) {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  await session.set('wallet', { unlocked: true, keys: keysOf(secrets), secrets, jwk, salt: b64(salt) });
}

async function getSession() {
  const s = await session.get('wallet', null);
  if (!s?.unlocked) throw i18nError('errors.walletLocked', null, { code: 4100 });
  return s;
}

async function persist(s) {
  s.keys = keysOf(s.secrets);
  const key = await crypto.subtle.importKey('jwk', s.jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  await local.set('vault', await encryptWith(key, unb64(s.salt), s.secrets));
  await session.set('wallet', s);
}

// ------------------------------------------------------------------ metadata helpers
async function meta() {
  await ready();
  const [wallets, accounts, active] = await Promise.all([local.get('wallets', []), local.get('accounts', []), local.get('activeWallet', null)]);
  return { wallets, accounts, active: wallets.some((w) => w.id === active) ? active : wallets[0]?.id || null };
}

function ownerName(m, address) {
  const acc = m.accounts.find((a) => lc(a.address) === lc(address));
  return m.wallets.find((w) => w.id === acc?.walletId)?.name || t('vault.anotherWallet');
}

const nameIn = (accounts, walletId) => t('vault.accountN', { n: accounts.filter((a) => a.walletId === walletId).length + 1 });

async function activate(walletId) {
  const m = await meta();
  const accs = m.accounts.filter((a) => a.walletId === walletId);
  // remember the selection of the wallet we are leaving
  const cur = await local.get('selected', null);
  const curAcc = m.accounts.find((a) => a.address === cur);
  if (curAcc) await local.update('lastSelected', {}, (x) => ({ ...x, [curAcc.walletId]: curAcc.address }));
  const last = (await local.get('lastSelected', {}))[walletId];
  await local.set('activeWallet', walletId);
  await local.set('selected', (accs.find((a) => lc(a.address) === lc(last)) || accs[0])?.address || null);
}

// Removes every local trace of these addresses (accounts list, dapp permissions, local tx log, last selection)
async function purgeAddresses(addresses) {
  const set = new Set(addresses.map(lc));
  if (!set.size) return;
  await local.update('accounts', [], (l) => l.filter((a) => !set.has(lc(a.address))));
  await local.update('permissions', {}, (perms) => {
    const out = {};
    for (const [origin, p] of Object.entries(perms)) {
      const rest = (p.accounts || []).filter((a) => !set.has(lc(a)));
      if (rest.length) out[origin] = { ...p, accounts: rest };
    }
    return out;
  });
  await local.update('txlog', {}, (log) => Object.fromEntries(Object.entries(log).filter(([k]) => !set.has(k.split(':')[1]))));
  await local.update('txpending', {}, (all) => Object.fromEntries(Object.entries(all).filter(([, x]) => !set.has(lc(x.from)))));
  await local.update('lastSelected', {}, (m) => Object.fromEntries(Object.entries(m).filter(([, a]) => !set.has(lc(a)))));
}

// ------------------------------------------------------------------ public API

export async function isInitialized() { return !!(await local.get('vault', null)); }
export async function isUnlocked() { return !!(await session.get('wallet', null))?.unlocked; }

export function generateMnemonic() { return Wallet.createRandom().mnemonic.phrase; }

// What the UI and dapps see: wallets + accounts of the active wallet only
export async function view() {
  const m = await meta();
  const accounts = m.accounts.filter((a) => a.walletId === m.active);
  let selected = await local.get('selected', null);
  if (!accounts.some((a) => a.address === selected)) selected = accounts[0]?.address || null;
  const wallets = m.wallets.map((w) => ({ ...w, count: m.accounts.filter((a) => a.walletId === w.id).length }));
  return { wallets, activeWallet: m.active, accounts, selected };
}

export async function activeAccounts() { return (await view()).accounts; }

export async function createVault(password, mnemonic, name = t('vault.walletN', { n: 1 })) {
  if (!password || password.length < 8) throw i18nError('errors.passwordTooShort');
  if (await isInitialized()) throw i18nError('errors.alreadyInitialized');
  const phrase = cleanPhrase(mnemonic);
  if (!Mnemonic.isValidMnemonic(phrase)) throw i18nError('errors.invalidPhrase');
  const id = newId();
  const secrets = { v: 2, wallets: [{ id, mnemonic: phrase, hd: [0], hdNext: 1, imported: [] }] };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  await local.set('vault', await encryptWith(key, salt, secrets));
  const first = deriveHd(phrase, 0).address;
  await local.set('wallets', [{ id, name: name.trim().slice(0, 32) || t('vault.walletN', { n: 1 }), hasSeed: true }]);
  await local.set('accounts', [{ address: first, name: t('vault.accountN', { n: 1 }), type: 'hd', index: 0, walletId: id }]);
  await local.set('activeWallet', id);
  await local.set('selected', first);
  await openSession(secrets, key, salt);
  return first;
}

export async function unlock(password) {
  const vault = await local.get('vault', null);
  if (!vault) throw i18nError('errors.notInitialized');
  const { secrets, key, salt, migrated } = await decryptVault(vault, password);
  if (migrated) await local.set('vault', await encryptWith(key, salt, secrets));
  await openSession(secrets, key, salt);
}

export async function lock() { await session.clear(); }

export async function verifyPassword(password) {
  if (!password) throw i18nError('errors.wrongPassword');
  const vault = await local.get('vault', null);
  if (!vault) throw i18nError('errors.notInitialized');
  return decryptVault(vault, password);
}

export async function changePassword(oldPw, newPw) {
  if (!newPw || newPw.length < 8) throw i18nError('errors.newPasswordTooShort');
  const { secrets } = await verifyPassword(oldPw);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(newPw, salt);
  await local.set('vault', await encryptWith(key, salt, secrets));
  await openSession(secrets, key, salt);
}

// ------------------------------------------------------------------ wallets (tenants)

// New wallet from a generated/imported recovery phrase, or from a single private key (wallet without phrase).
export async function createWallet({ name, mnemonic, privateKey }) {
  const s = await getSession();
  const m = await meta();
  const id = newId();
  const w = { id, mnemonic: null, hd: [], hdNext: 0, imported: [] };
  let acc;
  if (mnemonic) {
    const phrase = cleanPhrase(mnemonic);
    if (!Mnemonic.isValidMnemonic(phrase)) throw i18nError('errors.invalidPhrase');
    const dup = s.secrets.wallets.find((x) => x.mnemonic === phrase);
    if (dup) throw i18nError('errors.phraseInWallet', { name: m.wallets.find((x) => x.id === dup.id)?.name });
    const addr = deriveHd(phrase, 0).address;
    if (s.keys[lc(addr)]) throw i18nError('errors.phraseFirstAccountInWallet', { name: ownerName(m, addr) });
    Object.assign(w, { mnemonic: phrase, hd: [0], hdNext: 1 });
    acc = { address: addr, name: t('vault.accountN', { n: 1 }), type: 'hd', index: 0, walletId: id };
  } else {
    const k = parseKey(privateKey);
    if (s.keys[lc(k.address)]) throw i18nError('errors.accountInWallet', { name: ownerName(m, k.address) });
    w.imported.push(k.privateKey);
    acc = { address: k.address, name: t('vault.accountN', { n: 1 }), type: 'imported', walletId: id };
  }
  s.secrets.wallets.push(w);
  await persist(s);
  const wname = String(name || '').trim().slice(0, 32) || t('vault.walletN', { n: m.wallets.length + 1 });
  await local.set('wallets', [...m.wallets, { id, name: wname, hasSeed: !!w.mnemonic }]);
  await local.set('accounts', [...m.accounts, acc]);
  await activate(id);
  return { id, name: wname };
}

export async function switchWallet(id) {
  const m = await meta();
  if (!m.wallets.some((w) => w.id === id)) throw i18nError('errors.walletNotFound');
  await activate(id);
}

export async function renameWallet(id, name) {
  const n = String(name || '').trim().slice(0, 32);
  if (!n) throw i18nError('errors.invalidName');
  await local.update('wallets', [], (l) => l.map((w) => (w.id === id ? { ...w, name: n } : w)));
}

// Deletes the wallet's phrase and keys from the vault and every local trace of its accounts.
// Returns { empty: true } when it was the last wallet (the caller then resets everything).
export async function removeWallet(id, password) {
  await verifyPassword(password);
  const s = await getSession();
  const m = await meta();
  if (!m.wallets.some((w) => w.id === id)) throw i18nError('errors.walletNotFound');
  const rest = m.wallets.filter((w) => w.id !== id);
  if (!rest.length) return { empty: true };
  s.secrets.wallets = s.secrets.wallets.filter((w) => w.id !== id);
  await persist(s);
  await purgeAddresses(m.accounts.filter((a) => a.walletId === id).map((a) => a.address));
  await local.set('wallets', rest);
  await local.update('lastSelected', {}, (x) => { const n = { ...x }; delete n[id]; return n; });
  if (m.active === id) await activate(rest[0].id);
  return { empty: false };
}

export async function revealMnemonic(password) {
  const { secrets } = await verifyPassword(password);
  const { active } = await meta();
  const w = secrets.wallets.find((x) => x.id === active);
  if (!w?.mnemonic) throw i18nError('errors.noPhrase');
  return w.mnemonic;
}

// ------------------------------------------------------------------ accounts (always in the active wallet)

function parseKey(pk) {
  const t = String(pk || '').trim();
  try { return new Wallet(t.startsWith('0x') ? t : '0x' + t); } catch { throw i18nError('errors.invalidPrivateKey'); }
}

async function activeSecrets(s) {
  const { active } = await meta();
  const w = s.secrets.wallets.find((x) => x.id === active);
  if (!w) throw i18nError('errors.noActiveWallet');
  return w;
}

export async function addHdAccount(name) {
  const s = await getSession();
  const w = await activeSecrets(s);
  if (!w.mnemonic) throw i18nError('errors.noPhraseAddAccount');
  const m = await meta();
  let index = w.hdNext;
  // skip indexes whose address already lives in another wallet as an imported key
  while (s.keys[lc(deriveHd(w.mnemonic, index).address)] && index < MAX_HD) index++;
  const addr = deriveHd(w.mnemonic, index).address;
  w.hd.push(index);
  w.hdNext = index + 1;
  await persist(s);
  const acc = { address: addr, name: name || nameIn(m.accounts, w.id), type: 'hd', index, walletId: w.id };
  await local.set('accounts', [...m.accounts, acc]);
  return acc;
}

export async function importPrivateKey(pk, name, type = 'imported') {
  const s = await getSession();
  const w = await activeSecrets(s);
  const k = parseKey(pk);
  const m = await meta();
  if (s.keys[lc(k.address)]) {
    const owner = m.accounts.find((a) => lc(a.address) === lc(k.address))?.walletId;
    throw owner === w.id ? i18nError('errors.accountExists') : i18nError('errors.accountInWallet', { name: ownerName(m, k.address) });
  }
  w.imported.push(k.privateKey);
  await persist(s);
  const acc = { address: k.address, name: name || nameIn(m.accounts, w.id), type, walletId: w.id };
  await local.set('accounts', [...m.accounts, acc]);
  return acc;
}

export async function createRandomAccount(name) {
  return importPrivateKey(Wallet.createRandom().privateKey, name, 'generated');
}

// Any account can be removed (HD indexes are not reused). The last account of a wallet: remove the wallet instead.
export async function removeAccount(address, password) {
  await verifyPassword(password);
  const s = await getSession();
  const m = await meta();
  const acc = m.accounts.find((a) => lc(a.address) === lc(address));
  if (!acc) return;
  if (m.accounts.filter((a) => a.walletId === acc.walletId).length <= 1) throw i18nError('errors.lastAccount');
  const w = s.secrets.wallets.find((x) => x.id === acc.walletId);
  if (w) {
    if (acc.type === 'hd') w.hd = w.hd.filter((i) => i !== acc.index);
    else if (familyOf(acc.type)) w[acc.type] = (w[acc.type] || []).filter((x) => lc(x.address) !== lc(address));
    else { const pk = s.keys[lc(address)]; w.imported = w.imported.filter((k) => k !== pk); }
  }
  await persist(s);
  await purgeAddresses([address]);
  if (lc(await local.get('selected')) === lc(address)) await activate(acc.walletId);
}

export async function selectAccount(address) {
  const { accounts, activeWallet } = await view();
  const acc = accounts.find((a) => lc(a.address) === lc(address));
  if (!acc) throw i18nError('errors.accountNotInActiveWallet');
  await local.set('selected', acc.address);
  await local.update('lastSelected', {}, (x) => ({ ...x, [activeWallet]: acc.address }));
}

export async function exportPrivateKey(address, password) {
  await verifyPassword(password);
  const s = await getSession();
  // an account of another family only: its key as that family stores it (TON: the Ed25519 key, hex)
  const own = s.secrets.wallets.flatMap((w) => familyKinds().flatMap((k) => w[k] || [])).find((x) => lc(x.address) === lc(address));
  if (own) return own.secret;
  const pk = s.keys[lc(address)];
  if (!pk) throw i18nError('errors.accountNotFound');
  return pk;
}

// Only accounts of the active wallet can sign
// ------------------------------------------------------------------ extra secrets (encrypted with the wallets)
/** Small secrets of integrations (e.g. a Polymarket relayer key), stored inside the encrypted vault. */
export async function setExtraSecret(name, value) {
  const s = await getSession();
  const extra = { ...(s.secrets.extra || {}) };
  if (value == null || value === '') delete extra[name]; else extra[name] = String(value);
  s.secrets = { ...s.secrets, extra };
  await persist(s);
}
export async function getExtraSecret(name) { return (await getSession()).secrets.extra?.[name] ?? null; }

// ------------------------------------------------------------------ other families (TON...: background/families.js)
/**
 * Where an account's key for a family comes from (background only, never sent to the UI): { phrase, index } for
 * accounts of the recovery phrase, the stored entry ({ secret, ... }) for accounts of that family only, null otherwise
 * (e.g. an imported Ethereum key has no TON key). evmKeys: the family uses Ethereum's curve (Tron), so an imported or
 * generated Ethereum key is its key too: { evmKey } for those accounts. Only accounts of the active wallet.
 */
export async function familyKeySource(kind, address, { evmKeys = false } = {}) {
  const s = await getSession();
  const m = await meta();
  const acc = m.accounts.find((a) => lc(a.address) === lc(address) && a.walletId === m.active);
  if (!acc) return null;
  const w = s.secrets.wallets.find((x) => x.id === acc.walletId);
  if (acc.type === 'hd' && w?.mnemonic) return { phrase: w.mnemonic, index: acc.index };
  if (acc.type === kind) { const x = (w?.[kind] || []).find((k) => lc(k.address) === lc(address)); if (!x) return null; const { address: _, ...rest } = x; return rest; }
  if (evmKeys && !familyOf(acc.type) && s.keys[lc(address)]) return { evmKey: s.keys[lc(address)] };
  return null;
}

/** Adds an account of one family only to the active wallet (entry checked by the family's module, then by its clean()). */
export async function addFamilyAccount(kind, entry, name) {
  const x = familyOf(kind)?.clean(entry);
  if (!x) throw i18nError('errors.invalidPrivateKey');
  const s = await getSession();
  const w = await activeSecrets(s);
  const m = await meta();
  const dup = m.accounts.find((a) => lc(a.address) === lc(x.address));
  if (dup) throw dup.walletId === w.id ? i18nError('errors.accountExists') : i18nError('errors.accountInWallet', { name: ownerName(m, x.address) });
  (w[kind] ||= []).push(x);
  await persist(s);
  const acc = { address: x.address, name: name || nameIn(m.accounts, w.id), type: kind, walletId: w.id };
  await local.set('accounts', [...m.accounts, acc]);
  return acc;
}

export async function getSigner(address) {
  const s = await getSession();
  const accs = await activeAccounts();
  const pk = accs.some((a) => lc(a.address) === lc(address)) && s.keys[lc(address)];
  if (!pk) throw i18nError('errors.accountUnavailable', null, { code: 4100 });
  return new Wallet(pk);
}

// ------------------------------------------------------------------ text backup
// One line of text, same format on extension and app:
//   CHAKRA-BACKUP-2:<base64(JSON {v,kdf,iter,salt,iv,data})>
//   data = AES-GCM({ wallets: [{ name, mnemonic, hdNext, hd: [{index,name}], imported: [{pk,name,type}], [family]: [...] }] })
// Export contains only the ACTIVE wallet (its phrase and all its keys); the list format allows more on import.
// Version 1 (single wallet: { mnemonic, hdCount, hdNames, imported }) is still accepted. On import only the version
// counts: backups made by the app under its earlier name (another NAME-BACKUP-n: prefix) are read too.
const PREFIX_V2 = 'CHAKRA-BACKUP-2:';
const BACKUP_PREFIX = /^[A-Z][A-Z0-9]*-BACKUP-([12]):/;

export async function exportBackup(walletPassword, backupPassword) {
  if (!backupPassword || backupPassword.length < 8) throw i18nError('errors.backupPasswordTooShort');
  const { secrets } = await verifyPassword(walletPassword);
  const m = await meta();
  const byAddr = new Map(m.accounts.map((a) => [lc(a.address), a]));
  const wallets = secrets.wallets.filter((w) => w.id === m.active).map((w) => ({
    name: m.wallets.find((x) => x.id === w.id)?.name || 'Wallet',
    mnemonic: w.mnemonic,
    hdNext: w.hdNext,
    hd: w.hd.map((index) => ({ index, name: byAddr.get(lc(deriveHd(w.mnemonic, index).address))?.name || null })),
    imported: w.imported.map((pk) => { const a = byAddr.get(lc(new Wallet(pk).address)); return { pk, name: a?.name || null, type: a?.type || 'imported' }; }),
    ...Object.fromEntries(familyKinds().map((k) => [k, (w[k] || []).map((x) => ({ ...x, name: byAddr.get(lc(x.address))?.name || null }))])),
  }));
  if (!wallets.length) throw i18nError('errors.noActiveWallet');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const blob = await encryptWith(await deriveKey(backupPassword, salt), salt, { wallets, created: Date.now() });
  return PREFIX_V2 + b64(enc.encode(JSON.stringify(blob)));
}

async function decodeBackup(text, backupPassword) {
  const txt = String(text || '').replace(/\s+/g, '');
  const m = BACKUP_PREFIX.exec(txt);
  if (!m) throw i18nError('errors.backupUnrecognized');
  const version = Number(m[1]);
  let blob;
  try { blob = JSON.parse(new TextDecoder().decode(unb64(txt.slice(m[0].length)))); } catch { throw i18nError('errors.backupDamaged'); }
  const iter = Number(blob.iter);
  if (blob.v !== 1 || blob.kdf !== 'pbkdf2-sha256' || !(iter >= 100_000 && iter <= 10_000_000)) throw i18nError('errors.backupUnsupported');
  const key = await deriveKey(backupPassword, unb64(blob.salt), iter);
  let p;
  try {
    p = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.data))));
  } catch { throw i18nError('errors.wrongBackupPassword'); }
  const raw = version === 1
    ? [{ name: t('vault.importedWallet'), mnemonic: p.mnemonic, hdNext: p.hdCount, hd: [...Array(p.mnemonic ? Math.max(1, p.hdCount | 0) : 0).keys()].map((index) => ({ index, name: p.hdNames?.[index] || null })), imported: p.imported || [] }]
    : p.wallets || [];
  try {
    return raw.map((w) => {
      const mnemonic = w.mnemonic ? cleanPhrase(w.mnemonic) : null;
      if (mnemonic && !Mnemonic.isValidMnemonic(mnemonic)) throw new Error();
      const hd = mnemonic ? (w.hd || []).filter((h) => Number.isInteger(h.index) && h.index >= 0 && h.index < MAX_HD) : [];
      return {
        name: String(w.name || t('vault.importedWallet')).slice(0, 32),
        mnemonic,
        hdNext: Math.max(Number(w.hdNext) | 0, ...hd.map((h) => h.index + 1), 0),
        hd,
        imported: (w.imported || []).map((x) => { const k = new Wallet(x.pk); return { pk: k.privateKey, address: k.address, name: x.name || null, type: x.type === 'generated' ? 'generated' : 'imported' }; }),
        // accounts of other families: the entries their family accepts (others dropped)
        ...Object.fromEntries(familyKinds().map((k) => [k, (w[k] || []).map((x) => { const c = familyOf(k).clean(x); return c && { ...c, name: x.name || null }; }).filter(Boolean)])),
      };
    });
  } catch { throw i18nError('errors.backupInvalid'); }
}

// Merges backup wallets into (secrets, wallets meta, accounts meta). Same phrase -> same wallet (adds missing
// accounts); new phrase or phrase-less wallet -> new wallet. Addresses already present anywhere are skipped.
function mergeBackup(secrets, walletsMeta, accounts, backup) {
  const keys = keysOf(secrets);
  let added = 0; let created = 0;
  for (const bw of backup) {
    let w = bw.mnemonic && secrets.wallets.find((x) => x.mnemonic === bw.mnemonic);
    const isNew = !w;
    if (isNew) w = { id: newId(), mnemonic: bw.mnemonic, hd: [], hdNext: 0, imported: [] };
    const newAccs = [];
    const nm = () => t('vault.accountN', { n: accounts.filter((a) => a.walletId === w.id).length + newAccs.length + 1 });
    for (const h of bw.hd) {
      if (w.hd.includes(h.index)) continue;
      const addr = deriveHd(bw.mnemonic, h.index).address;
      if (keys[lc(addr)]) continue;
      w.hd.push(h.index); keys[lc(addr)] = true;
      newAccs.push({ address: addr, name: h.name || nm(), type: 'hd', index: h.index, walletId: w.id });
    }
    w.hdNext = Math.max(w.hdNext, bw.hdNext);
    for (const x of bw.imported) {
      if (keys[lc(x.address)]) continue;
      w.imported.push(x.pk); keys[lc(x.address)] = true;
      newAccs.push({ address: x.address, name: x.name || nm(), type: x.type, walletId: w.id });
    }
    for (const kind of familyKinds()) {
      for (const x of bw[kind] || []) {
        if (keys[lc(x.address)] || accounts.some((a) => lc(a.address) === lc(x.address))) continue;
        const { name, ...entry } = x;
        (w[kind] ||= []).push(entry); keys[lc(x.address)] = true;
        newAccs.push({ address: x.address, name: name || nm(), type: kind, walletId: w.id });
      }
    }
    if (isNew && !newAccs.length) continue;
    if (isNew) {
      secrets.wallets.push(w);
      let name = bw.name; let n = 2;
      while (walletsMeta.some((x) => x.name === name)) name = `${bw.name} (${n++})`;
      walletsMeta.push({ id: w.id, name, hasSeed: !!w.mnemonic });
      created++;
    }
    accounts.push(...newAccs);
    added += newAccs.length;
  }
  return { added, created };
}

// First run: build a new vault (protected by `password`) from a backup.
export async function restoreVault(password, text, backupPassword) {
  if (!password || password.length < 8) throw i18nError('errors.passwordTooShort');
  if (await isInitialized()) throw i18nError('errors.alreadyInitialized');
  const backup = await decodeBackup(text, backupPassword);
  const secrets = { v: 2, wallets: [] };
  const wallets = []; const accounts = [];
  const r = mergeBackup(secrets, wallets, accounts, backup);
  if (!r.added) throw i18nError('errors.backupEmpty');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  await local.set('vault', await encryptWith(key, salt, secrets));
  await local.set('wallets', wallets);
  await local.set('accounts', accounts);
  await activate(wallets[0].id);
  await openSession(secrets, key, salt);
  return r;
}

// Existing vault: adds what is missing. Returns { added, created }.
export async function importBackup(text, backupPassword) {
  const s = await getSession();
  const backup = await decodeBackup(text, backupPassword);
  const m = await meta();
  const wallets = [...m.wallets]; const accounts = [...m.accounts];
  const r = mergeBackup(s.secrets, wallets, accounts, backup);
  if (!r.added) return r;
  await persist(s);
  await local.set('wallets', wallets);
  await local.set('accounts', accounts);
  return r;
}

export { getAddress };
