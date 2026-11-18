// Tron in the vault: keys of each kind of account (the phrase on TronLink's path, Ethereum keys with their Tron address,
// Tron-only accounts imported from TronLink), signing with the checks (the account's own transactions only, never a
// change of permissions), message signing, backup round trip.
import { resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HDNodeWallet } from 'ethers';
import * as v from '../src/background/vault.js';
import { tronHandlers, signMessageWith } from '../src/background/tron.js';
import '../src/background/families.js';
import { hdKey, keyOfPrivate, recoverSigner, fromHex, fromEvmAddress, messageHashV2, toHex } from '../src/shared/tron/core.js';
import { encodeRawData, encodeMessage } from '../src/shared/tron/proto.js';

const A = 'test test test test test test test test test test test junk';
const PK = '0x' + '22'.repeat(32);
const REF = { ref_block_bytes: '73d8', ref_block_hash: 'b696cdb94aea2633' };
const tx = (contract) => encodeRawData({ contract, ref: REF, expiration: 1795004291000, timestamp: 1795004231554 });

test('Tron accounts in the vault', { timeout: 300000 }, async () => {
  await reset();
  await v.createVault('walletpw1', A, 'Main');
  await v.unlock('walletpw1');
  const hd0 = HDNodeWallet.fromPhrase(A, undefined, "m/44'/60'/0'/0/0").address;
  const hd1 = (await v.addHdAccount('Two')).address;
  const imp = (await v.importPrivateKey(PK, 'Imp')).address;

  // the UI gets addresses only: the phrase's accounts on TronLink's path, the Ethereum key's own Tron address
  const map = await tronHandlers.tronAccounts();
  assert.deepEqual(Object.keys(map).sort(), [hd0, hd1, imp].sort());
  assert.equal(map[hd1].address, hdKey(A, 1).address);
  assert.equal(map[imp].address, keyOfPrivate(PK).address);
  assert.equal(map[imp].address, fromEvmAddress(imp), 'an Ethereum key: the same 20 bytes, written the Tron way');
  assert.ok(!JSON.stringify(map).includes('secret'));

  // signing: after the password, only the account's own transactions
  const me = map[hd0].address, other = map[hd1].address;
  const send = tx({ type: 'TransferContract', parameter: { owner_address: me, to_address: other, amount: 1000 } });
  await assert.rejects(() => tronHandlers.tronSign({ from: hd0, txs: [send], password: 'wrong' }));
  const r = await tronHandlers.tronSign({ from: hd0, txs: [send], password: 'walletpw1' });
  assert.equal(recoverSigner(fromHex(r.txIDs[0]), r.signatures[0]), me);
  await assert.rejects(() => tronHandlers.tronSign({ from: hd1, txs: [send], password: 'walletpw1' }), /./, 'not its transaction');

  // a change of the account's permissions is never signed, whatever asks for it
  const perm = encodeMessage('AccountPermissionUpdateContract', { owner_address: me, owner: { type: 0, permission_name: 'owner', threshold: 1, keys: [{ address: other, weight: 1 }] } });
  const takeover = toHex(encodeMessage('raw', { ref_block_bytes: REF.ref_block_bytes, ref_block_hash: REF.ref_block_hash, expiration: 1, timestamp: 1,
    contract: [{ type: 46, parameter: { type_url: 'type.googleapis.com/protocol.AccountPermissionUpdateContract', value: perm } }] }));
  await assert.rejects(() => tronHandlers.tronSign({ from: hd0, txs: [takeover], password: 'walletpw1' }), (e) => e.key === 'tron.err.permissionUpdate');
  // nor bytes that aren't a transaction
  await assert.rejects(() => tronHandlers.tronSign({ from: hd0, txs: ['zz'], password: 'walletpw1' }), (e) => e.key === 'tron.err.badTx');

  // messages: as TronLink's signMessageV2
  const sig = await signMessageWith(hd0, { message: 'hello' });
  assert.equal(recoverSigner(messageHashV2('hello'), sig.slice(2)), me);

  // import from another app: the phrase on TronLink's path, or a private key
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const look = await tronHandlers.tronInspectKey({ phrase });
  assert.equal(look.found.length, 5);
  assert.deepEqual([look.found[0].path, look.found[0].address], ["m/44'/195'/0'/0/0", 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH']);
  const acc = await tronHandlers.tronImport({ phrase, index: 1, name: 'TronLink' });
  assert.equal(acc.type, 'tron');
  assert.equal(acc.address, 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK', 'case kept');
  assert.equal(await v.exportPrivateKey(acc.address, 'walletpw1'), 'edb728e259afca2ddcc428459e7681b8414668649aedbc8d25c0872da219b2e6', 'exported as TronLink imports it');
  await assert.rejects(() => tronHandlers.tronImport({ phrase, index: 1 }), /already|già/);
  await assert.rejects(() => tronHandlers.tronImport({ secret: PK }), /already|già/, 'the Ethereum account has that Tron address already');
  const k2 = await tronHandlers.tronImport({ secret: 'da146374a75310b9666e834ee4ad0866d6f4035967bfc76217c5a495fff9f0d0', name: 'Key' });
  assert.equal(k2.address, 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY');
  assert.equal((await tronHandlers.tronAccounts())[k2.address].address, k2.address);
  await assert.rejects(() => v.getSigner(k2.address), /./, 'no Ethereum signer for a Tron-only account');
  const own = tx({ type: 'TransferContract', parameter: { owner_address: k2.address, to_address: me, amount: 5 } });
  const r2 = await tronHandlers.tronSign({ from: k2.address, txs: [own], password: 'walletpw1' });
  assert.equal(recoverSigner(fromHex(r2.txIDs[0]), r2.signatures[0]), k2.address);

  // backup -> restore keeps the Tron accounts
  const backup = await v.exportBackup('walletpw1', 'backuppw1');
  await reset();
  await v.restoreVault('newpw123', backup, 'backuppw1');
  await v.unlock('newpw123');
  const st = await v.view();
  const trons = st.accounts.filter((a) => a.type === 'tron');
  assert.deepEqual(trons.map((a) => [a.address, a.name]).sort(), [[acc.address, 'TronLink'], [k2.address, 'Key']].sort());
  assert.equal((await tronHandlers.tronAccounts())[acc.address].address, acc.address);
});
