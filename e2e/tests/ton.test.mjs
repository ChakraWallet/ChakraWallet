// TON, end to end on a local network (@ton/sandbox: the real wallet and jetton contracts check signatures and seqno):
// send, swap and bridge through the real interface, checked on the network. The tests share it, in order.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { openWallet, authorize, closeBrowser, waitFor, screenText, STATE, net, evmAccount, ethBalance, tonWallet, tonGram, tonUsdt, tonAccount } from './helpers.mjs';

const TON = STATE.ton.id, ME = STATE.ton.user;
const GRAM = 10n ** 9n, USDT = 10n ** 6n;
after(closeBrowser);

async function step(page, label, fn) {
  try { return await fn(); } catch (e) {
    await page.shot(label);
    throw new Error(`${label}: ${e.message}\n--- screen ---\n${(await screenText(page)).slice(0, 1200)}\n--- page errors ---\n${page.errors.join('\n')}`);
  }
}

async function sendFrom(page, { to, amount, token, memo }) {
  await page.click('.actions .action:nth-of-type(1)');
  await page.fill('.field input.mono', to);
  if (token) {
    await page.click('.input-wrap .token-select');
    await page.click(`.sheet .item:has-text("${token}")`);
  }
  await page.fill('.input-wrap input', amount);
  if (memo) await page.fill('.field input[maxlength="500"]', memo);
  await page.click('.footer .btn');
  await page.waitForSelector('.fee-box .fee-row:has-text("GRAM")'); // the fee estimate
  await page.click('.footer .btn:last-child');
  await authorize(page);
  await page.waitForSelector('h2:has-text("Send confirmed")', { timeout: 30000 }); // the app waits for the seqno to move
}

test('send GRAM with a comment: the first send also deploys the wallet', async () => {
  const page = await openWallet(TON, { name: 'ton-send' });
  const other = await tonAccount(1);
  assert.equal((await tonWallet(ME)).status, 'uninit', 'the wallet starts not deployed');
  await step(page, 'notice', () => page.waitForSelector('.info:has-text("first")')); // home: deployed with the first send
  const before = await tonGram(other);
  await step(page, 'send', () => sendFrom(page, { to: other, amount: '2.5', memo: 'e2e test' }));
  assert.equal(await tonGram(other) - before, 2500000000n);
  assert.equal((await tonWallet(ME)).status, 'active', 'deployed by the first send');
  await step(page, 'history', async () => {
    await page.click('.footer .btn');
    await page.click('.tabs .tab:nth-of-type(2)');
    await page.waitForSelector('.hist-item:has-text("Sent GRAM")', { timeout: 20000 });
  });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('send a jetton (USD₮)', async () => {
  const page = await openWallet(TON, { name: 'ton-jetton' });
  const other = await tonAccount(1);
  const before = await tonUsdt(other);
  await step(page, 'send', () => sendFrom(page, { to: other, amount: '25', token: 'USD₮' }));
  await step(page, 'balance', () => waitFor(async () => (await tonUsdt(other)) - before === 25n * USDT, { what: '25 USD₮ to arrive' }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

async function swap(page, { amount, flip }) {
  await page.click('.actions .action:nth-of-type(3)');
  await page.waitForSelector('.card .token-select:has-text("USD₮")'); // GRAM -> USD₮ by default
  if (flip) await page.click('.swap-flip');
  await page.fill('.screen input.input.big', amount);
  await page.waitForSelector('.quote:has-text("StonFiV2")', { timeout: 20000 }); // the simulated Omniston's live quote
  await page.click('.footer .btn');
  await page.waitForSelector('.fee-box .fee-row:has-text("GRAM")');
  await page.click('.footer .btn:last-child');
  await authorize(page);
  await page.waitForSelector('h2:has-text("Swap completed")', { timeout: 30000 });
}

test('swap GRAM -> USD₮ (Omniston quote, messages built by the service, signed by the wallet)', async () => {
  const page = await openWallet(TON, { name: 'ton-swap-gram' });
  const before = await tonUsdt(ME);
  await step(page, 'swap', () => swap(page, { amount: '10' }));
  await step(page, 'balance', () => waitFor(async () => (await tonUsdt(ME)) - before === 30n * USDT, { what: '30 USD₮ (10 GRAM at $3)' }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('swap USD₮ -> GRAM (a jetton transfer to the DEX)', async () => {
  const page = await openWallet(TON, { name: 'ton-swap-usdt' });
  const usdtBefore = await tonUsdt(ME), gramBefore = await tonGram(ME);
  await step(page, 'swap', () => swap(page, { amount: '30', flip: true }));
  await step(page, 'balance', () => waitFor(async () => usdtBefore - (await tonUsdt(ME)) === 30n * USDT, { what: '30 USD₮ to leave' }));
  // 10 GRAM back, minus the gas of the jetton transfer (the unused part returns)
  await step(page, 'gram', () => waitFor(async () => { const d = (await tonGram(ME)) - gramBefore; return d > 9n * GRAM && d < 10n * GRAM; }, { what: 'about 10 GRAM back' }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

async function bridgeTo(page, network, amount) {
  await page.click('.actions .action:nth-of-type(4)');
  await page.click('.chain-pick >> nth=1');
  await page.click(`.sheet .item:has-text("${network}")`);
  await page.fill('.bridge-side .input-wrap input', amount);
  await page.waitForSelector('.quote:has-text("Relay")', { timeout: 20000 });
  await page.click('.footer .btn');
  await page.waitForSelector('.fee-box');
  await page.click('.footer .btn:last-child');
  await authorize(page);
}

test('bridge GRAM from TON to Local A (a TON transfer, relayed to the EVM side)', async () => {
  const A = net('a');
  const page = await openWallet(TON, { name: 'ton-bridge-out' });
  const before = await ethBalance(A, evmAccount(0));
  await step(page, 'bridge', () => bridgeTo(page, A.name, '5'));
  await step(page, 'arrival', () => waitFor(async () => (await ethBalance(A, evmAccount(0))) - before === parseEther('0.005'), { timeout: 40000, what: '0.005 ETH on Local A (5 GRAM at $3)' }));
  await step(page, 'tracked', () => page.waitForSelector('text=The funds have arrived on Local A', { timeout: 40000 }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('bridge ETH from Local A to TON (an EVM deposit, paid in GRAM)', async () => {
  const A = net('a');
  const page = await openWallet(A.id, { name: 'ton-bridge-in' });
  const before = await tonGram(ME);
  await step(page, 'bridge', () => bridgeTo(page, 'TON Local', '0.01'));
  // 10 GRAM, minus the storage fee TON takes from the receiving account in that transaction (a few nanoGRAM)
  await step(page, 'arrival', () => waitFor(async () => { const d = (await tonGram(ME)) - before; return d > 10n * GRAM - GRAM / 100n && d <= 10n * GRAM; }, { timeout: 40000, what: '10 GRAM on TON (0.01 ETH at $3,000)' }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
