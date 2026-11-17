import { resetStorage } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { lookalike, checkRecipient, addressBook, rememberRecipient } from '../src/shared/poison.js';
import { tonPoisonKit } from '../src/ui/ton/driver.js';

const REAL = '0x1234567890abcdef1234567890abcdef12345678';
const FAKE = '0x1234000000000000000000000000000000005678'; // same first/last 4 characters
const OTHER = '0x9999999999999999999999999999999999999999';

test('lookalike: same start and end, different address', () => {
  assert.equal(lookalike(REAL, FAKE), true);
  assert.equal(lookalike(REAL.toUpperCase().replace('0X', '0x'), FAKE), true);
  assert.equal(lookalike(REAL, REAL), false);
  assert.equal(lookalike(REAL, OTHER), false);
  assert.equal(lookalike(REAL, '0x12' + '0'.repeat(36) + '78'), false, 'only 2 matching characters');
  assert.equal(lookalike(REAL, 'nope'), false);
});

test('checkRecipient verdicts', () => {
  const book = { known: new Set([REAL]), poisoned: new Set([FAKE]) };
  assert.deepEqual(checkRecipient(REAL, book), { level: 'known', shown: REAL });
  assert.deepEqual(checkRecipient(FAKE, book), { level: 'poisoned', similar: REAL, shown: FAKE });
  const unseen = '0x1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5678';
  assert.deepEqual(checkRecipient(unseen, book), { level: 'lookalike', similar: REAL, shown: unseen });
  assert.deepEqual(checkRecipient(OTHER, book), { level: null });
  assert.deepEqual(checkRecipient('0xbad', book), { level: null });
  assert.deepEqual(checkRecipient(REAL, null), { level: null });
});

// ------------------------------------------------------------ TON (tonPoisonKit)
const kit = tonPoisonKit({ testnet: false });
const uq = (a) => a.toString({ urlSafe: true, bounceable: false });
/** Two TON addresses whose UQ forms share the first and the last 4 characters (as a scammer would make them). */
function lookalikePair() {
  const h = Buffer.alloc(32, 7); h[0] = 0x9c; h[31] = 0x41; // same first and last hash bytes...
  const a = new Address(0, h), target = uq(a);
  for (let i = 1; i < 3_000_000; i++) { // ...and a CRC that ends the same: about 65 000 tries
    const g = Buffer.from(h); g.writeUInt32BE(i, 12);
    const b = new Address(0, g);
    if (uq(b).slice(-4) === target.slice(-4)) return [a, b];
  }
  throw new Error('no pair');
}

test('TON: one address in any spelling; look-alikes judged on the UQ form, 4 + 4 characters', () => {
  const [a, b] = lookalikePair();
  const raw = a.toRawString();
  for (const form of [raw, uq(a), a.toString({ urlSafe: true, bounceable: true }), ` ${uq(a)} `]) assert.equal(kit.canonical(form), raw, form);
  assert.equal(kit.canonical('UQnot-an-address'), null);
  assert.equal(kit.display(raw), uq(a));
  assert.equal(uq(a).slice(0, 4), uq(b).slice(0, 4));
  assert.equal(kit.lookalike(raw, b.toRawString()), true);
  assert.equal(kit.lookalike(raw, raw), false);
  assert.equal(kit.lookalike(raw, new Address(0, Buffer.alloc(32, 9)).toRawString()), false);

  const book = { known: new Set([raw]), poisoned: new Set() };
  const typed = b.toString({ urlSafe: true, bounceable: true }); // typed in the EQ form: compared as shown (UQ)
  assert.deepEqual(checkRecipient(typed, book, kit), { level: 'lookalike', similar: uq(a), shown: uq(b) });
  assert.deepEqual(checkRecipient(a.toString({ urlSafe: true, bounceable: true }), book, kit), { level: 'known', shown: uq(a) });
  assert.deepEqual(checkRecipient(typed, { ...book, poisoned: new Set([b.toRawString()]) }, kit), { level: 'poisoned', similar: uq(a), shown: uq(b) });
});

test('TON: address book from own wallets, remembered recipients and the history', async () => {
  await resetStorage();
  const [a, b] = lookalikePair();
  const me = new Address(0, Buffer.alloc(32, 1)), friend = new Address(0, Buffer.alloc(32, 2));
  await rememberRecipient(uq(friend), kit);
  const history = async () => ({ items: [
    { kind: 'send', sentByMe: true, counterparty: uq(a), transfers: [] }, // a real recipient
    { kind: 'receive', spam: true, counterparty: uq(b), transfers: [{ counterparty: uq(b) }] }, // the scammer's dust
  ] });
  const book = await addressBook({ id: -239 }, me.toRawString(), [me.toRawString()], { history }, kit);
  assert.ok(book.known.has(me.toRawString()) && book.known.has(friend.toRawString()) && book.known.has(a.toRawString()));
  assert.ok(book.poisoned.has(b.toRawString()));
  assert.equal(checkRecipient(uq(b), book, kit).level, 'poisoned');
  // EVM recipients and TON recipients are remembered apart
  assert.deepEqual((await chrome.storage.local.get('recipients')).recipients, undefined);
});
