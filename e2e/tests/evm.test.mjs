// EVM, end to end on local networks (Anvil): send, swap and bridge through the real interface, signed by the wallet,
// checked on-chain. Balances are compared before / after (the tests share the networks, in order).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';
import { openWallet, authorize, closeBrowser, waitFor, screenText, net, evmAccount, ethBalance, usdcBalance, usdc } from './helpers.mjs';

const A = net('a'), B = net('b');
const ME = evmAccount(0), OTHER = evmAccount(5); // a recipient outside the wallet
after(closeBrowser);

/** Runs a step of a test; on failure, a screenshot and the screen's text in the error. */
async function step(page, label, fn) {
  try { return await fn(); } catch (e) {
    await page.shot(label);
    throw new Error(`${label}: ${e.message}\n--- screen ---\n${(await screenText(page)).slice(0, 1200)}\n--- page errors ---\n${page.errors.join('\n')}`);
  }
}

async function sendFrom(page, { to, amount, token }) {
  await page.click('.actions .action:nth-of-type(1)');
  await page.fill('.field input.mono', to);
  if (token) {
    await page.click('.input-wrap .token-select');
    await page.click(`.sheet .item:has-text("${token}")`);
  }
  await page.fill('.input-wrap input', amount);
  await page.click('.footer .btn');
  await page.waitForSelector('.fee-box .speeds'); // the network fee, estimated by the node
  await page.click('.footer .btn:last-child');
  await authorize(page);
  await page.waitForSelector('h2:has-text("Transaction sent")', { timeout: 20000 });
}

test('send ETH: signed by the wallet, mined, in the history', async () => {
  const page = await openWallet(A.id, { name: 'send-eth' });
  const before = await ethBalance(A, OTHER);
  await step(page, 'send', () => sendFrom(page, { to: OTHER, amount: '1.5' }));
  await step(page, 'balance', () => waitFor(async () => (await ethBalance(A, OTHER)) - before === parseEther('1.5'), { what: 'the recipient to receive 1.5 ETH' }));
  await step(page, 'history', async () => {
    await page.click('.footer .btn'); // Done
    await page.click('.tabs .tab:nth-of-type(2)');
    await page.waitForSelector('.hist-item:has-text("Sent ETH")', { timeout: 20000 });
  });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('send a token (USDC)', async () => {
  const page = await openWallet(A.id, { name: 'send-usdc' });
  const before = await usdcBalance(A, OTHER);
  await step(page, 'send', () => sendFrom(page, { to: OTHER, amount: '100', token: 'USDC' }));
  await step(page, 'balance', () => waitFor(async () => (await usdcBalance(A, OTHER)) - before === parseUnits('100', 6), { what: 'the recipient to receive 100 USDC' }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

async function swap(page, { amount, flip }) {
  await page.click('.actions .action:nth-of-type(3)');
  await page.waitForSelector('.card .token-select:has-text("USDC")'); // ETH -> USDC by default
  if (flip) await page.click('.swap-flip'); // USDC -> ETH
  await page.fill('.screen input.input.big', amount);
  await page.waitForSelector('.quote:has-text("KyberSwap")', { timeout: 20000 }); // the simulated aggregator's quote
  await page.click('.footer .btn');
}

test('swap ETH -> USDC: quote, one transaction, exact output', async () => {
  const page = await openWallet(A.id, { name: 'swap-eth' });
  const before = await usdcBalance(A, ME);
  await step(page, 'swap', async () => {
    await swap(page, { amount: '0.5' });
    await page.waitForSelector('.fee-box .speeds');
    assert.equal(await page.locator('.steps').count(), 0, 'no approval for the native coin');
    await page.click('.footer .btn:last-child');
    await authorize(page);
    await page.waitForSelector('h2:has-text("Swap sent")', { timeout: 20000 });
  });
  await step(page, 'balance', () => waitFor(async () => (await usdcBalance(A, ME)) - before === parseUnits('1500', 6), { what: '1,500 USDC (0.5 ETH at 3,000)' }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('swap USDC -> ETH: approval of the exact amount, then the swap, one password', async () => {
  const page = await openWallet(A.id, { name: 'swap-usdc' });
  const usdcBefore = await usdcBalance(A, ME);
  await step(page, 'approve', async () => {
    await swap(page, { amount: '300', flip: true });
    await page.waitForSelector('.steps'); // two steps: approval + swap
    await page.waitForSelector('.footer .btn:has-text("Approve")');
    await page.waitForSelector('.fee-box .speeds');
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  await step(page, 'swap', async () => {
    await page.waitForSelector('.footer .btn:has-text("Confirm swap"):not([disabled])', { timeout: 30000 });
    await page.click('.footer .btn:last-child');
    // the same authorization covers the second transaction: no password sheet
    await page.waitForSelector('h2:has-text("Swap sent")', { timeout: 20000 });
  });
  await step(page, 'balance', () => waitFor(async () => usdcBefore - (await usdcBalance(A, ME)) === parseUnits('300', 6), { what: '300 USDC to leave' }));
  // the approval was for exactly 300 USDC, used up by the swap: nothing left for the router
  assert.equal(await usdc(A).allowance(ME, A.dex), 0n);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

async function bridge(page, { amount, token }) {
  await page.click('.actions .action:nth-of-type(4)');
  await page.click('.chain-pick >> nth=1'); // destination network
  await page.click(`.sheet .item:has-text("${B.name}")`);
  if (token) {
    await page.click('.bridge-side .token-select >> nth=0');
    await page.click(`.sheet .item:has-text("${token}")`);
  }
  await page.fill('.bridge-side .input-wrap input', amount);
  await page.waitForSelector('.quote:has-text("Relay")', { timeout: 20000 });
  await page.click('.footer .btn');
}

test('bridge ETH from Local A to Local B: deposit, relayed, tracked until it arrives', async () => {
  const page = await openWallet(A.id, { name: 'bridge-eth' });
  const before = await ethBalance(B, ME);
  await step(page, 'bridge', async () => {
    await bridge(page, { amount: '1' });
    await page.waitForSelector('.fee-box .speeds');
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  await step(page, 'arrival', () => waitFor(async () => (await ethBalance(B, ME)) - before === parseEther('0.998'), { what: '0.998 ETH on Local B' }));
  await step(page, 'tracked', () => page.waitForSelector('text=The funds have arrived on Local B', { timeout: 40000 })); // the app polls the provider
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('bridge USDC from Local A to Local B: approval of the exact amount, then the deposit', async () => {
  const page = await openWallet(A.id, { name: 'bridge-usdc' });
  const before = await usdcBalance(B, ME);
  await step(page, 'approve', async () => {
    await bridge(page, { amount: '50', token: 'USDC' });
    await page.waitForSelector('.footer .btn:has-text("Approve")');
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  await step(page, 'deposit', async () => {
    await page.waitForSelector('.footer .btn:has-text("Send transfer"):not([disabled])', { timeout: 30000 });
    await page.click('.footer .btn:last-child');
  });
  await step(page, 'arrival', () => waitFor(async () => (await usdcBalance(B, ME)) - before === parseUnits('49.9', 6), { what: '49.9 USDC on Local B' }));
  assert.equal(await usdc(A).allowance(ME, A.bridge), 0n);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
