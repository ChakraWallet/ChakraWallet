// MetaMask Card compatibility (Linea, Base): the card's state read on-chain (balances and the allowances to its FoxConnect
// contracts) and the card's payments recognised in the history (sent by the card's relayer to FoxConnect, so not
// taken for address-poisoning fakes).
import './helpers/chrome.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { cardStatus, cardConfig, isUnlimited, limitTx, oneSpender, markCardRecords, MMCARD } from '../src/shared/mmcard.js';
import { loadHistory } from '../src/shared/history.js';
import { erc20 } from '../src/shared/rpc.js';
import { getChain } from '../src/shared/chains.js';
import { POPULAR_TOKENS } from '../src/shared/tokens.js';

const LINEA = getChain(59144);
const ME = '0x5e83857a7719b6ae2de17af827140c04323a231c';
const { global: FOX, us: FOX_US } = MMCARD[59144].spenders;
const USDC = '0x176211869ca2b568f2a7d4ee941e073a821ee1ff';
const MUSD = '0xaca92e438df0b2401ff60da7e4337b687a2435da';
const multicall = new Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A Linea node: balances and allowances from `state` ({ [token]: { balance, [spender]: allowance } }); txs by hash. */
function node(state, txs = {}) {
  globalThis.fetch = async (url, init = {}) => {
    if (init.method !== 'POST') return json({ status: '0', message: 'No transactions found', result: [] });
    const { id, method, params } = JSON.parse(init.body);
    if (method === 'eth_call') {
      const [calls] = multicall.decodeFunctionData('aggregate3', params[0].data);
      const out = calls.map((c) => {
        const tok = String(c.target).toLowerCase(), f = erc20.parseTransaction({ data: c.callData });
        const s = state[tok] || {};
        const v = f.name === 'balanceOf' ? s.balance || 0n : s[String(f.args[1]).toLowerCase()] || 0n;
        return [true, word(v)];
      });
      return json({ jsonrpc: '2.0', id, result: multicall.encodeFunctionResult('aggregate3', [out]) });
    }
    if (method === 'eth_getTransactionByHash') return json({ jsonrpc: '2.0', id, result: txs[params[0]] || null });
    return json({ jsonrpc: '2.0', id, result: null });
  };
}

test('Linea: a network with the card, its tokens among the well-known ones', () => {
  assert.ok(LINEA && cardConfig(LINEA));
  assert.equal(cardConfig(getChain(1)), null);
  for (const x of MMCARD[59144].tokens) assert.ok(POPULAR_TOKENS[59144].some((p) => p.address === x.address && p.decimals === x.decimals), x.symbol);
});

test('card state: spendable = the lower of balance and limit; the card is the contract with allowances', async () => {
  node({
    [USDC]: { balance: 120_000_000n, [FOX]: 50_000_000n }, // 120 USDC, limit 50
    [MUSD]: { balance: 30_000_000n, [FOX]: 2199023255551n * 10n ** 6n }, // MetaMask's "no limit"
  });
  const s = await cardStatus(LINEA, ME);
  assert.equal(s.linked, true);
  assert.equal(s.region, 'global');
  assert.equal(s.spender, FOX);
  const usdc = s.tokens.find((x) => x.symbol === 'USDC'), musd = s.tokens.find((x) => x.symbol === 'mUSD');
  assert.equal(usdc.spendable, '50000000');
  assert.equal(musd.spendable, '30000000');
  assert.ok(isUnlimited(musd.allowance, 6) && !isUnlimited(usdc.allowance, 6));
  assert.equal(s.tokens.filter((x) => x.active).length, 2);

  node({ [USDC]: { balance: 5n, [FOX_US]: 9n } });
  const us = await cardStatus(LINEA, ME);
  assert.equal(us.region, 'us');
  assert.equal(us.spender, FOX_US);

  node({ [USDC]: { balance: 5n } });
  assert.equal((await cardStatus(LINEA, ME)).linked, false, 'no allowance: no card');
});

test('limits: an approve to the card contract (0 revokes)', () => {
  const tx = limitTx({ address: USDC }, FOX, 0);
  assert.equal(tx.to, USDC);
  const p = erc20.parseTransaction({ data: tx.data });
  assert.equal(p.name, 'approve');
  assert.equal(String(p.args[0]).toLowerCase(), FOX);
  assert.equal(p.args[1], 0n);
});

test('history: a card payment (relayer -> FoxConnect) is a payment, not a fake transfer', async () => {
  const PAY = '0x' + 'a1'.repeat(32), FAKE = '0x' + 'b2'.repeat(32), MINE = '0x' + 'c3'.repeat(32);
  const SETTLE = '0x8dfe562cbb4e93d5029f39da26bb6b501a8d1d3e';
  const tt = (hash, from, to, value, ts) => ({ hash, timeStamp: String(ts), from, to, contractAddress: USDC, value: String(value), tokenSymbol: 'USDC', tokenDecimal: '6', tokenName: 'USD Coin' });
  node({}, {
    [PAY]: { hash: PAY, from: '0x88db0d1d188b0ab2ee30a7ebe2a6e64ba0152059', to: FOX },
    [FAKE]: { hash: FAKE, from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222' },
  });
  const rpcFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') return rpcFetch(url, init);
    const action = new URL(String(url)).searchParams.get('action');
    if (action === 'txlist') return json({ status: '1', message: 'OK', result: [{ hash: MINE, timeStamp: '1700000000', from: ME, to: SETTLE, value: '0', gasUsed: '1', gasPrice: '1', isError: '0', functionName: '' }] });
    return json({ status: '1', message: 'OK', result: [tt(PAY, ME, SETTLE, 3_341_486, 1700000500), tt(FAKE, ME, '0x3333333333333333333333333333333333333333', 1_000_000, 1700000400)] });
  };
  const h = await loadHistory(LINEA, ME, undefined, { etherscanKey: 'K' });
  const pay = h.items.find((x) => x.hash === PAY), fake = h.items.find((x) => x.hash === FAKE);
  assert.equal(pay.kind, 'card');
  assert.equal(pay.spam, false);
  assert.equal(pay.transfers[0].amount, '3341486');
  assert.notEqual(fake.kind, 'card', 'another contract: still a fake');
});

// ---------------------------------------------------------------- Base: one FoxConnect for every region
const BASE = getChain(8453);
const FOX_BASE = MMCARD[8453].spenders.global;
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', EURC_BASE = '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';

test('Base: a network with the card, its tokens among the well-known ones, one contract for every region', () => {
  const cfg = cardConfig(BASE);
  assert.ok(cfg);
  assert.equal(oneSpender(cfg), true);
  assert.equal(oneSpender(cardConfig(LINEA)), false);
  assert.equal(FOX_BASE, '0xdabdafc43b2bc1c7d10c2bbce950a8cad4a367f8');
  assert.deepEqual(cfg.tokens.map((x) => x.symbol), ['USDC', 'USDT', 'WETH', 'EURC']);
  for (const x of cfg.tokens) assert.ok(POPULAR_TOKENS[8453].some((p) => p.address.toLowerCase() === x.address && p.decimals === x.decimals), x.symbol);
});

test('Base: the card state asks one allowance per token and has no region', async () => {
  let calls = 0;
  node({ [USDC_BASE]: { balance: 80_000_000n, [FOX_BASE]: 25_000_000n }, [EURC_BASE]: { balance: 10_000_000n, [FOX_BASE]: 2199023255551n * 10n ** 6n } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && JSON.parse(init.body).method === 'eth_call') calls = multicall.decodeFunctionData('aggregate3', JSON.parse(init.body).params[0].data)[0].length;
    return inner(url, init);
  };
  const s = await cardStatus(BASE, ME);
  assert.equal(calls, MMCARD[8453].tokens.length * 2, 'balance and one allowance per token');
  assert.equal(s.linked, true);
  assert.equal(s.region, null);
  assert.equal(s.spender, FOX_BASE);
  assert.equal(s.tokens.find((x) => x.symbol === 'USDC').spendable, '25000000');
  assert.equal(s.tokens.find((x) => x.symbol === 'EURC').spendable, '10000000');
  node({ [USDC_BASE]: { balance: 5n } });
  assert.equal((await cardStatus(BASE, ME)).linked, false);
});

test('Base: a card payment (relayer -> FoxConnect) is recognised in the history', async () => {
  const PAY = '0x' + 'd4'.repeat(32), OTHER = '0x' + 'e5'.repeat(32);
  const SHOP = '0x8dfe562cbb4e93d5029f39da26bb6b501a8d1d3e';
  node({}, { [PAY]: { hash: PAY, from: '0x88db0d1d188b0ab2ee30a7ebe2a6e64ba0152059', to: FOX_BASE }, [OTHER]: { hash: OTHER, from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222' } });
  const rec = (hash) => ({ hash, isTx: false, transfers: [{ from: ME, to: SHOP, token: USDC_BASE, amount: '1000000' }] });
  const records = [rec(PAY), rec(OTHER)];
  await markCardRecords(BASE, ME, records);
  assert.equal(records[0].card, 'spend');
  assert.equal(records[1].card, undefined);
});
