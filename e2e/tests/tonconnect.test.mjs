// TON Connect end to end: a dapp page of the in-app browser (played by the test through the native plugin's stand-in,
// e2e/app/stubs/capacitor-core.js) connects with a sign-in, sends GRAM and asks a signature, through the real approval
// screens and the password; the transfer is checked on the local TON network. Then Chakra disconnects the site.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Address, beginCell } from '@ton/core';
import { openWallet, authorize, closeBrowser, waitFor, screenText, STATE, tonGram, tonAccount } from './helpers.mjs';

const TON = STATE.ton.id, ME = STATE.ton.user;
const ORIGIN = 'https://dapp.example';
const PAGE = { tabId: 41, pageId: 1, url: `${ORIGIN}/`, origin: ORIGIN, title: 'Example dapp' };
after(closeBrowser);

async function step(page, label, fn) {
  try { return await fn(); } catch (e) {
    await page.shot(label);
    throw new Error(`${label}: ${e.message}\n--- screen ---\n${(await screenText(page)).slice(0, 1200)}\n--- page errors ---\n${page.errors.join('\n')}`);
  }
}

/** A request from the dapp page, as the native browser delivers it. */
const post = (page, id, method, params) => page.evaluate((a) => globalThis.__e2eDapp.post(a.PAGE, { type: 'request', id: a.id, method: a.method, params: a.params }), { PAGE, id, method, params });
/** The app's answer to it. */
const answer = (page, id) => waitFor(() => page.evaluate((x) => globalThis.__e2eDapp.sent.find((s) => s.msg.type === 'response' && s.msg.id === x)?.msg, id), { what: `the answer to ${id}`, timeout: 40000 });

test('TON Connect: connect with sign-in, send GRAM, sign a text, disconnect', async () => {
  const page = await openWallet(TON, { name: 'tonconnect' });
  // the dapp's manifest (the only non-local address the test lets through)
  await page.context().route(`${ORIGIN}/tonconnect-manifest.json`, (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ url: ORIGIN, name: 'Example dapp', iconUrl: `${ORIGIN}/icon.png` }),
  }));
  await page.evaluate((p) => globalThis.__e2eDapp.open(p), PAGE);

  await step(page, 'connect', async () => {
    await post(page, 'c1', 'tonconnect_connect', { protocolVersion: 2, request: { manifestUrl: `${ORIGIN}/tonconnect-manifest.json`, items: [{ name: 'ton_addr', network: String(TON) }, { name: 'ton_proof', payload: 'e2e-nonce' }] } });
    await page.waitForSelector('h3:has-text("Sign in with a TON account")', { timeout: 20000 });
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  const c = (await answer(page, 'c1')).result;
  assert.equal(c.event, 'connect', JSON.stringify(c));
  const [addr, proof] = c.payload.items;
  assert.ok(Address.parse(addr.address).equals(Address.parse(ME)), 'the first account');
  assert.equal(addr.network, String(TON));
  assert.equal(proof.proof.domain.value, 'dapp.example', 'signed for the page host');

  const other = await tonAccount(1);
  const before = await tonGram(other);
  const comment = beginCell().storeUint(0, 32).storeStringTail('from a dapp').endCell().toBoc().toString('base64');
  await step(page, 'transaction', async () => {
    await post(page, 't1', 'tonconnect_send', { message: { method: 'sendTransaction', id: '1', params: [JSON.stringify({ valid_until: Math.floor(Date.now() / 1000) + 300, network: String(TON), from: addr.address, messages: [{ address: other, amount: '1500000000', payload: comment }] })] } });
    await page.waitForSelector('h3:has-text("Transaction requested by Example dapp")', { timeout: 20000 });
    await page.waitForSelector('.content:has-text("from a dapp")');
    await page.waitForSelector('.footer .btn:last-child:not([disabled])', { timeout: 30000 }); // after the emulation (not available locally: it says so)
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  const t1 = (await answer(page, 't1')).result; // the dapp's response: { result: BoC, id }
  assert.equal(typeof t1.result, 'string', JSON.stringify(t1));
  assert.equal(t1.id, '1');
  await step(page, 'arrival', () => waitFor(async () => (await tonGram(other)) - before === 1500000000n, { what: '1.5 GRAM to arrive', timeout: 30000 }));

  await step(page, 'signData', async () => {
    await post(page, 's1', 'tonconnect_send', { message: { method: 'signData', id: '2', params: [JSON.stringify({ type: 'text', text: 'I agree to the terms' })] } });
    await page.waitForSelector('pre.data:has-text("I agree to the terms")', { timeout: 20000 });
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  const s1 = (await answer(page, 's1')).result.result;
  assert.equal(s1.domain, 'dapp.example');
  assert.equal(s1.payload.text, 'I agree to the terms');
  assert.equal(Buffer.from(s1.signature, 'base64').length, 64);

  // Chakra disconnects the site: the page is told, the session is gone
  await page.evaluate((origin) => chrome.runtime.sendMessage({ type: 'disconnectSite', origin }), ORIGIN);
  await waitFor(() => page.evaluate(() => globalThis.__e2eDapp.sent.some((s) => s.msg.type === 'event' && s.msg.event === 'tonconnect' && s.msg.data?.event === 'disconnect')), { what: 'the disconnect event' });
  await post(page, 'r1', 'tonconnect_restore', {});
  assert.equal((await answer(page, 'r1')).result.payload.code, 100);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
