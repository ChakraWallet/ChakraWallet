import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookalike, checkRecipient } from '../src/shared/poison.js';

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
  assert.deepEqual(checkRecipient(REAL, book), { level: 'known' });
  assert.deepEqual(checkRecipient(FAKE, book), { level: 'poisoned', similar: REAL });
  const unseen = '0x1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5678';
  assert.deepEqual(checkRecipient(unseen, book), { level: 'lookalike', similar: REAL });
  assert.deepEqual(checkRecipient(OTHER, book), { level: null });
  assert.deepEqual(checkRecipient('0xbad', book), { level: null });
  assert.deepEqual(checkRecipient(REAL, null), { level: null });
});
