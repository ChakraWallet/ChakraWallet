// TON extras end to end, on the local TON network: a send to a name (TON DNS, resolved by the local TonAPI stand-in),
// the address-poisoning warning on TON, a jetton added by hand with nothing held.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { openWallet, authorize, closeBrowser, waitFor, screenText, STATE, tonGram, tonAccount } from './helpers.mjs';

const TON = STATE.ton.id;
after(closeBrowser);

async function step(page, label, fn) {
  try { return await fn(); } catch (e) {
    await page.shot(label);
    throw new Error(`${label}: ${e.message}\n--- screen ---\n${(await screenText(page)).slice(0, 1200)}\n--- page errors ---\n${page.errors.join('\n')}`);
  }
}

test('send GRAM to a name: friend.ton is resolved, shown and paid', async () => {
  const page = await openWallet(TON, { name: 'ton-name' });
  const friend = await tonAccount(1);
  const before = await tonGram(friend);
  await step(page, 'form', async () => {
    await page.click('.actions .action:nth-of-type(1)');
    await page.fill('.field input.mono', 'friend.ton');
    await page.waitForSelector('.field:has-text("friend.ton →")', { timeout: 15000 });
    await page.fill('.input-wrap input', '1');
    await page.click('.footer .btn');
  });
  await step(page, 'review', async () => {
    await page.waitForSelector('.fee-box .fee-row:has-text("GRAM")');
    await page.waitForSelector('.kv .v:has-text("friend.ton")');
    await page.click('.footer .btn:last-child');
    await authorize(page);
    await page.waitForSelector('h2:has-text("Send confirmed")', { timeout: 30000 });
  });
  assert.equal(await tonGram(friend) - before, 1_000_000_000n);
  assert.match(await screenText(page), /friend\.ton/);

  // a name that doesn't exist: said plainly, nothing to continue with
  await step(page, 'unknown name', async () => {
    await page.click('.footer .btn');
    await page.click('.actions .action:nth-of-type(1)');
    await page.fill('.field input.mono', 'nobody.ton');
    await page.waitForSelector('.field .red:has-text("nobody.ton")', { timeout: 15000 });
  });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

/** Two TON addresses whose UQ forms share the first and the last 4 characters. */
function lookalikePair() {
  const uq = (a) => a.toString({ urlSafe: true, bounceable: false });
  const h = Buffer.alloc(32, 5); h[0] = 0x5a; h[31] = 0x17;
  const a = new Address(0, h);
  for (let i = 1; i < 3_000_000; i++) {
    const g = Buffer.from(h); g.writeUInt32BE(i, 12);
    const b = new Address(0, g);
    if (uq(b).slice(-4) === uq(a).slice(-4)) return [a, b];
  }
  throw new Error('no pair');
}

test('TON address poisoning: a look-alike of a past recipient is stopped until checked', async () => {
  const page = await openWallet(TON, { name: 'ton-poison' });
  const [real, fake] = lookalikePair();
  await page.evaluate((r) => chrome.storage.local.set({ tonRecipients: [r] }), real.toRawString()); // sent to before
  await step(page, 'warning', async () => {
    await page.click('.actions .action:nth-of-type(1)');
    await page.fill('.field input.mono', fake.toString({ urlSafe: true, bounceable: true })); // typed in another spelling
    await page.fill('.input-wrap input', '0.5');
    await page.waitForSelector('.poison-warn:has-text("looks like one you used")', { timeout: 20000 });
  });
  assert.equal(await page.isDisabled('.footer .btn'), true, 'stopped');
  await page.click('.poison-warn .ack input');
  assert.equal(await page.isDisabled('.footer .btn'), false, 'continues once checked');
  // the real recipient: recognised
  await page.fill('.field input.mono', real.toString({ urlSafe: true, bounceable: false }));
  await page.waitForSelector('.field .green', { timeout: 10000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a jetton added by hand is listed', async () => {
  const page = await openWallet(TON, { name: 'ton-custom-jetton' });
  // the phrase's second account: no USD₮ when this file runs alone (ton.test.mjs sends it some); the zero balance
  // itself is covered by tests/tonextras.test.js
  await page.evaluate(async () => { const r = await chrome.runtime.sendMessage({ type: 'getState' }); await chrome.runtime.sendMessage({ type: 'selectAccount', address: r.result.accounts[1].address }); });
  await step(page, 'add', async () => {
    await page.waitForSelector('.hero .label', { timeout: 15000 });
    await page.click('.item:has-text("Add custom token")');
    await page.fill('.sheet input.mono', STATE.ton.jetton);
    await page.waitForSelector('.sheet .card:has-text("USD₮")', { timeout: 15000 });
    await page.click('.sheet .btn:has-text("Add token")');
    await page.waitForSelector('.toast:has-text("USD₮ added")');
  });
  await step(page, 'listed', () => waitFor(async () => /USD₮/.test(await page.locator('.list').first().innerText()), { what: 'USD₮ in the token list', timeout: 20000 }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
