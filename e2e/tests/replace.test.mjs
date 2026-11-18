// Speed up and cancel, end to end on a local network (Anvil with automatic mining off, so a transaction stays
// waiting): sent from the wallet, replaced from the history's details, then one block mined - only the replacement
// is in it, and the history shows the operation once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { openWallet, authorize, closeBrowser, waitFor, screenText, net, evmAccount, ethBalance, provider } from './helpers.mjs';

const A = net('a');
const ME = evmAccount(0), OTHER = evmAccount(6);
const rpc = (method, params = []) => provider(A).send(method, params);
after(async () => { await rpc('evm_setAutomine', [true]).catch(() => {}); await closeBrowser(); });

async function step(page, label, fn) {
  try { return await fn(); } catch (e) {
    await page.shot(label);
    throw new Error(`${label}: ${e.message}\n--- screen ---\n${(await screenText(page)).slice(0, 1200)}\n--- page errors ---\n${page.errors.join('\n')}`);
  }
}

/** Sends ETH from the wallet; it stays waiting (no mining). Then the home's activity, and its details. */
async function sendAndOpen(page, amount) {
  await page.click('.actions .action:nth-of-type(1)');
  await page.fill('.field input.mono', OTHER);
  await page.fill('.input-wrap input', amount);
  await page.click('.footer .btn');
  await page.waitForSelector('.fee-box .speeds');
  await page.click('.footer .btn:last-child');
  await authorize(page);
  await page.waitForSelector('h2:has-text("Transaction sent")', { timeout: 20000 });
  await page.click('.footer .btn'); // Done
  await page.click('.tabs .tab:nth-of-type(2)');
  await page.click('.hist-item:has-text("Pending")', { timeout: 20000 });
  await page.waitForSelector('.tx-replace');
}

/** The transactions of the wallet in the latest block. */
async function minedFromMe() {
  const b = await rpc('eth_getBlockByNumber', ['latest', true]);
  return b.transactions.filter((x) => x.from.toLowerCase() === ME.toLowerCase());
}
const lastLogged = (page) => page.evaluate(async (key) => ((await chrome.storage.local.get('txlog')).txlog?.[key] || [])[0], `${A.id}:${ME.toLowerCase()}`);

test('speed up: the same transfer, higher fee, mined alone; the history shows it once, sped up', async () => {
  const page = await openWallet(A.id, { name: 'speedup' });
  await rpc('evm_setAutomine', [false]);
  try {
    const before = await ethBalance(A, OTHER);
    await step(page, 'send', () => sendAndOpen(page, '0.25'));
    await step(page, 'speed up', async () => {
      await page.click('.tx-replace .btn:not(.secondary)');
      await page.waitForSelector('h1:has-text("Speed up transaction")');
      await page.waitForSelector('.fee-box .speeds');
      await page.waitForSelector('.fee-row:has-text("Fee offered before")');
      await page.click('.footer .btn:last-child');
      await authorize(page);
      await page.waitForSelector('h2:has-text("Speed-up sent")', { timeout: 20000 });
    });
    const sped = await lastLogged(page);
    assert.equal(sped.mode, 'speedUp');
    await rpc('evm_mine');
    const txs = await minedFromMe();
    assert.deepEqual(txs.map((x) => x.hash), [sped.hash], 'only the replacement is mined');
    assert.equal(BigInt(txs[0].nonce), BigInt(sped.nonce));
    assert.equal((await ethBalance(A, OTHER)) - before, parseEther('0.25'), 'the transfer, once');
    await step(page, 'history', async () => {
      await page.click('.footer .btn'); // Done: the whole history
      await page.waitForSelector('.hist-item:has-text("Sped up")', { timeout: 20000 });
      assert.equal(await page.locator('.hist-item:has-text("Pending")').count(), 0);
      assert.equal(await page.locator('.hist-item:has-text("Replaced")').count(), 0, 'the original is not a row of its own');
    });
    assert.deepEqual(page.errors, []);
  } finally { await rpc('evm_setAutomine', [true]); }
  await page.context().close();
});

test('cancel: 0 to oneself takes its place; nothing reaches the recipient; the history says cancelled', async () => {
  const page = await openWallet(A.id, { name: 'cancel' });
  await rpc('evm_setAutomine', [false]);
  try {
    const before = await ethBalance(A, OTHER);
    await step(page, 'send', () => sendAndOpen(page, '0.1'));
    await step(page, 'cancel', async () => {
      await page.click('.tx-replace .btn.secondary');
      await page.waitForSelector('h1:has-text("Cancel transaction")');
      await page.waitForSelector('.fee-box .speeds');
      await page.click('.footer .btn:last-child');
      await authorize(page);
      await page.waitForSelector('h2:has-text("Cancellation sent")', { timeout: 20000 });
    });
    const cancel = await lastLogged(page);
    assert.equal(cancel.mode, 'cancel');
    await rpc('evm_mine');
    const txs = await minedFromMe();
    assert.equal(txs.length, 1);
    assert.deepEqual([txs[0].hash, txs[0].to.toLowerCase(), BigInt(txs[0].value), txs[0].input], [cancel.hash, ME.toLowerCase(), 0n, '0x']);
    assert.equal(await ethBalance(A, OTHER), before, 'nothing sent');
    await step(page, 'history', async () => {
      await page.click('.footer .btn');
      await page.waitForSelector('.hist-item:has-text("Cancelled")', { timeout: 20000 });
      assert.equal(await page.locator('.hist-item:has-text("Pending")').count(), 0);
    });
    assert.deepEqual(page.errors, []);
  } finally { await rpc('evm_setAutomine', [true]); }
  await page.context().close();
});
