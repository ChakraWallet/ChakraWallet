// TON in the vault: key source of each kind of account, TON-only accounts, backup round trip, removal.
import { storage, resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HDNodeWallet } from 'ethers';
import * as v from '../src/background/vault.js';
import { tonHandlers } from '../src/background/ton.js';
import { hdKeyPair, walletContract, friendly } from '../src/shared/ton/core.js';

const A = 'test test test test test test test test test test test junk';
const PK = '0x' + '22'.repeat(32);

test('TON accounts in the vault', { timeout: 300000 }, async () => {
  await reset();
  await v.createVault('walletpw1', A, 'Main');
  await v.unlock('walletpw1');
  const hd0 = HDNodeWallet.fromPhrase(A, undefined, "m/44'/60'/0'/0/0").address;
  const hd1 = (await v.addHdAccount('Two')).address;
  const imp = (await v.importPrivateKey(PK, 'Imp')).address;

  // key sources: HD -> phrase + index; imported Ethereum key -> none
  assert.deepEqual(await v.tonKeySource(hd0), { phrase: A, index: 0 });
  assert.deepEqual(await v.tonKeySource(hd1), { phrase: A, index: 1 });
  assert.equal(await v.tonKeySource(imp), null);

  // the UI gets public data only, for HD accounts
  const map = await tonHandlers.tonAccounts();
  assert.deepEqual(Object.keys(map).sort(), [hd0, hd1].sort());
  const expected = friendly(walletContract(hdKeyPair(A, 1).publicKey).address);
  assert.equal(map[hd1].mainnet.friendly, expected);
  assert.equal(map[hd1].version, 'v5r1');
  assert.ok(!JSON.stringify(map).includes('secret'), 'no secrets to the UI');

  // import a wallet from another TON app (raw key), as a v4r2 wallet
  const secret = '33'.repeat(32);
  const look = await tonHandlers.tonInspectKey({ secret });
  assert.deepEqual(look.versions.map((x) => x.version), ['v5r1', 'v4r2', 'v3r2']);
  const acc = await tonHandlers.tonImport({ secret, version: 'v4r2', name: 'Tonkeeper' });
  assert.equal(acc.type, 'ton');
  assert.equal(acc.address, look.versions[1].mainnet.raw);
  await assert.rejects(() => tonHandlers.tonImport({ secret, version: 'v4r2' }), /already|già/, 'no duplicates');
  assert.deepEqual(await v.tonKeySource(acc.address), { secret, version: 'v4r2' });
  assert.equal((await tonHandlers.tonAccounts())[acc.address].version, 'v4r2');
  assert.equal(await v.exportPrivateKey(acc.address, 'walletpw1'), secret, 'its key can be shown like any account key');
  await assert.rejects(() => v.getSigner(acc.address), /./, 'no Ethereum signer for a TON account');

  // backup -> restore on a fresh device keeps the TON account (with its version and name)
  const backup = await v.exportBackup('walletpw1', 'backuppw1');
  await reset();
  await v.restoreVault('newpw123', backup, 'backuppw1');
  await v.unlock('newpw123');
  const st = await v.view();
  const ton = st.accounts.find((a) => a.type === 'ton');
  assert.ok(ton, 'TON account restored');
  assert.equal(ton.address, acc.address);
  assert.equal(ton.name, 'Tonkeeper');
  assert.deepEqual(await v.tonKeySource(ton.address), { secret, version: 'v4r2' });
  assert.equal(st.accounts.length, 4);

  // a backup made under the app's earlier name (another NAME-BACKUP-2: prefix) is read too
  assert.match(backup, /^CHAKRA-BACKUP-2:/);
  await reset();
  await v.restoreVault('newpw123', backup.replace('CHAKRA-BACKUP-2:', 'OLDNAME-BACKUP-2:'), 'backuppw1');
  await v.unlock('newpw123');
  assert.ok((await v.view()).accounts.some((a) => a.type === 'ton'), 'old-prefix backup restored');
  await assert.rejects(() => v.restoreVault('newpw123', 'NOT-A-BACKUP', 'backuppw1'), /./);

  // removal: account and key go
  await v.removeAccount(ton.address, 'newpw123');
  assert.equal((await v.view()).accounts.some((a) => a.type === 'ton'), false);
  assert.equal(await v.tonKeySource(ton.address), null);
  await assert.rejects(() => v.exportPrivateKey(ton.address, 'newpw123'), /./);
});
