// Auto-lock: counted from the last activity, with a wall-clock deadline that locks at once when the timer ran late
// (Android, phone asleep) and is never extended once expired.
import { storage } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = { msg: [], alarm: [] };
const alarms = new Map();
const ev = (list) => ({ addListener: (f) => list?.push(f), removeListener() {} });
Object.assign(globalThis.chrome, {
  runtime: {
    id: 'test', getURL: (p) => `chrome-extension://test/${p}`, onMessage: ev(listeners.msg), onConnect: ev(), onInstalled: ev(),
    sendMessage: async () => {},
  },
  alarms: { create: (name, info) => alarms.set(name, info.delayInMinutes), clear: async (name) => alarms.delete(name), onAlarm: ev(listeners.alarm) },
  tabs: { query: async () => [], sendMessage: async () => {}, create: async () => {} },
  windows: { onRemoved: ev(), create: async () => ({}), update: async () => ({}), remove: async () => {}, getLastFocused: async () => ({}) },
});
storage.onChanged = ev();

const { DEFAULT_SETTINGS } = await import('../src/shared/ext.js');
await import('../src/background/index.js');
const vault = await import('../src/background/vault.js');

/** A message from the app's UI, as bg() sends it. */
const send = (type, payload = {}) => new Promise((resolve, reject) => {
  const ok = listeners.msg[0]({ type, ...payload }, { id: 'test' }, (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))));
  if (!ok) reject(new Error(`no handler for ${type}`));
});

const realNow = Date.now;
const at = (ms) => { Date.now = () => ms; };

test('auto-lock restarts at every touch and locks at once when the deadline passed while asleep', async () => {
  const t0 = realNow();
  try {
    at(t0);
    await storage.local.set({ settings: { ...DEFAULT_SETTINGS, autoLockMin: 5 } });
    await send('createVault', { password: 'walletpw1', mnemonic: 'test test test test test test test test test test test junk' });
    assert.equal(await vault.isUnlocked(), true);
    assert.equal(alarms.get('autolock'), 5);

    // activity at 4 minutes: still unlocked, the deadline moves to 9 minutes
    at(t0 + 4 * 60000);
    assert.equal(await send('touch'), true);
    at(t0 + 8 * 60000);
    assert.equal(await send('checkLock'), false);
    assert.equal(await vault.isUnlocked(), true);

    // the timer didn't fire (phone asleep): back in the foreground after the deadline -> locked
    at(t0 + 9 * 60000 + 1);
    assert.equal(await send('checkLock'), true);
    assert.equal(await vault.isUnlocked(), false);

    // unlock again; a tap after the deadline doesn't extend it, it locks
    at(t0 + 10 * 60000);
    await send('unlock', { password: 'walletpw1' });
    at(t0 + 16 * 60000);
    assert.equal(await send('touch'), false);
    assert.equal(await vault.isUnlocked(), false);

    // the alarm itself locks too
    await send('unlock', { password: 'walletpw1' });
    for (const f of listeners.alarm) await f({ name: 'autolock' });
    assert.equal(await vault.isUnlocked(), false);

    // "never": no alarm, no deadline
    await storage.local.set({ settings: { ...DEFAULT_SETTINGS, autoLockMin: 0 } });
    await send('unlock', { password: 'walletpw1' });
    assert.equal(alarms.has('autolock'), false);
    at(t0 + 1000 * 60000);
    assert.equal(await send('checkLock'), false);
    assert.equal(await vault.isUnlocked(), true);
  } finally {
    Date.now = realNow;
  }
});
