// TON, end to end on a local network (@ton/sandbox: the real wallet and jetton contracts check signatures and seqno):
// send, swap and bridge through the real interface, checked on the network. The tests share it, in order.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';
import { openWallet, authorize, closeBrowser, waitFor, screenText, STATE, net, evmAccount, ethBalance, usdcBalance, usdc, tonWallet, tonGram, tonUsdt, tonAccount } from './helpers.mjs';

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

// ---------------------------------------------------------------- the bridge improvements: any EVM token, any recipient,
// gas on arrival, other jettons in two steps

/** The bridge screen, from this wallet's network to `network`; the other choices before the amount. */
async function bridgeForm(page, network, { fromToken, toToken, recipient, refuel } = {}) {
  await page.click('.actions .action:nth-of-type(4)');
  await page.click('.chain-pick >> nth=1');
  await page.click(`.sheet .item:has-text("${network}")`);
  if (fromToken) { await page.locator('.bridge-side').nth(0).locator('.token-select').click(); await page.click(`.sheet .item:has-text("${fromToken}")`); }
  if (toToken) { await page.locator('.bridge-side').nth(1).locator('.token-select').click(); await page.click(`.sheet .item:has-text("${toToken}")`); }
  if (recipient) {
    await page.click('.bridge-side .recip');
    await page.fill('.sheet .field input.mono', recipient);
    await page.click('.sheet .btn:has-text("Use this address")');
  }
  if (refuel) await page.click('.refuel');
}

test('bridge USDC from Local A to another TON address (any EVM token; a warning about the memo)', async () => {
  const A = net('a');
  const page = await openWallet(A.id, { name: 'ton-bridge-usdc-in' });
  const to = await tonAccount(3); // not an account of the wallet
  const before = await tonGram(to);
  await step(page, 'form', async () => {
    await bridgeForm(page, 'TON Local', { fromToken: 'USDC', toToken: 'GRAM', recipient: to });
    await page.waitForSelector('.warn:has-text("outside this wallet")');
    await page.waitForSelector('.warn:has-text("comment (memo)")'); // arriving on TON: no memo for an exchange
    await page.fill('.bridge-side .input-wrap input', '30');
    await page.waitForSelector('.quote:has-text("Relay")', { timeout: 20000 });
    await page.click('.footer .btn');
  });
  await step(page, 'approve', async () => {
    await page.waitForSelector('.footer .btn:has-text("Approve")');
    await page.waitForSelector('.fee-box .speeds');
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  await step(page, 'deposit', async () => {
    await page.waitForSelector('.footer .btn:has-text("Send transfer"):not([disabled])', { timeout: 30000 });
    await page.click('.footer .btn:last-child');
  });
  // 30 USDC -> 10 GRAM (a new account: TON takes a tiny storage fee on arrival)
  await step(page, 'arrival', () => waitFor(async () => { const d = (await tonGram(to)) - before; return d > 10n * GRAM - GRAM / 100n && d <= 10n * GRAM; }, { timeout: 40000, what: '10 GRAM at the other address' }));
  assert.equal(await usdc(A).allowance(evmAccount(0), A.bridge), 0n);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('bridge GRAM from TON to USDC for another address on Local A, with gas on arrival', async () => {
  const A = net('a');
  const other = evmAccount(6);
  const page = await openWallet(TON, { name: 'ton-bridge-usdc-out' });
  const usdcBefore = await usdcBalance(A, other), ethBefore = await ethBalance(A, other);
  await step(page, 'form', async () => {
    await bridgeForm(page, A.name, { toToken: 'USDC', recipient: other, refuel: true });
    await page.fill('.bridge-side .input-wrap input', '20');
    await page.waitForSelector('.quote:has-text("Relay"):has-text("gas")', { timeout: 20000 }); // the quote includes the top-up
    await page.click('.footer .btn');
    await page.waitForSelector('.fee-box');
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  // 20 GRAM = $60: $3 of it as 0.001 ETH for gas, the rest in USDC
  await step(page, 'usdc', () => waitFor(async () => (await usdcBalance(A, other)) - usdcBefore === parseUnits('57', 6), { timeout: 40000, what: '57 USDC at the recipient' }));
  await step(page, 'gas', () => waitFor(async () => (await ethBalance(A, other)) - ethBefore === parseEther('0.001'), { timeout: 20000, what: '0.001 ETH for gas' }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// The local USD₮ isn't the bridges' USD₮ (another address): for the app it is any other jetton, so the route is the
// two-step one, the same as for NOT, DOGS and the others on mainnet.
test('bridge a jetton in two steps: swap to GRAM on TON (Omniston), then GRAM to Local A (Relay)', async () => {
  const A = net('a');
  const page = await openWallet(TON, { name: 'ton-bridge-two-step' });
  const before = await ethBalance(A, evmAccount(0)), usdtBefore = await tonUsdt(ME);
  await step(page, 'form', async () => {
    await bridgeForm(page, A.name, { fromToken: 'USD₮', toToken: 'ETH' }); // a stablecoin would default to USDC
    await page.fill('.bridge-side .input-wrap input', '30');
    await page.waitForSelector('.quote:has-text("Omniston + Relay"):has-text("2 steps")', { timeout: 20000 });
    // before anything is signed, what will happen: both operations, with the amounts
    const text = await screenText(page);
    assert.match(text, /This transfer takes two operations/);
    assert.match(text, /Swap 30 USD₮ for at least 10 GRAM on TON/);
    assert.match(text, /Send those 10 GRAM to Local A/);
    await page.click('.footer .btn');
  });
  await step(page, 'swap', async () => {
    await page.waitForSelector('text=Step 1 of 2: swap on TON');
    await page.waitForSelector('.info:has-text("First the swap")');
    await page.waitForSelector('.fee-box');
    await page.click('.footer .btn:last-child');
    await authorize(page);
  });
  await step(page, 'bridge', async () => {
    await page.waitForSelector('text=Step 2 of 2: transfer', { timeout: 30000 });
    await page.waitForSelector('.info:has-text("The swap is done")');
    await page.waitForSelector('.footer .btn:has-text("Send transfer"):not([disabled])', { timeout: 60000 }); // the GRAM have arrived
    await page.click('.footer .btn:last-child'); // the same authorization: no password
  });
  assert.equal(usdtBefore - (await tonUsdt(ME)), 30n * USDT);
  // 10 GRAM -> 0.01 ETH
  await step(page, 'arrival', () => waitFor(async () => (await ethBalance(A, evmAccount(0))) - before === parseEther('0.01'), { timeout: 40000, what: '0.01 ETH on Local A' }));
  await step(page, 'tracked', () => page.waitForSelector('text=The funds have arrived on Local A', { timeout: 40000 }));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
