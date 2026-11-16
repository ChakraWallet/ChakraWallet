// Walks the wallet screens of one network in the demo build (invented data, see mocks/) and saves a screenshot of
// each: a quick look at a chain driver, new or changed. Usage:
//   node shots/build-demo.mjs && node shots/check-chain.mjs <chainId> [outDir]      (e.g. 1 for Ethereum, -239 for TON)
// The network needs its mocks in mocks/fetch.js (balances, history, quotes...) to show data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve, browser, phone, sleep } from './lib.mjs';

const chainId = Number(process.argv[2] ?? 1);
const out = path.resolve(process.argv[3] || path.join(path.dirname(new URL(import.meta.url).pathname), '.check', String(chainId)));
fs.mkdirSync(out, { recursive: true });
const { server, url } = await serve();
const b = await browser();
const ENTROPY = crypto.createHash('sha256').update('chakra-landing-demo-v1').digest().subarray(0, 16).toString('hex');

async function open() {
  const page = await phone(b, url);
  page.on('pageerror', (e) => { if (!/want\?\.some/.test(e.message)) console.log('  [page error]', e.message); });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.chrome?.runtime && globalThis.__demoEthers);
  await page.evaluate(async ({ entropy, chainId }) => {
    const bg = async (type, p = {}) => { const r = await chrome.runtime.sendMessage({ type, ...p }); if (!r?.ok) throw new Error(`${type}: ${r?.error}`); return r.result; };
    await bg('saveSettings', { settings: { language: 'en', theme: 'light', notifications: false, autoLockMin: 240, termsAccepted: { version: 1, at: 0 } } }); // terms of use accepted (src/ui/terms.jsx)
    await bg('createVault', { password: 'demo-password-x', mnemonic: globalThis.__demoEthers.Mnemonic.fromEntropy('0x' + entropy).phrase, name: 'Main' });
    await bg('addAccount', { name: 'Savings', mode: 'hd' });
    const { accounts } = await bg('getState');
    await bg('selectAccount', { address: accounts[0].address });
    await bg('setChain', { chainId });
  }, { entropy: ENTROPY, chainId });
  await sleep(400); await page.reload();
  await page.waitForFunction(() => globalThis.chrome?.runtime);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'unlock', password: 'demo-password-x' }));
  await page.waitForSelector('.hero .total', { timeout: 20000 });
  await page.waitForSelector('.list .item .bold', { timeout: 40000 }).catch(() => {});
  await sleep(2500);
  return page;
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('ok  ', name); };
const step = async (name, fn) => {
  const page = await open();
  try { await fn(page); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); await shot(page, `${name}-fail`).catch(() => {}); }
  await page.context().close();
};

await step('home', async (p) => {
  await shot(p, 'home');
  await p.click('.list .item:nth-of-type(2)'); await sleep(2500); await shot(p, 'token');
});
await step('activity', async (p) => {
  await p.click('.tabs .tab:nth-of-type(2)'); await p.waitForSelector('.hist-item', { timeout: 30000 }); await sleep(1200); await shot(p, 'activity');
  await p.click('.hist-item'); await sleep(2500); await shot(p, 'activity-detail');
});
await step('receive', async (p) => { await p.click('.actions .action:nth-of-type(2)'); await sleep(1500); await shot(p, 'receive'); });
await step('send', async (p) => {
  await p.click('.actions .action:nth-of-type(1)'); await sleep(1200);
  await p.click('.card.flat .item'); // the wallet's other account, as recipient (its address on this network)
  await p.fill('.input-wrap input', '1.5'); await sleep(500); await shot(p, 'send');
  await p.click('.footer .btn'); await sleep(4000); await shot(p, 'send-review');
});
await step('swap', async (p) => {
  await p.click('.actions .action:nth-of-type(3)'); await sleep(1500);
  await p.fill('.screen input.input.big', '1'); await sleep(4000); await shot(p, 'swap');
  await p.click('.footer .btn'); await sleep(3000); await shot(p, 'swap-review');
});
await step('bridge', async (p) => {
  await p.click('.actions .action:nth-of-type(4)'); await sleep(2500);
  await p.fill('.bridge-side .input-wrap input', '1'); await sleep(4500); await shot(p, 'bridge');
});
await b.close(); server.close();
console.log('screenshots in', path.relative(process.cwd(), out));
