// Android storage: per-key Preferences entries, migration from the old single blob, restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SHIM = new URL('./shim.bundle.mjs', import.meta.url).href;
const vault = { v: 1, data: 'SECRET-BLOB', salt: 'x' };
const legacy = { vault, accounts: [{ address: '0xabc', name: 'Uno' }], settings: { theme: 'dark' }, 'cache:1:0xabc': { totalUsd: 5 } };

test('migrates the old blob, then reads and writes one key at a time', async () => {
  const P = (globalThis.__PREFS = new Map([['ew_local', JSON.stringify(legacy)]]));
  await import(`${SHIM}?first`);
  const L = globalThis.chrome.storage.local;
  const all = await L.get(null);
  assert.deepEqual(all.vault, vault);
  assert.equal(all.accounts[0].name, 'Uno');
  assert.equal(all.settings.theme, 'dark');
  assert.ok(!P.has('ew_local'), 'old blob removed');
  assert.equal(P.get('ew_local:vault'), JSON.stringify(vault));

  await L.set({ selected: '0xabc' });
  assert.equal(P.get('ew_local:selected'), '"0xabc"');
  assert.equal(P.get('ew_local:vault'), JSON.stringify(vault), 'a write touches only its key');
  await L.remove('cache:1:0xabc');
  assert.ok(!P.has('ew_local:cache:1:0xabc'));

  // restart: a fresh module instance reads the per-key format
  globalThis.__PREFS = new Map(P);
  globalThis.chrome = undefined;
  await import(`${SHIM}?restart`);
  const all2 = await globalThis.chrome.storage.local.get(null);
  assert.deepEqual(all2.vault, vault);
  assert.equal(all2.selected, '0xabc');
  assert.ok(!('cache:1:0xabc' in all2));

  await globalThis.chrome.storage.local.clear();
  assert.ok(![...globalThis.__PREFS.keys()].some((k) => k.startsWith('ew_local')), 'clear removes everything');
});

test('writing an unchanged value touches nothing and announces nothing', async () => {
  const P = (globalThis.__PREFS = new Map());
  globalThis.chrome = undefined;
  await import(`${SHIM}?nochange`);
  const { local: L, onChanged } = globalThis.chrome.storage;
  const seen = [];
  onChanged.addListener((c) => seen.push(Object.keys(c)));
  await L.set({ hist: [{ url: 'https://a.example', title: 'A' }] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [['hist']]);
  P.clear();
  await L.set({ hist: [{ url: 'https://a.example', title: 'A' }] }); // same content, new object
  await L.remove('missing');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(P.size, 0, 'no native write');
  assert.deepEqual(seen, [['hist']], 'no change event');
  await L.set({ hist: [], other: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen[1].sort(), ['hist', 'other']);
});
