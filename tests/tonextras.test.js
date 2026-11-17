// TON's extras on the wallet screens: names as recipients (TON DNS), jettons added by hand, the part of the
// background check that watches TON balances. The network (TON Center, TonAPI, STON.fi, prices) is a stand-in.
import { resetStorage, storage } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { tonDnsName } from '../src/shared/ton/core.js';
import { setTonApiKey } from '../src/shared/ton/tonapi.js';
import { setTonCenterKey, TON_CHAINS } from '../src/shared/ton/api.js';
import { tonDriver, loadTonPortfolio, jettonId } from '../src/ui/ton/driver.js';
import { tonWatch } from '../src/ui/ton/hooks.js';
import { POPULAR_JETTONS } from '../src/shared/ton/swap.js';

const TON = TON_CHAINS[-239];
setTonApiKey('test'); setTonCenterKey('test'); // no request pacing in tests
const addr = (n) => new Address(0, Buffer.alloc(32, n));
const RAW = (n) => addr(n).toRawString().toUpperCase();
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
/** fetch stand-in: routes by URL fragment; unknown -> 404. */
const route = (table) => async (url) => {
  const u = String(url);
  for (const [frag, fn] of table) if (u.includes(frag)) return fn(u);
  return json({ error: 'not found' }, 404);
};

test('names typed as recipients', () => {
  for (const [typed, domain] of [
    ['alice.ton', 'alice.ton'], [' Alice.TON ', 'alice.ton'], ['pay.alice.ton', 'pay.alice.ton'], ['my-shop.ton', 'my-shop.ton'],
    ['@alice_99', 'alice_99.t.me'], ['alice_99.t.me', 'alice_99.t.me'],
  ]) assert.equal(tonDnsName(typed), domain, typed);
  for (const no of ['abc.ton', '-bad.ton', 'bad-.ton', 'alice', '@abc', 'UQDHMWKzTPGWZyEK8xgNb8-4jfFnjLu-cx84ZCU0zGlR5N8r', 'alice.eth', '']) {
    assert.equal(tonDnsName(no), null, no);
  }
  assert.equal(tonDriver.isName(TON, '@alice_99'), true);
  assert.equal(tonDriver.isName(TON, addr(1).toString()), false);
});

test('a name resolves to the address it points to', async () => {
  globalThis.fetch = route([
    ['/v2/dns/alice.ton/resolve', () => json({ wallet: { address: addr(1).toRawString(), is_wallet: false, account: { address: addr(1).toRawString(), name: 'Alice', is_wallet: true, is_scam: false } } })],
    ['/v2/dns/shop.ton/resolve', () => json({ wallet: { address: addr(2).toRawString(), account: { is_wallet: false, is_scam: true } } })],
  ]);
  const r = await tonDriver.resolveName(TON, 'Alice.ton');
  assert.deepEqual(r, { name: 'alice.ton', address: addr(1).toString({ urlSafe: true, bounceable: false }), accountName: 'Alice', isWallet: true, scam: false });
  const s = await tonDriver.resolveName(TON, 'shop.ton');
  assert.equal(s.address, addr(2).toString({ urlSafe: true, bounceable: true }), 'a contract: shown bounceable');
  assert.deepEqual([s.isWallet, s.scam], [false, true]);
  await assert.rejects(() => tonDriver.resolveName(TON, 'nobody.ton'), (e) => e.key === 'ton.name.notFound' && e.vars.name === 'nobody.ton');
});

test('a jetton added by hand', async () => {
  const master = addr(5);
  globalThis.fetch = route([
    ['/api/v3/metadata', (u) => json(u.includes(encodeURIComponent(RAW(5))) || u.includes(RAW(5))
      ? { [RAW(5)]: { token_info: [{ type: 'jetton_masters', symbol: 'FOO', name: 'Foo coin', extra: { decimals: '6' }, image: 'https://x/foo.png', is_scam: true }] } }
      : {})],
  ]);
  assert.equal(tonDriver.features.customTokens, true);
  assert.equal(tonDriver.isTokenAddress(TON, master.toString()), true);
  assert.equal(tonDriver.isTokenAddress(TON, '0x1234'), false);
  const info = await tonDriver.tokenInfo(TON, master.toRawString());
  assert.deepEqual(info, { address: jettonId(master.toRawString()), symbol: 'FOO', name: 'Foo coin', decimals: 6, icon: 'https://x/foo.png', scam: true, known: false });
  await assert.rejects(() => tonDriver.tokenInfo(TON, addr(6).toString()), (e) => e.key === 'ton.token.notJetton');
});

test('jettons added by hand stay in the portfolio: with nothing held, and when flagged as a scam', async () => {
  const me = addr(9).toRawString();
  const held = (n, bal) => ({ address: RAW(40 + n), jetton: RAW(n), owner: me.toUpperCase(), balance: String(bal) });
  globalThis.fetch = route([
    ['walletInformation', () => json({ balance: '2000000000', status: 'active', seqno: 3 })],
    ['/api/v3/jetton/wallets', () => json({ jetton_wallets: [held(5, 1000000), held(7, 5000)] })],
    ['/api/v3/metadata', () => json({
      [RAW(5)]: { token_info: [{ type: 'jetton_masters', symbol: 'FOO', extra: { decimals: '6' }, is_scam: true }] },
      [RAW(7)]: { token_info: [{ type: 'jetton_masters', symbol: 'SPAM', extra: { decimals: '0' }, is_scam: true }] },
    })],
  ]);
  const custom = [
    { address: jettonId(RAW(5)), symbol: 'FOO', decimals: 6 }, // held, flagged: shown because the user added it
    { address: jettonId(RAW(8)), symbol: 'BAR', decimals: 9, icon: 'https://x/bar.png' }, // not held: shown with 0
  ];
  const p = await loadTonPortfolio(TON, me, { customTokens: custom });
  const by = Object.fromEntries(p.tokens.map((x) => [x.symbol, x]));
  assert.deepEqual(Object.keys(by).sort(), ['BAR', 'FOO'], 'the flagged jetton nobody added stays out');
  assert.equal(by.FOO.balance, '1000000');
  assert.equal(by.FOO.custom, true);
  assert.deepEqual([by.BAR.balance, by.BAR.amount, by.BAR.custom, by.BAR.icon], ['0', 0, true, 'https://x/bar.png']);
  assert.doesNotThrow(() => JSON.stringify(p), 'cached as JSON');
});

test("TON's part of the background check", async () => {
  await resetStorage();
  const settings = { disabledChains: [], tonCenterKey: 'k' };
  const accounts = [{ address: '0xAAA', name: 'Main' }, { address: '0xBBB', name: 'Imported key' }, { address: '0xCCC', name: 'Other wallet' }];
  await storage.local.set({ accounts, customTokens: { [-239]: [{ address: jettonId(RAW(8)), symbol: 'BAR', decimals: 9 }], [-3]: [{ address: jettonId(RAW(9)), symbol: 'TEST', decimals: 9 }] } });
  globalThis.chrome.runtime = { sendMessage: async ({ type }) => (type === 'tonAccounts' ? { ok: true, result: { '0xAAA': { mainnet: { raw: addr(1).toRawString() } } } } : { ok: false }) };
  const prev = { ton: { accounts: [{ id: '0xCCC', address: addr(3).toRawString(), name: 'Other wallet' }, { id: '0xGONE', address: addr(4).toRawString(), name: 'Deleted' }] } };
  const state = { unlocked: true, settings, accounts: accounts.slice(0, 2) }; // the active wallet: Main and an Ethereum-only key
  const { ton } = await tonWatch(state, prev);
  assert.equal(ton.api, 'https://toncenter.com');
  assert.equal(ton.key, 'k');
  assert.deepEqual(ton.accounts.map((a) => [a.id, a.address]), [['0xAAA', addr(1).toRawString()], ['0xCCC', addr(3).toRawString()]],
    'the active wallet now, the other wallets as written before, deleted accounts gone');
  assert.deepEqual(ton.jettons.map((j) => j.symbol), ['USD₮', 'STON', 'NOT', 'DOGS', 'BAR'], 'well-known and added by hand (mainnet only)');
  assert.equal(ton.jettons[0].master, Address.parse(POPULAR_JETTONS[0]).toRawString().toUpperCase());
  assert.equal(ton.jettons[0].decimals, 6);
  // locked: the last addresses stay; TON switched off: nothing
  assert.deepEqual(await tonWatch({ ...state, unlocked: false }, { ton }), { ton });
  assert.deepEqual(await tonWatch({ ...state, settings: { disabledChains: [-239] } }, { ton }), { ton: null });
});
