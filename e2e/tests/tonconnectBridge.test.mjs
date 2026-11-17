// TON Connect through the bridge, end to end: a tc:// link opens the app (as Android delivers it), the user approves
// on the real screens, and the dapp - played by the test with tweetnacl, as the TON Connect SDK does - talks to
// Chakra only through the local bridge (e2e/env/tcbridge.mjs): the connection, a GRAM transfer checked on the local
// TON network, then Chakra disconnects it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { Address } from '@ton/core';
import { openWallet, authorize, closeBrowser, waitFor, screenText, STATE, tonGram, tonAccount } from './helpers.mjs';

const TON = STATE.ton.id, ME = STATE.ton.user;
const MANIFEST = 'https://dapp2.example/tonconnect-manifest.json';
after(closeBrowser);

async function step(page, label, fn) {
  try { return await fn(); } catch (e) {
    await page.shot(label);
    throw new Error(`${label}: ${e.message}\n--- screen ---\n${(await screenText(page)).slice(0, 1200)}\n--- page errors ---\n${page.errors.join('\n')}`);
  }
}

/** The dapp: its key pair, what the bridge holds for it, and sending to the wallet. */
function dapp() {
  const k = nacl.box.keyPair();
  const id = Buffer.from(k.publicKey).toString('hex');
  const open = (m, from) => { const b = Buffer.from(m, 'base64'); const o = nacl.box.open(b.subarray(24), b.subarray(0, 24), Buffer.from(from, 'hex'), k.secretKey); return o && JSON.parse(Buffer.from(o).toString()); };
  return {
    id,
    inbox: async () => (await (await fetch(`${STATE.tcbridge}/inbox?client_id=${id}`)).json()).map((m) => ({ from: m.from, msg: open(m.message, m.from) })),
    async send(to, obj) {
      const n = nacl.randomBytes(24);
      const body = Buffer.concat([Buffer.from(n), Buffer.from(nacl.box(Buffer.from(JSON.stringify(obj)), n, Buffer.from(to, 'hex'), k.secretKey))]).toString('base64');
      const r = await fetch(`${STATE.tcbridge}/message?client_id=${id}&to=${to}&ttl=300`, { method: 'POST', body });
      assert.equal(r.status, 200);
    },
  };
}

test('TON Connect through the bridge: a link connects, a transfer is approved, Chakra disconnects', async () => {
  const page = await openWallet(TON, { name: 'tonconnect-bridge' });
  await page.context().route(MANIFEST, (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ url: 'https://dapp2.example', name: 'Example 2' }),
  }));
  const d = dapp();
  const link = `tc://?v=2&id=${d.id}&r=${encodeURIComponent(JSON.stringify({ manifestUrl: MANIFEST, items: [{ name: 'ton_addr', network: String(TON) }] }))}&ret=none`;

  await step(page, 'connect', async () => {
    await page.evaluate((u) => globalThis.__e2eOpenUrl(u), link); // Android opens Chakra with the link
    await page.waitForSelector('h3:has-text("Connect a TON account")', { timeout: 20000 });
    await page.waitForSelector('.warn:has-text("is what the dapp declares")'); // the site can't be verified here
    await page.waitForSelector('.site:has-text("dapp2.example")');
    await page.click('.footer .btn:last-child'); // no signature: no password
    await page.waitForSelector('.toast:has-text("Connected to Example 2")', { timeout: 20000 });
  });
  const hello = await waitFor(async () => (await d.inbox())[0], { what: 'the connection through the bridge' });
  const walletId = hello.from;
  assert.equal(hello.msg.event, 'connect', JSON.stringify(hello.msg));
  assert.ok(Address.parse(hello.msg.payload.items[0].address).equals(Address.parse(ME)));

  const other = await tonAccount(1);
  const before = await tonGram(other);
  await step(page, 'transaction', async () => {
    await d.send(walletId, { method: 'sendTransaction', id: '1', params: [JSON.stringify({ valid_until: Math.floor(Date.now() / 1000) + 300, network: String(TON), messages: [{ address: other, amount: '700000000' }] })] });
    await page.waitForSelector('h3:has-text("Transaction requested by Example 2")', { timeout: 20000 });
    await page.waitForSelector('.site .badge:has-text("QR / link")');
    await page.waitForSelector('.footer .btn:last-child:not([disabled])', { timeout: 30000 });
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  const res = await waitFor(async () => (await d.inbox()).find((m) => m.msg?.id === '1'), { what: 'the answer through the bridge', timeout: 40000 });
  assert.equal(typeof res.msg.result, 'string', JSON.stringify(res.msg));
  await step(page, 'arrival', () => waitFor(async () => (await tonGram(other)) - before === 700000000n, { what: '0.7 GRAM to arrive', timeout: 30000 }));

  // listed with the connected sites, as the dapp declares it; disconnected from Chakra, the dapp is told
  const site = `tc:${d.id}`;
  const st = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));
  assert.deepEqual([st.result.tonSites[site]?.remote, st.result.tonSites[site]?.host], [true, 'dapp2.example']);
  await page.evaluate((o) => chrome.runtime.sendMessage({ type: 'disconnectSite', origin: o }), site);
  await waitFor(async () => (await d.inbox()).some((m) => m.msg?.event === 'disconnect'), { what: 'the disconnect event' });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('TON Connect: a tc:// link in a page of the in-app browser connects without leaving the app', async () => {
  const page = await openWallet(TON, { name: 'tonconnect-inapp-link' });
  await page.context().route(MANIFEST, (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ url: 'https://dapp2.example', name: 'Example 2' }),
  }));
  const d = dapp();
  const link = `tc://?v=2&id=${d.id}&r=${encodeURIComponent(JSON.stringify({ manifestUrl: MANIFEST, items: [{ name: 'ton_addr', network: String(TON) }] }))}&ret=back`;
  await step(page, 'connect', async () => {
    // what DappBrowserPlugin reports when a page navigates to the link (instead of handing it to another app)
    await page.evaluate((url) => globalThis.__e2eDapp.emit('tonConnectLink', { url, tabId: 7 }), link);
    await page.waitForSelector('h3:has-text("Connect a TON account")', { timeout: 20000 });
    await page.click('.footer .btn:last-child');
    await page.waitForSelector('.toast:has-text("Connected to Example 2")', { timeout: 20000 });
  });
  const hello = await waitFor(async () => (await d.inbox())[0], { what: 'the connection through the bridge' });
  assert.equal(hello.msg.event, 'connect');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
