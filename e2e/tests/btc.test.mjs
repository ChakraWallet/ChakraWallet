// Bitcoin, end to end on a local network (e2e/env/btc.mjs: an Esplora API that checks signatures and the replacement
// rules): the home with the account's balance over its addresses, receiving on SegWit and Taproot addresses and a new
// one, a send with the fee in sat/vB (signed by the wallet, accepted by the node), the history's pending row sped up
// from its details (BIP125: same recipient, more fee), the account's addresses, coins and export page.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { openWallet, authorize, closeBrowser, waitFor, screenText, STATE } from './helpers.mjs';

const B = STATE.btc;
const OTHER = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'; // a recipient outside the wallet (regtest)
const mempool = () => fetch(`${B.api}/e2e/mempool`).then((r) => r.json());
after(closeBrowser);

async function step(page, label, fn) {
  try { return await fn(); } catch (e) {
    await page.shot(label);
    throw new Error(`${label}: ${e.message}\n--- screen ---\n${(await screenText(page)).slice(0, 1200)}\n--- page errors ---\n${page.errors.join('\n')}`);
  }
}

test('bitcoin: balance over the addresses, receive (SegWit, Taproot, a new address), send, speed up, the account page', async () => {
  const page = await openWallet(B.id, { name: 'btc' });
  await step(page, 'home', async () => {
    await page.waitForFunction(() => /0[.,]015/.test(document.querySelector('.list')?.innerText || ''), null, { timeout: 30000 }); // 0.01 + 0.005 BTC
    await page.waitForSelector('.btc-card');
  });
  await step(page, 'receive', async () => {
    await page.click('.actions .action:nth-of-type(2)');
    // the first addresses have been paid (the funds): the next unused ones are offered
    await page.waitForSelector('.card.mono:has-text("bcrt1q")');
    assert.notEqual((await page.textContent('.card.mono')).trim(), B.me.segwit);
    await page.click('.receive-seg button:has-text("Taproot")');
    await page.waitForSelector('.card.mono:has-text("bcrt1p")');
    assert.notEqual((await page.textContent('.card.mono')).trim(), B.me.taproot);
    const before = await page.textContent('.card.mono');
    await page.click('.btn:has-text("New address")');
    await waitFor(async () => (await page.textContent('.card.mono')) !== before, { what: 'a new address' });
    await page.click('.topbar button'); // back
  });
  let first;
  await step(page, 'send', async () => {
    await page.click('.actions .action:nth-of-type(1)');
    await page.fill('.field input.mono', OTHER);
    await page.fill('.input-wrap input', '0.002');
    await page.click('.footer .btn');
    await page.waitForSelector('.fee-box .speeds .speed:has-text("Custom")');
    await page.waitForSelector('.fee-row:has-text("sat/vB")');
    await page.click('.speeds .speed:has-text("Slow")');
    await page.click('.footer .btn:last-child');
    await authorize(page);
    await page.waitForSelector('h2:has-text("Transaction sent")', { timeout: 20000 });
    const list = await waitFor(async () => { const m = await mempool(); return m.length === 1 && m; }, { what: 'the transaction in the mempool' });
    first = list[0];
    assert.ok(first.vout.some((o) => o.scriptpubkey_address === OTHER && o.value === 200_000), 'pays the recipient');
  });
  await step(page, 'speed up', async () => {
    await page.click('.footer .btn'); // Done
    await page.click('.tabs .tab:nth-of-type(2)');
    await page.click('.hist-item:has-text("Pending")', { timeout: 20000 });
    await page.waitForSelector('.tx-replace');
    await page.click('.tx-replace .btn:not(.secondary)');
    await page.waitForSelector('h1:has-text("Speed up transaction")');
    await page.waitForSelector('.fee-box .speeds');
    await page.click('.speeds .speed:has-text("Fast")');
    await page.click('.footer .btn:last-child');
    await authorize(page);
    await page.waitForSelector('h2:has-text("Speed-up sent")', { timeout: 20000 });
    const list = await waitFor(async () => { const m = await mempool(); return m.length === 1 && m[0].txid !== first.txid && m; }, { what: 'the replacement in the mempool' });
    assert.ok(list[0].vout.some((o) => o.scriptpubkey_address === OTHER && o.value === 200_000), 'the recipient gets the same');
    assert.ok(list[0].fee > first.fee, 'more fee');
  });
  await step(page, 'account page', async () => {
    await page.click('.footer .btn'); // Done: the whole history
    await page.waitForSelector('.hist-item:has-text("Sped up")');
    await page.click('.topbar button'); // back home
    await page.click('.tabs .tab:nth-of-type(1)'); // the home's tokens, with the account's card
    await page.waitForSelector('.btc-card', { timeout: 30000 });
    await page.click('.btc-card');
    await page.waitForSelector('.list .item .mono');
    await page.click('.seg button:has-text("Coins")');
    await page.waitForSelector('.item input[type=checkbox]', { timeout: 20000 });
    await page.click('.seg button:has-text("Export")');
    await page.waitForSelector('.mono:has-text("wpkh([")');
    await page.waitForSelector('.mono:has-text("tr([")');
  });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
