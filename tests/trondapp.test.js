// Tron dapps (wallet side, src/background/tronDapp.js): sessions per site, transactions read from their bytes and
// signed only through an approval (a stand-in that says yes or no), a change of permissions always refused (the user
// is shown it, nothing is signed), signatures checked by recovering the signer.
import { resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/background/vault.js';
import { tronDappFamily } from '../src/background/tronDapp.js';
import '../src/background/families.js';
import { hdKey, recoverSigner, fromHex, toHex, messageHashV2, messageHashV1 } from '../src/shared/tron/core.js';
import { encodeRawData, encodeMessage, decodeRawData } from '../src/shared/tron/proto.js';

const PHRASE = 'test test test test test test test test test test test junk';
const O = 'https://app.example.org';
const REF = { ref_block_bytes: '73d8', ref_block_hash: 'b696cdb94aea2633' };
const tx = (contract) => encodeRawData({ contract, ref: REF, expiration: 1795004291000, timestamp: 1795004231554 });

test('Tron dapp sessions and signatures', { timeout: 300000 }, async () => {
  await reset();
  await v.createVault('walletpw1', PHRASE, 'Main');
  await v.unlock('walletpw1');
  const hd0 = (await v.view()).accounts[0].address;
  const me = hdKey(PHRASE, 0).address, other = hdKey(PHRASE, 1).address;
  const asked = [], events = [];
  let answer = 'yes';
  const family = tronDappFamily({
    async requestApproval(origin, kind, params) {
      asked.push({ kind, params });
      if (answer === 'no' || kind === 'tronBlocked') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      return family.approvals[kind].complete({ origin, kind, params }, { account: hd0, node: 'mainnet' });
    },
    ensureUnlocked: async () => {},
    emitToOrigin: async (origin, event, data) => { events.push({ origin, event, data }); },
  });
  const call = (method, params, origin = O) => family.handle(origin, method, params);

  // refused before anything is asked
  await assert.rejects(() => call('tron_requestAccounts', {}, 'http://app.example.org'), /https/);
  await assert.rejects(() => call('tron_signMessage', { message: 'hi' }), /request the accounts first/);
  assert.deepEqual(await call('tron_accounts', {}), { address: null }, 'the silent check asks nothing');
  assert.equal(asked.length, 0);

  // declined, then connected
  answer = 'no';
  await assert.rejects(() => call('tron_requestAccounts', {}), /rejected/);
  answer = 'yes';
  assert.deepEqual(await call('tron_requestAccounts', {}), { address: me, node: 'mainnet' });
  assert.deepEqual(events.at(-1), { origin: O, event: 'tron', data: { address: me, node: 'mainnet' } });
  const n = asked.length;
  assert.deepEqual(await call('tron_requestAccounts', {}), { address: me, node: 'mainnet' });
  assert.equal(asked.length, n, 'no second approval for the same site');
  assert.equal((await family.state(await v.view())).tronSites[O].address, me);

  // a transaction: read from its bytes, approved, signed by the account
  const send = tx({ type: 'TransferContract', parameter: { owner_address: me, to_address: other, amount: 1_000_000 } });
  const { txID } = decodeRawData(send);
  const r = await call('tron_signTransaction', { raw_data_hex: send, txID });
  assert.equal(asked.at(-1).kind, 'tronTx');
  assert.equal(r.txID, txID);
  assert.equal(recoverSigner(fromHex(txID), r.signature), me);
  // a page can't make the user approve one transaction and sign another
  await assert.rejects(() => call('tron_signTransaction', { raw_data_hex: send, txID: 'ab'.repeat(32) }), /does not match/);
  // only the session account's own transactions
  const notMine = tx({ type: 'TransferContract', parameter: { owner_address: other, to_address: me, amount: 5 } });
  await assert.rejects(() => call('tron_signTransaction', { raw_data_hex: notMine }), /not for the connected account/);
  await assert.rejects(() => call('tron_signTransaction', { raw_data_hex: 'zz' }), /Bad transaction/);

  // a change of permissions: the user is shown it, nothing is signed, the page gets a refusal
  const perm = encodeMessage('AccountPermissionUpdateContract', { owner_address: me, owner: { type: 0, permission_name: 'owner', threshold: 1, keys: [{ address: other, weight: 1 }] } });
  const takeover = toHex(encodeMessage('raw', { ...REF, expiration: 1, timestamp: 1,
    contract: [{ type: 46, parameter: { type_url: 'type.googleapis.com/protocol.AccountPermissionUpdateContract', value: perm } }] }));
  const before = asked.length;
  await assert.rejects(() => call('tron_signTransaction', { raw_data_hex: takeover }), (e) => e.code === 4001);
  assert.equal(asked.length, before + 1);
  assert.equal(asked.at(-1).kind, 'tronBlocked', 'the screen that explains it, never the signing one');
  // and even if a screen said yes, the background wouldn't sign it
  await assert.rejects(() => family.approvals.tronTx.complete({ params: { account: hd0, raw: takeover } }), (e) => e.key === 'tron.err.permissionUpdate');

  // messages: v2 (text or hex bytes) and the old v1 (hex)
  const m2 = await call('tron_signMessage', { message: 'Sign in to app.example.org', version: 2 });
  assert.equal(recoverSigner(messageHashV2('Sign in to app.example.org'), m2.signature.slice(2)), me);
  const m2hex = await call('tron_signMessage', { message: '0x68656c6c6f', version: 2, hex: true });
  assert.equal(recoverSigner(messageHashV2(fromHex('68656c6c6f')), m2hex.signature.slice(2)), me);
  const m1 = await call('tron_signMessage', { message: 'ab'.repeat(32), version: 1 });
  assert.equal(recoverSigner(messageHashV1('ab'.repeat(32)), m1.signature.slice(2)), me);
  await assert.rejects(() => call('tron_signMessage', { message: 'not hex', version: 1 }), /hex expected/);

  // disconnected by the user: the page is told
  await family.disconnect(O);
  assert.deepEqual(events.at(-1), { origin: O, event: 'tron', data: { address: null } });
  assert.deepEqual(await call('tron_accounts', {}), { address: null });
});
