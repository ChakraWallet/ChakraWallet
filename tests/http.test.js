import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJson } from '../src/shared/http.js';

const mockFetch = (statuses) => {
  let n = 0;
  globalThis.fetch = async () => {
    const s = statuses[Math.min(n++, statuses.length - 1)];
    return { ok: s >= 200 && s < 300, status: s, json: async () => ({ ok: 1 }) };
  };
  return () => n;
};

test('retries once on 5xx', async () => {
  const calls = mockFetch([503, 200]);
  assert.deepEqual(await getJson('x'), { ok: 1 });
  assert.equal(calls(), 2);
});
test('retries once on 429', async () => {
  const calls = mockFetch([429, 200]);
  assert.deepEqual(await getJson('x'), { ok: 1 });
  assert.equal(calls(), 2);
});
test('no retry on 4xx', async () => {
  const calls = mockFetch([400]);
  await assert.rejects(getJson('x'), /HTTP 400/);
  assert.equal(calls(), 1);
});
test('gives up after the retry, with the label', async () => {
  const calls = mockFetch([500]);
  await assert.rejects(getJson('x', { label: 'Indexer HTTP' }), /Indexer HTTP 500/);
  assert.equal(calls(), 2);
});
test('404 is "nothing", not an error', async () => {
  mockFetch([404]);
  assert.equal(await getJson('x'), null);
});
