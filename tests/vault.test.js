// Vault: v1 -> v2 migration, isolated wallets, backups (active wallet only), removal without traces.
// One sequential scenario (each step builds on the previous one); PBKDF2 at 600k iterations makes it slow-ish.
import { storage, resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, HDNodeWallet } from 'ethers';
import * as v from '../src/background/vault.js';

const L = storage.local;
const ok = (c, m) => assert.ok(c, m);
const throws = (f, re, m) => assert.rejects(f, re, m);

test('vault scenario', { timeout: 300000 }, async () => {
  const A = 'test test test test test test test test test test test junk';
  const B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const PK = '0x' + '11'.repeat(32);
  
  // ---- migration from v1 vault
  const enc = new TextEncoder(); const b64 = (u) => Buffer.from(u).toString('base64');
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode('walletpw1'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ mnemonic: A, hdCount: 2, imported: [PK] })));
  const a0 = HDNodeWallet.fromPhrase(A, undefined, "m/44'/60'/0'/0/0").address, a1 = HDNodeWallet.fromPhrase(A, undefined, "m/44'/60'/0'/0/1").address, ak = new Wallet(PK).address;
  await L.set({ vault: { v: 1, kdf: 'pbkdf2-sha256', iter: 600000, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(ct)) },
    accounts: [{ address: a0, name: 'Uno', type: 'hd', index: 0 }, { address: a1, name: 'Due', type: 'hd', index: 1 }, { address: ak, name: 'Imp', type: 'imported' }], selected: a1,
    permissions: { 'https://x.io': { accounts: [a0.toLowerCase()], since: 1 } } });
  let st = await v.view();
  ok(st.wallets.length === 1 && ['Wallet principale', 'Main wallet'].includes(st.wallets[0].name) && st.accounts.length === 3 && st.selected === a1, 'metadata migration');
  await v.unlock('walletpw1');
  ok((await v.getSigner(ak)).address === ak && (await v.getSigner(a1)).address === a1, 'secrets migration: keys ok');
  await v.lock(); await v.unlock('walletpw1'); ok(true, 'vault v2 persisted and reopenable');
  ok(await v.revealMnemonic('walletpw1') === A, 'migrated wallet phrase');
  
  // ---- second wallet, isolation
  const w2 = await v.createWallet({ name: 'Lavoro', mnemonic: B });
  st = await v.view();
  ok(st.activeWallet === w2.id && st.accounts.length === 1 && st.wallets.length === 2, 'new wallet active and isolated');
  await throws(() => v.getSigner(a0), /wallet attivo|active wallet/, 'does not sign with an account of another wallet');
  await throws(() => v.selectAccount(a0), /non trovato|not found/, 'does not select an account of another wallet');
  await throws(() => v.createWallet({ mnemonic: A }), /già nel wallet «Wallet principale»|already in the wallet "Main wallet"/, 'duplicate phrase rejected');
  await throws(() => v.importPrivateKey(PK), /già nel wallet «Wallet principale»|already in the wallet "Main wallet"/, 'duplicate key rejected');
  const imp2 = await v.importPrivateKey('0x' + '22'.repeat(32), 'K2');
  ok(imp2.walletId === w2.id, 'key imported into the active wallet');
  const h2 = await v.addHdAccount();
  ok(h2.index === 1 && h2.name === 'Account 3', 'HD account in the active wallet');
  ok(await v.revealMnemonic('walletpw1') === B, 'active wallet phrase');
  const w3 = await v.createWallet({ privateKey: '0x' + '33'.repeat(32) });
  ok((await v.view()).wallets.find((w) => w.id === w3.id).hasSeed === false, 'wallet without a phrase');
  await throws(() => v.addHdAccount(), /non ha una frase|no recovery phrase|doesn't have a recovery phrase|has no recovery phrase/, 'no HD account without a phrase');
  await throws(() => v.revealMnemonic('walletpw1'), /non ha una frase|no recovery phrase|doesn't have a recovery phrase|has no recovery phrase/, 'no phrase to reveal');
  
  // ---- remove HD account: index not reused
  await v.switchWallet(w2.id);
  await throws(() => v.removeAccount(h2.address, 'no'), /errata|Wrong password/, 'removal requires the password');
  await v.removeAccount(h2.address, 'walletpw1');
  const h3 = await v.addHdAccount();
  ok(h3.index === 2, 'HD index not reused');
  await v.selectAccount(imp2.address);
  // ---- backup v2 roundtrip
  const bk = await v.exportBackup('walletpw1', 'backuppw1');
  ok(bk.startsWith('CHAKRA-BACKUP-2:'), 'v2 format');
  const before = (await v.view()).wallets.filter((w) => w.id === w2.id).map((w) => [w.name, w.count]);
  
  // ---- remove wallet: no traces
  await v.switchWallet(st.wallets[0].id);
  ok((await v.view()).selected === a1, 'selection remembered per wallet');
  await L.set({ txlog: { [`1:${a0.toLowerCase()}`]: [1], [`1:${imp2.address.toLowerCase()}`]: [2] }, permissions: { 'https://x.io': { accounts: [a0.toLowerCase(), imp2.address.toLowerCase()], since: 1 } } });
  const firstId = st.wallets[0].id;
  await v.removeWallet(firstId, 'walletpw1');
  const d = JSON.stringify(L.dump());
  ok(!d.toLowerCase().includes(a0.toLowerCase().slice(2)) && !d.toLowerCase().includes(ak.toLowerCase().slice(2)) && !d.includes(firstId), 'no trace of the removed wallet in storage.local');
  ok((await v.view()).activeWallet !== firstId, 'switches to another wallet');
  await v.lock(); await v.unlock('walletpw1');
  await throws(() => v.exportPrivateKey(a0, 'walletpw1'), /non trovato|not found/, 'keys removed from the vault');
  // remove remaining: last returns empty
  await v.removeWallet(w3.id, 'walletpw1');
  const r = await v.removeWallet(w2.id, 'walletpw1');
  ok(r.empty === true, 'last wallet -> reset required');
  
  // ---- restore v2 on fresh install
  await reset();
  const rr = await v.restoreVault('nuovapw12', bk, 'backuppw1');
  const after = (await v.view()).wallets.map((w) => [w.name, w.count]);
  ok(JSON.stringify(after) === JSON.stringify(before) && rr.created === 1, 'backup holds only the active wallet: ' + JSON.stringify(after));
  ok((await v.view()).accounts.some((a) => a.name === 'K2'), 'account names restored');
  // import into a vault with other wallets: becomes a new wallet, others untouched
  await reset();
  await v.createVault('walletpw1', A, 'Mio');
  await v.addHdAccount('Secondo');
  const snap = JSON.stringify((await v.view()).accounts);
  const ib = await v.importBackup(bk, 'backuppw1');
  const vw = await v.view();
  ok(ib.created === 1 && ib.added === 3 && vw.wallets.length === 2 && JSON.stringify(vw.accounts) === snap, 'import: new wallet, existing wallet untouched');
  // import again: nothing added
  const again = await v.importBackup(bk, 'backuppw1');
  ok(again.added === 0 && again.created === 0, 'reimport does not duplicate');
  // ---- import v1 backup into existing wallet: becomes new wallet (different seed), merge (same seed)
  await reset();
  await v.createVault('walletpw1', B, 'Mio');
  const v1 = 'CHAKRA-BACKUP-1:' + await (async () => {
    const s2 = crypto.getRandomValues(new Uint8Array(16)), iv2 = crypto.getRandomValues(new Uint8Array(12));
    const bk2 = await crypto.subtle.importKey('raw', enc.encode('backuppw1'), 'PBKDF2', false, ['deriveKey']);
    const k2 = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: s2, iterations: 600000, hash: 'SHA-256' }, bk2, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const c2 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, k2, enc.encode(JSON.stringify({ mnemonic: A, hdCount: 2, hdNames: { 0: 'Uno' }, imported: [{ pk: PK, name: 'Imp', type: 'imported' }] })));
    return b64(enc.encode(JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', iter: 600000, salt: b64(s2), iv: b64(iv2), data: b64(new Uint8Array(c2)) })));
  })();
  const i1 = await v.importBackup(v1, 'backuppw1');
  st = await v.view();
  ok(i1.created === 1 && i1.added === 3 && st.wallets.length === 2 && st.activeWallet === st.wallets[0].id, 'v1 backup with a different phrase -> new wallet, active one unchanged');
  await v.switchWallet(st.wallets[1].id);
  ok((await v.view()).accounts.map((a) => a.name).join() === 'Uno,Account 2,Imp', 'names and types from the v1 backup');
});
