// Speeding up and cancelling a transaction still waiting (EVM): the fee floor, the replacement prepared for the fee
// screen, the background that rebuilds and sends it (public nodes and Flashbots Protect, simulated), and the history
// that shows one row per operation.
import { storage } from './helpers/chrome.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from 'ethers';

const listeners = { msg: [] };
const ev = (list) => ({ addListener: (f) => list?.push(f), removeListener() {} });
Object.assign(globalThis.chrome, {
  runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, onMessage: ev(listeners.msg), onConnect: ev(), onInstalled: ev(), sendMessage: async () => {} },
  alarms: { create() {}, clear: async () => {}, onAlarm: ev() },
  tabs: { query: async () => [], sendMessage: async () => {}, create: async () => {} },
  windows: { onRemoved: ev(), create: async () => ({}), update: async () => ({}), remove: async () => {}, getLastFocused: async () => ({}) },
});
storage.onChanged = ev();

const { replacementFloor, meetsFloor, replacementCall, prepareReplacement } = await import('../src/shared/tx.js');
const { loadHistory, oneRowPerOperation } = await import('../src/shared/history.js');
const { BUILTIN_CHAINS } = await import('../src/shared/chains.js');
await import('../src/background/index.js');
const { evmDriver } = await import('../src/ui/chains/evm.js');

const ETH = BUILTIN_CHAINS.find((c) => c.id === 1); // Flashbots Protect: the private channel
const ARB = BUILTIN_CHAINS.find((c) => c.id === 42161); // public nodes only
const PASSWORD = 'walletpw1';
const OTHER = '0x1111111111111111111111111111111111111111';
const gwei = (n) => BigInt(Math.round(n * 1e9));
const hex = (n) => '0x' + BigInt(n).toString(16);

/** A message from the app's UI, as bg() sends it. */
const send = (type, payload = {}) => new Promise((resolve, reject) => {
  const ok = listeners.msg[0]({ type, ...payload }, { id: 'test' }, (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))));
  if (!ok) reject(new Error(`no handler for ${type}`));
});

// ---------------------------------------------------------------- a simulated node (and Flashbots Protect)
const node = { latest: 5, pending: 5, baseFee: gwei(10), sent: [], private: [], status: {}, receipts: {} };
const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://protect.flashbots.net/tx/')) return json({ status: node.status[u.split('/').pop()] || 'UNKNOWN' });
  if (!init.body) return json({ status: '0', message: 'No transactions found', result: [] }); // the indexer: nothing yet
  const { id, method, params } = JSON.parse(init.body);
  const res = (result) => json({ jsonrpc: '2.0', id, result });
  if (u.includes('rpc.flashbots.net')) { const tx = Transaction.from(params[0]); node.private.push(tx); return res(tx.hash); }
  switch (method) {
    case 'eth_getTransactionCount': return res(hex(params[1] === 'latest' ? node.latest : node.pending));
    case 'eth_sendRawTransaction': { const tx = Transaction.from(params[0]); node.sent.push(tx); return res(tx.hash); }
    case 'eth_getBlockByNumber': return res({ number: '0x10', baseFeePerGas: hex(node.baseFee) });
    case 'eth_feeHistory': return res({ baseFeePerGas: [hex(node.baseFee)], reward: [[hex(gwei(0.1)), hex(gwei(0.5)), hex(gwei(1))]] });
    case 'eth_maxPriorityFeePerGas': return res(hex(gwei(0.5)));
    case 'eth_estimateGas': return res('0x5208');
    case 'eth_getBalance': return res(hex(10n ** 19n));
    case 'eth_getTransactionReceipt': return res(node.receipts[params[0]] || null);
    default: return res(null);
  }
};

let me = null;
async function wallet() {
  if (!me) {
    await send('createVault', { password: PASSWORD, mnemonic: 'test test test test test test test test test test test junk' });
    me = (await send('getState')).accounts[0].address;
  }
  return me;
}
const txFor = (chain, extra = {}) => ({
  chainId: chain.id, type: 2, to: OTHER, value: hex(10n ** 17n), data: '0x', gas: '0x5208',
  maxFeePerGas: hex(gwei(30)), maxPriorityFeePerGas: hex(gwei(2)), ...extra,
});
const pendingStore = () => storage.local.get('txpending').then((x) => x.txpending || {});
const logOf = async (chain) => ((await storage.local.get('txlog')).txlog || {})[`${chain.id}:${me.toLowerCase()}`] || [];

beforeEach(() => { node.latest = 5; node.pending = 5; node.baseFee = gwei(10); node.sent = []; node.private = []; node.status = {}; node.receipts = {}; });

// ---------------------------------------------------------------- the fee floor
test('the floor: 10% above the highest fee sent with that nonce, rounded up, always strictly higher', () => {
  const a = { type: 2, maxFeePerGas: hex(gwei(30)), maxPriorityFeePerGas: hex(gwei(2)) };
  const b = { type: 2, maxFeePerGas: hex(gwei(40)), maxPriorityFeePerGas: hex(gwei(1)) };
  assert.deepEqual(replacementFloor([a]), { maxFeePerGas: gwei(33), maxPriorityFeePerGas: gwei(2.2) });
  assert.deepEqual(replacementFloor([a, b]), { maxFeePerGas: gwei(44), maxPriorityFeePerGas: gwei(2.2) }, 'above every one');
  assert.deepEqual(replacementFloor([{ type: 0, gasPrice: '0x7' }]), { gasPrice: 8n }, '7 + 10% = 7.7 -> 8');
  assert.deepEqual(replacementFloor([{ type: 2, maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0' }]), { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 'a zero tip: 1 wei more');
  assert.equal(meetsFloor({ maxFeePerGas: hex(gwei(33)), maxPriorityFeePerGas: hex(gwei(2.2)) }, replacementFloor([a])), true);
  assert.equal(meetsFloor({ maxFeePerGas: hex(gwei(33)), maxPriorityFeePerGas: hex(gwei(2.1)) }, replacementFloor([a])), false);
  assert.equal(meetsFloor({ gasPrice: hex(gwei(50)) }, replacementFloor([a])), false, 'the fields of its type');
});

test('the replacement: the same call to speed up, 0 to oneself with no data to cancel', () => {
  const p = { from: '0xaa', to: '0xbb', value: '0x5', data: '0x1234' };
  assert.deepEqual(replacementCall(p, 'speedUp'), { to: '0xbb', value: '0x5', data: '0x1234' });
  assert.deepEqual(replacementCall(p, 'cancel'), { to: '0xaa', value: '0x0', data: '0x' });
  assert.equal(replacementCall({ ...p, to: null }, 'speedUp').to, null, 'a contract deployment');
});

test('prepared for the fee screen: every speed at least at the floor, the network\'s own when higher', async () => {
  const p = { hash: '0x01', from: OTHER, nonce: 5, type: 2, to: '0x2222222222222222222222222222222222222222', value: '0x1', data: '0x', gas: hex(100000), maxFeePerGas: hex(gwei(30)), maxPriorityFeePerGas: hex(gwei(2)) };
  // a calm network: its fees are below what the transaction offered -> lifted to the floor
  let r = await prepareReplacement(ETH, p, 'speedUp');
  for (const s of Object.values(r.speeds)) {
    assert.ok(BigInt(s.maxFeePerGas) >= gwei(33) && BigInt(s.maxPriorityFeePerGas) >= gwei(2.2));
    assert.ok(BigInt(s.maxCost) === 100000n * BigInt(s.maxFeePerGas), 'the gas limit it was signed with');
  }
  assert.equal(r.tx.gas, hex(100000)); assert.equal(r.tx.nonce, 5);
  assert.equal(BigInt(r.before), 21000n * gwei(12), 'what it offered at today\'s base fee: 10 + 2 gwei');
  // a busy network: above the floor -> the network's
  node.baseFee = gwei(100);
  r = await prepareReplacement(ETH, p, 'speedUp');
  assert.equal(BigInt(r.speeds.fast.maxFeePerGas), gwei(100) * 225n / 100n + gwei(1));
  // cancel: to oneself, nothing, the gas of a transfer
  r = await prepareReplacement(ETH, p, 'cancel');
  assert.deepEqual([r.tx.to, r.tx.value, r.tx.data, r.tx.gas], [OTHER, '0x0', '0x', hex(21000)]);
});

// ---------------------------------------------------------------- the background
test('public nodes: kept when sent, sped up with the same nonce and call, refused below the floor or once mined', async () => {
  await wallet();
  const h1 = await send('sendTransaction', { from: me, tx: txFor(ARB), title: 'Invio 0,1 ETH', password: PASSWORD });
  assert.equal(node.sent.length, 1);
  const kept = (await pendingStore())[h1.toLowerCase()];
  assert.equal(kept.nonce, 5); assert.equal(kept.private, false); assert.equal(kept.to, OTHER.toLowerCase());
  assert.equal((await logOf(ARB))[0].nonce, 5); assert.equal((await logOf(ARB))[0].replaceable, true);

  await assert.rejects(send('replaceTransaction', { from: me, hash: h1, mode: 'speedUp', fees: { maxFeePerGas: hex(gwei(32)), maxPriorityFeePerGas: hex(gwei(3)) }, password: PASSWORD }), /10%/);
  await assert.rejects(send('replaceTransaction', { from: me, hash: h1, mode: 'speedUp', fees: { maxFeePerGas: hex(gwei(40)), maxPriorityFeePerGas: hex(gwei(3)) }, password: 'wrong-password' }));
  const h2 = await send('replaceTransaction', { from: me, hash: h1, mode: 'speedUp', fees: { maxFeePerGas: hex(gwei(40)), maxPriorityFeePerGas: hex(gwei(3)) }, password: PASSWORD });
  const tx = node.sent[1];
  assert.equal(tx.nonce, 5); assert.equal(tx.to, OTHER); assert.equal(tx.value, 10n ** 17n); assert.equal(tx.data, '0x');
  assert.equal(tx.maxFeePerGas, gwei(40));
  const top = (await logOf(ARB))[0];
  assert.deepEqual([top.hash, top.replaces, top.mode, top.title], [h2, h1.toLowerCase(), 'speedUp', 'Invio 0,1 ETH'], 'the operation keeps its title');

  // replacing the first one again: the floor is above the second too
  await assert.rejects(send('replaceTransaction', { from: me, hash: h1, mode: 'cancel', fees: { maxFeePerGas: hex(gwei(41)), maxPriorityFeePerGas: hex(gwei(3.1)) }, gas: '0x5208', password: PASSWORD }), /10%/);
  const h3 = await send('replaceTransaction', { from: me, hash: h2, mode: 'cancel', fees: { maxFeePerGas: hex(gwei(44)), maxPriorityFeePerGas: hex(gwei(3.3)) }, gas: '0x5208', password: PASSWORD });
  const c = node.sent[2];
  assert.deepEqual([c.nonce, c.to, c.value, c.data], [5, me, 0n, '0x'], 'cancel: 0 to oneself, no data');
  assert.equal((await logOf(ARB))[0].hash, h3);

  node.latest = 6; // one of them was mined
  await assert.rejects(send('replaceTransaction', { from: me, hash: h3, mode: 'speedUp', fees: { maxFeePerGas: hex(gwei(99)), maxPriorityFeePerGas: hex(gwei(9)) }, password: PASSWORD }), /already|già/);
  await assert.rejects(send('replaceTransaction', { from: me, hash: '0x' + '99'.repeat(32), mode: 'speedUp', fees: {}, password: PASSWORD }), /replaced|sostituire/);
});

test('Flashbots Protect: the replacement goes the same way; a private cancellation frees the nonce for the next transaction', async () => {
  await wallet();
  const h1 = await send('sendTransaction', { from: me, tx: txFor(ETH), title: 'Swap', password: PASSWORD });
  assert.equal(node.private.length, 1, 'MEV protection on Ethereum'); assert.equal(node.sent.length, 0);
  assert.equal((await pendingStore())[h1.toLowerCase()].private, true);
  await send('replaceTransaction', { from: me, hash: h1, mode: 'cancel', fees: { maxFeePerGas: hex(gwei(33)), maxPriorityFeePerGas: hex(gwei(2.2)) }, gas: '0x5208', password: PASSWORD });
  assert.equal(node.private.length, 2, 'to Flashbots, as its cancellations ask'); assert.equal(node.sent.length, 0);
  assert.deepEqual([node.private[1].nonce, node.private[1].to, node.private[1].data], [5, me, '0x']);
  // the next transaction: nonce 5 again (the public nodes still say 5), not 6
  await send('sendTransaction', { from: me, tx: txFor(ETH), title: 'Swap', password: PASSWORD });
  assert.equal(node.private[2].nonce, 5);
});

// ---------------------------------------------------------------- the history
const ME = '0x5e83857a7719b6ae2de17af827140c04323a231c';
const H = (n) => '0x' + String(n).repeat(64).slice(0, 64);
const entry = (hash, extra = {}) => ({ hash, time: Date.now(), from: ME, to: OTHER, value: hex(10n ** 17n), data: '0x', title: 'Invio 0,1 ETH', origin: 'Chakra', status: 'pending', nonce: 5, replaceable: true, ...extra });
const mined = { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: hex(gwei(20)), logs: [] };

test('history: a sped-up transaction is one row, the one mined, marked sped up', async () => {
  node.latest = 6; node.receipts[H(2)] = mined;
  const r = await loadHistory(ARB, ME, null, { localLog: [entry(H(2), { time: Date.now(), replaces: H(1), mode: 'speedUp' }), entry(H(1), { time: Date.now() - 60000 })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status, x.replacement]), [[H(2), 'ok', 'speedUp']]);
  assert.equal(r.items[0].replaces, H(1));
  assert.equal(r.items[0].fee, (21000n * gwei(20)).toString());
});

test('history: still waiting -> the latest one, which can be sped up again (a cancellation only faster)', async () => {
  let r = await loadHistory(ARB, ME, null, { localLog: [entry(H(2), { replaces: H(1), mode: 'speedUp' }), entry(H(1), { time: Date.now() - 60000 })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status]), [[H(2), 'pending']]);
  assert.deepEqual(evmDriver.replace.options(ARB, r.items[0]), { speedUp: true, cancel: true });
  r = await loadHistory(ARB, ME, null, { localLog: [entry(H(3), { replaces: H(1), mode: 'cancel' }), entry(H(1), { time: Date.now() - 60000 })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status, x.replacement]), [[H(3), 'pending', 'cancel']]);
  assert.deepEqual(evmDriver.replace.options(ARB, r.items[0]), { speedUp: true, cancel: false });
});

test('history: a cancellation mined shows as the operation, cancelled, with its fee', async () => {
  node.latest = 6; node.receipts[H(3)] = mined;
  const r = await loadHistory(ARB, ME, null, { localLog: [entry(H(3), { replaces: H(1), mode: 'cancel', to: ME, value: '0x0' }), entry(H(1), { time: Date.now() - 60000 })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status]), [[H(3), 'cancelled']]);
  assert.equal(r.items[0].appTitle, 'Invio 0,1 ETH');
  assert.equal(evmDriver.replace.options(ARB, r.items[0]), null);
});

test('history: the original mined first -> it stands, the speed-up disappears', async () => {
  node.latest = 6; node.receipts[H(1)] = mined;
  const r = await loadHistory(ARB, ME, null, { localLog: [entry(H(2), { replaces: H(1), mode: 'speedUp' }), entry(H(1), { time: Date.now() - 60000 })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status, x.replacement]), [[H(1), 'ok', null]]);
});

test('history: its nonce taken by another transaction -> replaced; one sent before this version is left as it was', async () => {
  node.latest = 6;
  const r = await loadHistory(ARB, ME, null, { localLog: [entry(H(1)), entry(H(4), { nonce: undefined, replaceable: undefined })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status]).sort(), [[H(1), 'replaced'], [H(4), 'pending']]);
  assert.equal(evmDriver.replace.options(ARB, r.items.find((x) => x.hash === H(4))), null, 'no data to replace it');
});

test('history: Flashbots Protect cancelled it, or gave up on it', async () => {
  node.status[H(1)] = 'CANCELLED';
  let r = await loadHistory(ETH, ME, null, { localLog: [entry(H(3), { replaces: H(1), mode: 'cancel', private: true }), entry(H(1), { time: Date.now() - 60000, private: true })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status]), [[H(1), 'cancelled']], 'the cancellation never goes on-chain: the operation shows, cancelled');
  node.status[H(1)] = 'FAILED';
  r = await loadHistory(ETH, ME, null, { localLog: [entry(H(1), { private: true })] });
  assert.deepEqual(r.items.map((x) => [x.hash, x.status]), [[H(1), 'dropped']]);
  assert.deepEqual(evmDriver.replace.options(ETH, r.items[0]), { speedUp: true, cancel: false }, 'only sent again');
});

test('one row per operation leaves alone the transactions never replaced', () => {
  const recs = [{ hash: H(1), status: 'ok', time: 1 }, { hash: H(2), status: 'pending', time: 2 }];
  assert.equal(oneRowPerOperation(recs, [entry(H(1)), entry(H(2))]), recs);
});
