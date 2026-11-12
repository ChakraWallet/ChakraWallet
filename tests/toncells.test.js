import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, beginCell, Cell } from '@ton/core';
import {
  buildCell, FieldError, parseBig, parseAddr, parseBoc, toB64, stackArg, readStack, cellAddress, cellText, parseContent,
  buildOnchainContent, buildOffchainContent, describeCell, fetchableUri, commentBody, opName,
} from '../src/shared/ton/cells.js';

const A = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');

test('integers typed by the user: decimal, hex, negative', () => {
  assert.equal(parseBig('1_000'), 1000n);
  assert.equal(parseBig('0xff'), 255n);
  assert.equal(parseBig('-0x10'), -16n);
  assert.throws(() => parseBig('1.5'), FieldError);
  assert.throws(() => parseBig(''), FieldError);
});

test('addresses: friendly, raw, ton:// link, empty as none', () => {
  assert.ok(parseAddr(A.toRawString()).equals(A));
  assert.ok(parseAddr(`ton://transfer/${A.toString()}?amount=1`).equals(A));
  assert.equal(parseAddr('', { optional: true }), null);
  assert.throws(() => parseAddr('nope'), (e) => e instanceof FieldError && e.key === 'tonc.err.address');
});

test('message builder: every field type reads back', () => {
  const ref = beginCell().storeUint(7, 8).endCell();
  const cell = buildCell([
    { type: 'uint', bits: 32, value: '0x0f8a7ea5' },
    { type: 'uint', bits: 64, value: '42' },
    { type: 'int', bits: 8, value: '-5' },
    { type: 'coins', unit: 9, value: '1.5' },
    { type: 'coins', unit: 0, value: '123' },
    { type: 'address', value: A.toString() },
    { type: 'address', value: '' },
    { type: 'bool', value: 'true' },
    { type: 'hex', value: 'abcd' },
    { type: 'maybeRef', value: '' },
    { type: 'maybeRef', value: toB64(ref) },
    { type: 'ref', value: ref.toBoc().toString('hex') },
  ]);
  const s = cell.beginParse();
  assert.equal(s.loadUint(32), 0x0f8a7ea5);
  assert.equal(s.loadUintBig(64), 42n);
  assert.equal(s.loadInt(8), -5);
  assert.equal(s.loadCoins(), 1_500_000_000n);
  assert.equal(s.loadCoins(), 123n);
  assert.ok(s.loadAddress().equals(A));
  assert.equal(s.loadMaybeAddress(), null);
  assert.equal(s.loadBit(), true);
  assert.equal(s.loadBuffer(2).toString('hex'), 'abcd');
  assert.equal(s.loadMaybeRef(), null);
  assert.ok(s.loadMaybeRef().equals(ref));
  assert.ok(s.loadRef().equals(ref));
  assert.equal(s.remainingBits, 0);
  // text as a snake string, inline slice
  const t = buildCell([{ type: 'uint', bits: 32, value: '0' }, { type: 'text', value: 'ciao 👋' }]);
  assert.equal(t.beginParse().skip(32).loadStringTail(), 'ciao 👋');
  const sl = buildCell([{ type: 'slice', value: toB64(ref) }]);
  assert.ok(sl.equals(ref));
  assert.equal(buildCell([]), null);
});

test('message builder: errors carry the field index', () => {
  const bad = (fields, key, index) => assert.throws(() => buildCell(fields), (e) => e instanceof FieldError && e.key === key && e.index === index);
  bad([{ type: 'uint', bits: 8, value: '1' }, { type: 'uint', bits: 8, value: '256' }], 'tonc.err.range', 1);
  bad([{ type: 'int', bits: 8, value: '-129' }], 'tonc.err.range', 0);
  bad([{ type: 'uint', bits: 300, value: '1' }], 'tonc.err.bits', 0);
  bad([{ type: 'ref', value: 'zz' }], 'tonc.err.boc', 0);
  bad([{ type: 'hex', value: 'abc' }], 'tonc.err.hex', 0);
  bad(Array.from({ length: 5 }, () => ({ type: 'ref', value: toB64(beginCell().endCell()) })), 'tonc.err.overflow', 4);
});

test('BoC in base64, base64url and hex', () => {
  const c = beginCell().storeUint(0xabc, 12).storeRef(beginCell().storeUint(1, 1).endCell()).endCell();
  for (const x of [toB64(c), toB64(c).replace(/\+/g, '-').replace(/\//g, '_'), c.toBoc().toString('hex'), '0x' + c.toBoc().toString('hex')]) assert.ok(parseBoc(x).equals(c));
});

test('get-method arguments in TON Center format', () => {
  assert.deepEqual(stackArg({ type: 'int', value: '255' }), { type: 'num', value: '0xff' });
  assert.deepEqual(stackArg({ type: 'int', value: '-1' }), { type: 'num', value: '-0x1' });
  const a = stackArg({ type: 'address', value: A.toString() });
  assert.equal(a.type, 'slice');
  assert.ok(Cell.fromBase64(a.value).beginParse().loadAddress().equals(A));
  const c = beginCell().storeUint(5, 8).endCell();
  assert.deepEqual(stackArg({ type: 'cell', value: toB64(c) }), { type: 'cell', value: toB64(c) });
});

test('stack results: numbers, cells, tuples, null', () => {
  const c = beginCell().storeAddress(A).endCell();
  const r = readStack([{ type: 'num', value: '-0x1' }, { type: 'cell', value: toB64(c) }, { type: 'list', value: [{ type: 'num', value: '0x2' }] }, { type: 'null' }]);
  assert.deepEqual(r[0], { kind: 'num', value: -1n });
  assert.equal(r[1].kind, 'cell');
  assert.ok(r[1].cell.equals(c));
  assert.equal(r[2].kind, 'tuple');
  assert.equal(r[2].items[0].value, 2n);
  assert.equal(r[3].kind, 'null');
});

test('cells read as address / text', () => {
  assert.ok(cellAddress(beginCell().storeAddress(A).endCell()).equals(A));
  assert.equal(cellAddress(beginCell().storeAddress(null).endCell()), null);
  assert.equal(cellAddress(beginCell().storeUint(1, 32).endCell()), undefined);
  const long = 'x'.repeat(300);
  assert.equal(cellText(beginCell().storeStringTail(long).endCell()), long);
  assert.equal(cellText(beginCell().storeUint(0, 8).storeStringTail('hi').endCell(), { prefix: true }), 'hi');
  assert.equal(cellText(beginCell().storeUint(0, 3).endCell()), null);
});

test('TEP-64 metadata: on-chain round trip (long values too) and off-chain link', () => {
  const desc = 'A description long enough to need more than one cell. '.repeat(5);
  const c = buildOnchainContent({ name: 'Test Token', symbol: 'TST', decimals: '9', image: 'https://example.com/t.png', description: desc, empty: '' });
  assert.deepEqual(parseContent(c), { onchain: { name: 'Test Token', symbol: 'TST', description: desc, image: 'https://example.com/t.png', decimals: '9' } });
  assert.deepEqual(parseContent(buildOffchainContent('https://example.com/meta.json')), { uri: 'https://example.com/meta.json' });
  assert.equal(parseContent(beginCell().storeUint(7, 8).endCell()), null);
});

test('cell inspector: operation, query id, comment', () => {
  const d = describeCell(commentBody('hello'));
  assert.equal(d.guess.op, 0);
  assert.equal(d.guess.text, 'hello');
  const j = describeCell(beginCell().storeUint(0x0f8a7ea5, 32).storeUint(9, 64).storeCoins(1).storeRef(beginCell().endCell()).endCell());
  assert.equal(j.guess.opName, 'jetton_transfer');
  assert.equal(j.guess.queryId, 9n);
  assert.equal(j.refs.length, 1);
  assert.equal(opName(0xd53276db), 'excess');
});

test('metadata links that can be fetched', () => {
  assert.equal(fetchableUri('https://a.b/c.json'), 'https://a.b/c.json');
  assert.equal(fetchableUri('ipfs://Qm123/meta.json'), 'https://ipfs.io/ipfs/Qm123/meta.json');
  assert.equal(fetchableUri('http://insecure'), null);
});
