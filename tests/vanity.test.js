// Vanity addresses: text -> pattern conversion, maths, and the incremental search core (keys checked with ethers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { toPattern, matches, difficulty, probability, expectedSeconds, exampleParts, splitAddress, MAX_VANITY } from '../src/shared/vanity.js';
import { compile, scan, randomScalar } from '../src/ui/vanitySearch.js';

const kinds = (text) => toPattern(text).chars.map((c) => c.kind).join(',');

test('toPattern: hex kept, look-alikes substituted, the rest dropped', () => {
  assert.equal(toPattern('coffee').pattern, 'c0ffee');
  assert.equal(toPattern('boss').pattern, 'b055');
  assert.equal(toPattern('ciao').pattern, 'c1a0');
  assert.equal(toPattern('rocket').pattern, '0ce7');
  assert.equal(kinds('rocket'), 'drop,sub,same,drop,same,sub');
  // the agreed table: g -> 6, q -> 9
  assert.equal(toPattern('g').pattern, '6');
  assert.equal(toPattern('q').pattern, '9');
  assert.equal(toPattern('olizhs').pattern, '011245');
  assert.equal(toPattern('gtq').pattern, '679');
});

test('toPattern: case, accents, spaces, punctuation, limit', () => {
  assert.equal(toPattern('BEEF').pattern, 'beef');
  assert.equal(kinds('BEEF'), 'same,same,same,same');
  assert.equal(toPattern('perché').pattern, 'ec4e');
  assert.equal(toPattern('  a b-c!').pattern, 'abc');
  assert.equal(toPattern('a b').chars.length, 2, 'whitespace is not shown');
  assert.equal(kinds('a-'), 'same,drop');
  const long = toPattern('deadbeefcafe');
  assert.equal(long.pattern, 'deadbe');
  assert.equal(long.pattern.length, MAX_VANITY);
  assert.equal(long.chars.filter((c) => c.kind === 'over').length, 6);
  assert.equal(toPattern('kmnprxyz').pattern, '2');
  assert.equal(toPattern('').pattern, '');
  assert.equal(toPattern(null).pattern, '');
});

test('matches start / end, any case', () => {
  const a = '0xC0FFee254729296a45a3885639AC7E10F9d54979';
  assert.equal(matches(a, 'c0ffee', 'start'), true);
  assert.equal(matches(a, 'c0ffee', 'end'), false);
  assert.equal(matches(a, '54979', 'end'), true);
  assert.equal(matches(a.slice(2), '54979', 'end'), true);
  assert.equal(matches(a, '', 'start'), false);
  assert.equal(matches('0x1234', '12', 'start'), false);
});

test('difficulty, probability, time', () => {
  assert.equal(difficulty('abc'), 4096);
  assert.equal(difficulty('c0ffee'), 16 ** 6);
  assert.equal(probability(0, 'abc'), 0);
  assert.ok(Math.abs(probability(4096, 'abc') - (1 - 1 / Math.E)) < 0.001, 'after the average number of attempts: ~63%');
  assert.ok(probability(1e9, 'ab') > 0.9999);
  assert.equal(expectedSeconds('abcd', 65536), 1);
  assert.equal(expectedSeconds('abcd', 0), Infinity);
});

test('example and split for display', () => {
  const f = 'ab'.repeat(20);
  assert.deepEqual(exampleParts('c0ffee', 'start', f), { before: '', pattern: 'c0ffee', after: f.slice(0, 34) });
  assert.deepEqual(exampleParts('c0ffee', 'end', '0x' + f), { before: f.slice(0, 34), pattern: 'c0ffee', after: '' });
  const a = '0xC0FFee254729296a45a3885639AC7E10F9d54979';
  assert.deepEqual(splitAddress(a, 'c0ffee', 'start'), { before: '', pattern: 'C0FFee', after: a.slice(8) });
  assert.deepEqual(splitAddress(a, '54979', 'end'), { before: a.slice(2, 37), pattern: '54979', after: '' });
});

test('compile rejects non-hex patterns', () => {
  assert.throws(() => compile('xyz', 'start'));
  assert.throws(() => compile('', 'start'));
  assert.equal(compile('abc', 'end').length, 3);
});

test('scan: every key of a batch matches its address (checked with ethers)', () => {
  // a pattern that matches 1 address in 16: many hits to compare against ethers
  const k0 = randomScalar();
  for (const where of ['start', 'end']) {
    let k = k0;
    let hits = 0;
    for (let round = 0; round < 64 && hits < 12; round++) {
      const r = scan(compile('a', where), k, 64);
      if (r.found) {
        const w = new Wallet(r.found.privateKey);
        assert.equal(w.address.toLowerCase(), '0x' + r.found.address, 'address derived from the reported key');
        assert.ok(matches(w.address, 'a', where));
        k = BigInt(r.found.privateKey) + 1n; // continue right after the hit
        hits++;
      } else k += 64n;
    }
    assert.ok(hits >= 5, `found ${hits} keys`);
  }
});

test('scan: known key, sample is the last address of the batch', () => {
  const k = 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318n;
  const r = scan(compile('f'.repeat(40), 'start'), k, 3);
  assert.equal(r.found, null);
  assert.equal('0x' + r.sample, new Wallet('0x' + (k + 2n).toString(16).padStart(64, '0')).address.toLowerCase());
});

test('search finds a 3-character pattern', () => {
  const checks = compile('c0f', 'end');
  let r;
  for (let i = 0; i < 200 && !r?.found; i++) r = scan(checks);
  assert.ok(r.found, 'found within 200 batches');
  const w = new Wallet(r.found.privateKey);
  assert.ok(w.address.toLowerCase().endsWith('c0f'));
  assert.match(r.found.privateKey, /^0x[0-9a-f]{64}$/);
});

test('randomScalar: in range, different every time', () => {
  const a = randomScalar(), b = randomScalar();
  assert.notEqual(a, b);
  assert.ok(a > 0n && a < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n);
});
