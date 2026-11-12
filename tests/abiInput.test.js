import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParamType } from 'ethers';
import { parseInteger, toArg, toArgs, argsFromJson, emptyValue, display, words, suggestUnit, ArgError } from '../src/shared/abiInput.js';

const P = (t) => ParamType.from(t);
const err = (fn, key) => assert.throws(fn, (e) => e instanceof ArgError && e.key === key);

test('numbers: plain, hex, scientific, units', () => {
  assert.equal(parseInteger('123'), 123n);
  assert.equal(parseInteger('1_000 000'), 1000000n);
  assert.equal(parseInteger('0x10'), 16n);
  assert.equal(parseInteger('1e18'), 10n ** 18n);
  assert.equal(parseInteger('2.5e6'), 2500000n);
  assert.equal(parseInteger('1.5 ether'), 15n * 10n ** 17n);
  assert.equal(parseInteger('3 gwei'), 3n * 10n ** 9n);
  assert.equal(parseInteger('1.5', 18), 15n * 10n ** 17n);
  assert.equal(parseInteger('-7'), -7n);
  err(() => parseInteger('1.5'), 'contracts.err.tooManyDecimals');
  err(() => parseInteger('abc'), 'contracts.err.notNumber');
  err(() => parseInteger(''), 'contracts.err.empty');
});

test('scalars and ranges', () => {
  assert.equal(toArg(P('uint8'), '255'), 255n);
  err(() => toArg(P('uint8'), '256'), 'contracts.err.tooBig');
  err(() => toArg(P('uint256'), '-1'), 'contracts.err.negative');
  assert.equal(toArg(P('int8'), '-128'), -128n);
  err(() => toArg(P('int8'), '128'), 'contracts.err.tooBig');
  assert.equal(toArg(P('address'), '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'), '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  err(() => toArg(P('address'), '0x123'), 'contracts.err.badAddress');
  assert.equal(toArg(P('bool'), true), true);
  assert.equal(toArg(P('bool'), false), false);
  assert.equal(toArg(P('string'), 'ciao'), 'ciao');
  assert.equal(toArg(P('bytes'), '0xdeadbeef'), '0xdeadbeef');
  assert.equal(toArg(P('bytes'), 'hi'), '0x6869');
  assert.equal(toArg(P('bytes4'), '0x01'), '0x01000000');
  assert.equal(toArg(P('bytes32'), 'MINTER_ROLE'), '0x4d494e5445525f524f4c45' + '00'.repeat(21));
  err(() => toArg(P('bytes2'), '0x010203'), 'contracts.err.bytesLength');
  assert.equal(toArg(P('uint256'), '2', { units: { '': 18 } }), 2n * 10n ** 18n);
});

test('arrays, tuples and paths of errors', () => {
  const p = P('tuple(address to, uint256[] amounts, bool ok)');
  assert.deepEqual(emptyValue(p), ['', [], false]);
  assert.deepEqual(emptyValue(P('uint8[3]')), ['', '', '']);
  const v = toArg(p, ['0x' + '11'.repeat(20), ['1', '2'], true]);
  assert.equal(v[1][1], 2n);
  assert.throws(() => toArg(p, ['0x12', [], false], {}, '0'), (e) => e.path === '0.0' && e.key === 'contracts.err.badAddress');
  assert.throws(() => toArgs([P('uint256'), P('uint8[2]')], ['1', ['1', 'x']]), (e) => e.path === '1.1');
  err(() => toArg(P('uint8[2]'), ['1']), 'contracts.err.arrayLength');
});

test('JSON arguments (advanced mode)', () => {
  const inputs = [P('address'), P('uint256'), P('tuple(uint8 a, string b)')];
  const v = argsFromJson(inputs, '["0x' + '22'.repeat(20) + '", "1000000000000000000", {"a": 3, "b": "x"}]');
  assert.equal(v[1], 10n ** 18n);
  assert.deepEqual(v[2], [3n, 'x']);
  err(() => argsFromJson(inputs, '[1]'), 'contracts.err.argCount');
  err(() => argsFromJson(inputs, '[1,'), 'contracts.err.badJson');
});

test('display of results', () => {
  assert.equal(display(P('uint256 deadline'), 1767225600n).sub.kind, 'time');
  assert.equal(display(P('uint256 balance'), 15n * 10n ** 17n, { decimals: 18 }).sub.text, '1.5');
  assert.equal(display(P('bytes32'), '0x4d494e5445525f524f4c45' + '00'.repeat(21)).sub.text, 'MINTER_ROLE');
  assert.equal(display(P('address'), '0x' + '11'.repeat(20)).address, '0x' + '11'.repeat(20));
  assert.equal(display(P('tuple(uint8 a, bool b)'), [1n, true]).children[1].text, 'true');
  assert.deepEqual(words('0x' + '00'.repeat(31) + '01' + 'ff'), ['0x' + '00'.repeat(31) + '01', '0xff']);
  assert.equal(suggestUnit(P('uint256 amount'), 'transfer', { decimals: 6 }), 6);
  assert.equal(suggestUnit(P('uint256 tokenId'), 'transfer', { decimals: 6 }), 0);
});
