import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mnemonic } from 'ethers';
import { deriveEd25519Path, mnemonicNew, keyPairFromSeed, signVerify } from '@ton/crypto';
import { Cell, loadMessage, Address, beginCell } from '@ton/core';
import {
  slip10Ed25519, hdKeyPair, tonKeyFromPhrase, tonKeyFromSecret, walletContract, friendly, parseAddress, parseTonLink, tonLink,
  commentCell, readComment, jettonTransferCell, JETTON_TRANSFER, signTransfer, feeQuery,
} from '../src/shared/ton/core.js';

const hex = (u) => Buffer.from(u).toString('hex');
const PHRASE = 'test test test test test test test test test test test junk';

test('SLIP-0010 Ed25519: official test vector 1', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(hex(slip10Ed25519(seed, [])), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(hex(slip10Ed25519(seed, [0x80000000])), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  assert.equal(hex(slip10Ed25519(seed, [0x80000000, 0x80000001])), 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2');
  assert.equal(hex(keyPairFromSeed(Buffer.from(slip10Ed25519(seed, [0x80000000]))).publicKey), '8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c');
});

test('account keys from the recovery phrase match @ton/crypto (m/44\'/607\'/i\')', async () => {
  const seed = Buffer.from(Mnemonic.fromPhrase(PHRASE).computeSeed().slice(2), 'hex');
  for (const i of [0, 1, 7]) {
    const theirs = await deriveEd25519Path(seed, [44, 607, i]);
    assert.equal(hex(hdKeyPair(PHRASE, i).publicKey), hex(keyPairFromSeed(theirs).publicKey), `index ${i}`);
  }
  assert.notEqual(hex(hdKeyPair(PHRASE, 0).publicKey), hex(hdKeyPair(PHRASE, 1).publicKey));
});

test('native TON phrase and raw keys', async () => {
  const words = await mnemonicNew(24);
  const kp = await tonKeyFromPhrase(words.join(' '));
  assert.equal(kp.publicKey.length, 32);
  assert.equal(await tonKeyFromPhrase(PHRASE), null, 'a BIP-39 phrase is not a TON phrase');
  const raw = tonKeyFromSecret(hex(kp.secretKey));
  assert.equal(hex(raw.publicKey), hex(kp.publicKey));
  assert.equal(hex(tonKeyFromSecret(Buffer.from(kp.secretKey.subarray(0, 32)).toString('base64')).publicKey), hex(kp.publicKey));
  assert.throws(() => tonKeyFromSecret('abcd'));
});

test('wallet addresses: versions and networks differ, formats round-trip', () => {
  const { publicKey } = hdKeyPair(PHRASE, 0);
  const w5 = walletContract(publicKey), w5t = walletContract(publicKey, { testnet: true }), w4 = walletContract(publicKey, { version: 'v4r2' });
  assert.notEqual(w5.address.toRawString(), w5t.address.toRawString(), 'W5 wallet id depends on the network');
  assert.notEqual(w5.address.toRawString(), w4.address.toRawString());
  const ui = friendly(w5.address);
  assert.match(ui, /^UQ/);
  assert.match(friendly(w5.address, { bounceable: true }), /^EQ/);
  assert.match(friendly(w5t.address, { testnet: true }), /^0Q/);
  const p = parseAddress(ui);
  assert.equal(p.address.equals(w5.address), true);
  assert.equal(p.bounceable, false);
  assert.equal(parseAddress(w5.address.toRawString()).raw, true);
  assert.equal(parseAddress(`ton://transfer/${ui}?amount=1`).address.equals(w5.address), true);
  assert.equal(parseAddress('0x1234'), null);
  assert.equal(parseAddress('UQbad'), null);
  const l = parseTonLink(tonLink(ui, { amount: 1500000000n, text: 'ciao mondo' }));
  assert.equal(l.amount, 1500000000n);
  assert.equal(l.text, 'ciao mondo');
});

test('comment and jetton transfer bodies', () => {
  assert.equal(readComment(commentCell('ordine #42 · città')), 'ordine #42 · città');
  const long = 'x'.repeat(300);
  assert.equal(readComment(commentCell(long)), long);
  const to = Address.parse('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'), me = walletContract(hdKeyPair(PHRASE, 0).publicKey).address;
  const c = jettonTransferCell({ amount: 1234567n, to, responseTo: me, comment: 'hi' });
  const s = c.beginParse();
  assert.equal(s.loadUint(32), JETTON_TRANSFER);
  s.loadUintBig(64);
  assert.equal(s.loadCoins(), 1234567n);
  assert.equal(s.loadAddress().equals(to), true);
  assert.equal(s.loadAddress().equals(me), true);
  assert.equal(s.loadBit(), false);
  assert.equal(s.loadCoins(), 1n);
  assert.equal(s.loadBit(), true);
  assert.equal(readComment(s.loadRef()), 'hi');
});

test('signed transfer: external message to the wallet, with its code before deployment, valid signature', () => {
  const kp = hdKeyPair(PHRASE, 0);
  const wallet = walletContract(kp.publicKey);
  const to = Address.parse('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N');
  const first = signTransfer({ wallet, secretKey: kp.secretKey, seqno: 0, deployed: false, messages: [{ to, value: 10n ** 8n, bounce: false, body: commentCell('x') }] });
  const msg = loadMessage(Cell.fromBase64(first.boc).beginParse());
  assert.equal(msg.info.type, 'external-in');
  assert.equal(msg.info.dest.equals(wallet.address), true);
  assert.ok(msg.init, 'state init attached on the first transfer');
  assert.equal(first.hash.length, 64);
  const later = loadMessage(Cell.fromBase64(signTransfer({ wallet, secretKey: kp.secretKey, seqno: 5, deployed: true, messages: [{ to, value: 1n, bounce: true }] }).boc).beginParse());
  assert.ok(!later.init, 'no state init once deployed');
  // W5 signs the hash of the body without its last 512 bits (the signature sits at the end)
  const body = later.body.beginParse();
  const bits = body.remainingBits;
  const signed = body.loadBits(bits - 512);
  const sig = body.loadBuffer(64);
  const unsigned = beginCell().storeBits(signed);
  for (const r of later.body.refs) unsigned.storeRef(r);
  assert.equal(signVerify(unsigned.endCell().hash(), sig, kp.publicKey), true);
  const q = feeQuery(wallet, later.body, false);
  assert.ok(q.init_code && q.init_data && q.body);
});
