// Screenshots of the real app (demo build, invented data) for the landing page -> landing/public/shots/.
// 393x793 pt: an iPhone 15 Pro screen (393x852) below its 59 pt status bar, which the landing page draws.
// Usage: node shots/build-demo.mjs && node shots/capture.mjs [scene ...]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve, browser, phone, sleep } from './lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(HERE, '../public/shots');
fs.mkdirSync(OUT, { recursive: true });

// A fixed, PUBLIC demo seed so every screenshot shows the same accounts (same colours and addresses).
// Never send funds to these addresses: anyone reading this file has the keys.
const DEMO_ENTROPY = crypto.createHash('sha256').update('chakra-landing-demo-v1').digest().subarray(0, 16).toString('hex');
const PASSWORD = 'demo-password-for-screenshots';

/** Wallet with three accounts, unlocked, on the requested network, language and theme. */
async function setup(page, { lang, dark, chainId = 1 }) {
  await page.waitForFunction(() => globalThis.chrome?.runtime && globalThis.__demoEthers);
  await page.evaluate(async ({ entropy, password, lang, dark, chainId }) => {
    const bg = async (type, p = {}) => {
      const r = await chrome.runtime.sendMessage({ type, ...p });
      if (!r?.ok) throw new Error(`${type}: ${r?.error}`);
      return r.result;
    };
    const { Mnemonic } = globalThis.__demoEthers;
    const mnemonic = Mnemonic.fromEntropy('0x' + entropy).phrase;
    await bg('saveSettings', { settings: { language: lang, theme: dark ? 'dark' : 'light', notifications: false, autoLockMin: 240, termsAccepted: { version: 1, at: 0 } } }); // terms of use accepted (src/ui/terms.jsx)
    await bg('createVault', { password, mnemonic, name: 'Main' });
    await bg('addAccount', { name: 'Savings', mode: 'hd' });
    await bg('addAccount', { name: 'DeFi', mode: 'hd' });
    const { accounts } = await bg('getState');
    const names = ['Main', 'Savings', 'DeFi'];
    for (const [i, a] of accounts.entries()) await bg('renameAccount', { address: a.address, name: names[i] });
    await bg('selectAccount', { address: accounts[0].address });
    await bg('setChain', { chainId });
  }, { entropy: DEMO_ENTROPY, password: PASSWORD, lang, dark, chainId });
  // the onboarding screen stays up once shown: reload with the wallet in place, then unlock it
  await sleep(500);
  await page.reload();
  await page.waitForFunction(() => globalThis.chrome?.runtime);
  await page.evaluate((password) => chrome.runtime.sendMessage({ type: 'unlock', password }), PASSWORD);
  await page.waitForSelector('.hero .total', { timeout: 20000 });
  await sleep(1800); // balances, count-up animation, guilloche drawing
}

const tab = (page, k) => page.click(`nav.tabpill button:nth-of-type(${{ wallet: 1, browser: 2, predict: 3, contracts: 4, donate: 5 }[k]})`);
const action = (page, n) => page.click(`.actions .action:nth-of-type(${n})`);

const SCENES = {
  async home() {},
  async activity(page) { await page.click('.tabs .tab:nth-of-type(2)'); await sleep(900); },
  async accounts(page) { await page.click('.account-btn'); await sleep(4500); },
  async swap(page) {
    await action(page, 3); await sleep(800);
    await page.fill('.screen input.input.big', '0.5'); await sleep(2200);
  },
  async nfts(page) { // the NFT grid under the tokens, at the top of the screen
    await page.waitForSelector('.nft-section', { timeout: 20000 }); await sleep(1200);
    await page.evaluate(() => { const c = document.querySelector('.nft-section'); const s = c.closest('.content') || document.scrollingElement; s.scrollTop += c.getBoundingClientRect().top - 130; });
    await sleep(900);
  },
  async receive(page) { await action(page, 2); await sleep(1200); },
  async send(page) { await action(page, 1); await sleep(1200); },
  async predict(page) { await tab(page, 'predict'); await sleep(2600); },
  async browser(page) { await tab(page, 'browser'); await sleep(1500); },
  async contracts(page) { await tab(page, 'contracts'); await sleep(1500); },
  async donate(page) { await tab(page, 'donate'); await sleep(2200); },
  // MetaMask Card (Linea): the card brought in front of the balance card, its operations, its payments, its limits
  async mmcard(page) { await page.waitForSelector('.hs-slot.back', { timeout: 20000 }); await page.click('.hs-dots button:nth-child(2)'); await sleep(1500); },
  async mmcardOps(page) { // the operations tab, scrolled to the top of the screen
    await SCENES.mmcard(page);
    await page.evaluate(() => { const c = document.querySelector('.tabs'); const s = c.closest('.content') || document.scrollingElement; s.scrollTop += c.getBoundingClientRect().top - 120; });
    await sleep(900);
  },
  async mmcardPayments(page) { await SCENES.mmcard(page); await page.click('.tabs .tab:nth-of-type(2)'); await sleep(1200); },
  async mmcardManage(page) { await SCENES.mmcard(page); await action(page, 3); await sleep(1800); },
  // Tron: the Resources page (energy and bandwidth), from the card on the home
  async tron(page) { // after the needle and the battery have settled
    await page.waitForSelector('.tr-card .tr-row-val', { timeout: 20000 }); await sleep(600); await page.click('.tr-card');
    await page.waitForSelector('.tr-meters .tr-needle', { timeout: 20000 }); await page.waitForSelector('.tr-box .tr-line', { timeout: 20000 });
    await page.addStyleTag({ content: '.tr-batt-sheen { display: none; }' }); // the charging sheen moves: in a still it looks like a smudge
    await sleep(1600);
  },
};
const CHAIN = { mmcard: 59144, mmcardOps: 59144, mmcardPayments: 59144, mmcardManage: 59144, tron: -195 }; // scenes on another network than Ethereum

const only = process.argv.slice(2);
const { server, url } = await serve();
const b = await browser();
const runs = [];
for (const lang of ['en']) { // the landing page is in English only
  for (const name of Object.keys(SCENES)) runs.push({ name, lang, dark: false, chainId: CHAIN[name] });
  if (!process.env.NO_DARK) for (const name of ['home', 'predict', 'swap', 'nfts', 'donate', 'mmcard']) runs.push({ name, lang, dark: true, chainId: CHAIN[name] });
}
for (const r of runs.filter((x) => !only.length || only.includes(x.name))) {
  const file = `${r.name}${r.dark ? '-dark' : ''}.jpg`;
  const page = await phone(b, url, r);
  try {
    await page.goto(url);
    await setup(page, r);
    await SCENES[r.name](page);
    await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 86 });
    console.log('ok  ', file);
  } catch (e) {
    console.log('FAIL', file, e.message.split('\n')[0]);
    if (process.env.DEBUG_DIR) {
      await page.screenshot({ path: path.join(process.env.DEBUG_DIR, file) }).catch(() => {});
      console.log((await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 300));
    }
  }
  await page.context().close();
}
await b.close();
server.close();
