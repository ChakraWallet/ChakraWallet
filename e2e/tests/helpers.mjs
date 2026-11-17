// Shared by the end-to-end tests: the environment's addresses, the browser, a wallet opened on a network, the password
// sheet, waiting for a condition, on-chain balances.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider, Contract, HDNodeWallet, Mnemonic } from 'ethers';

export const STATE = JSON.parse(fs.readFileSync(process.env.E2E_STATE, 'utf8'));
export const APP = process.env.E2E_APP;
export const MNEMONIC = 'test test test test test test test test test test test junk';
export const PASSWORD = 'e2e-password-1234';
export const ARTIFACTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.artifacts');

/** The phrase's i-th Ethereum account (the wallet uses the first; the others are recipients). */
export const evmAccount = (i) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).address;
export const net = (key) => STATE.evm.find((n) => n.key === key);
export const provider = (n) => new JsonRpcProvider(n.rpc, n.id, { staticNetwork: true });
export const usdc = (n) => new Contract(n.usdc, STATE.abi.token, provider(n));
export const ethBalance = (n, a) => provider(n).getBalance(a);
export const usdcBalance = (n, a) => usdc(n).balanceOf(a);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 20000, every = 250, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// Chromium: CHROME_PATH, else a system one, else the one Playwright downloads (CI: npx playwright install chromium)
const CHROME = process.env.CHROME_PATH || ['/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
let browserP = null;
export const browser = () => (browserP ??= chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }));
export async function closeBrowser() { if (browserP) await (await browserP).close(); browserP = null; }

/**
 * A fresh wallet (the test phrase) open on a network, on the home screen. Only local addresses can be reached:
 * anything else fails, so a test can never touch a real network or service.
 */
export async function openWallet(chainId, { name = 'wallet' } = {}) {
  const ctx = await (await browser()).newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'en-US' });
  await ctx.route('**/*', (route) => (/^(https?|wss?):\/\/(127\.0\.0\.1|localhost)[:/]/.test(route.request().url()) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => { if (!/want\?\.some/.test(e.message)) page.errors.push(e.message); });
  page.shot = async (label) => { fs.mkdirSync(ARTIFACTS, { recursive: true }); await page.screenshot({ path: path.join(ARTIFACTS, `${name}-${label}.png`) }).catch(() => {}); };
  await page.goto(APP);
  await page.waitForFunction(() => globalThis.chrome?.runtime);
  await page.evaluate(async ({ mnemonic, password, chainId }) => {
    const bg = async (type, p = {}) => { const r = await chrome.runtime.sendMessage({ type, ...p }); if (!r?.ok) throw new Error(`${type}: ${r?.error}`); return r.result; };
    // tonCenterKey, tonApiKey: their faster pace (the local TON API ignores the keys)
    await bg('saveSettings', { settings: { language: 'en', notifications: false, autoLockMin: 240, tonCenterKey: 'e2e', tonApiKey: 'e2e', termsAccepted: { version: 1, at: 0 } } }); // terms of use accepted (src/ui/terms.jsx)
    await bg('createVault', { password, mnemonic, name: 'Main' });
    await bg('addAccount', { name: 'Second', mode: 'hd' });
    const { accounts } = await bg('getState');
    await bg('selectAccount', { address: accounts[0].address });
    await bg('setChain', { chainId });
  }, { mnemonic: MNEMONIC, password: PASSWORD, chainId });
  await sleep(300);
  await page.reload();
  await page.waitForFunction(() => globalThis.chrome?.runtime);
  await page.evaluate((password) => chrome.runtime.sendMessage({ type: 'unlock', password }), PASSWORD);
  await page.waitForSelector('.hero .total');
  // balances loaded (the total is a number, not a placeholder): the screens that follow see them
  await page.waitForFunction(() => { const t = document.querySelector('.hero .total'); return t && !t.querySelector('.skeleton') && /\d/.test(t.textContent); }, null, { timeout: 30000 });
  await page.waitForSelector('.list .item .bold', { timeout: 30000 });
  return page;
}

/** The wallet password sheet: type the password, authorize. */
export async function authorize(page) {
  const input = await page.waitForSelector('.sheet input[type=password]', { timeout: 15000 });
  await input.fill(PASSWORD);
  await page.click('.sheet .btn:not(.secondary)');
}

/** The text of the screen (for assertions and failure messages). */
export const screenText = (page) => page.evaluate(() => document.querySelector('#app')?.innerText || '');
export const units = (v, d) => Number(v) / 10 ** d;

// ---------------------------------------------------------------- TON (the local TON API of e2e/env/ton.mjs)
const tonApi = (path, q) => fetch(`${STATE.ton.api}/api/v3/${path}?${new URLSearchParams(q)}`).then((r) => r.json());
export const tonWallet = (address) => tonApi('walletInformation', { address });
export const tonGram = async (address) => BigInt((await tonWallet(address)).balance);
export const tonUsdt = async (address) => BigInt((await tonApi('jetton/wallets', { owner_address: address })).jetton_wallets[0]?.balance || 0);
export async function tonAccount(i) {
  const { hdKeyPair, walletContract } = await import('../../src/shared/ton/core.js');
  return walletContract(hdKeyPair(MNEMONIC, i).publicKey).address.toString({ urlSafe: true, bounceable: false });
}
