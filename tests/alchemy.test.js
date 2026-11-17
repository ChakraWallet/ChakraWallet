// Alchemy (optional key): sends go to it first (after Ethereum's private channel), reads only when the public nodes
// don't answer, history and tokens only when the network's usual service can't give them (Etherscan stays the main
// one). Only the networks switched on in the user's Alchemy app are used: checkAlchemy finds which.
import './helpers/chrome.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setAlchemy, alchemyUrl, alchemyKeyOf, checkAlchemy } from '../src/shared/alchemy.js';
import { rpc } from '../src/shared/rpc.js';
import { sendRaw } from '../src/shared/mev.js';
import { loadPortfolio } from '../src/shared/portfolio.js';
import { loadHistory } from '../src/shared/history.js';

const ME = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x00000000000000000000000000000000000000bb';
const AL = 'https://test-net.g.alchemy.com/v2/k';
const CHAIN = {
  id: 990058, name: 'Al Net', native: { symbol: 'AL', decimals: 18 }, rpc: ['https://rpc.test'], alchemy: 'test-net',
  indexer: { type: 'etherscan', url: 'https://api.etherscan.io/v2/api', needsKey: true },
};
const hex = (n) => '0x' + BigInt(n).toString(16);

beforeEach(() => setAlchemy({ alchemyKey: 'k', alchemyNets: { [CHAIN.id]: { state: 'on' } } }));

/**
 * The fake network. publicDown: the public node doesn't answer. alchemy(method, params): Alchemy's answers.
 * etherscan: Etherscan's answer (null: never asked). Returns the log of the hosts asked, in order.
 */
function network({ publicDown = false, alchemy = () => null, etherscan = null } = {}) {
  const log = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.startsWith('https://rpc.test')) {
      log.push('public');
      if (publicDown) throw new Error('public node down');
      const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : r.method === 'eth_sendRawTransaction' ? '0xpublic' : '0x' });
      return json(Array.isArray(body) ? body.map(one) : one(body));
    }
    if (u === AL) {
      const one = (r) => { log.push(`alchemy:${r.method}`); return { jsonrpc: '2.0', id: r.id, result: alchemy(r.method, r.params) }; };
      return json(Array.isArray(body) ? body.map(one) : one(body));
    }
    if (u.includes('api.etherscan.io')) { log.push('etherscan'); return json(etherscan); }
    if (u.includes('alchemy.com')) throw new Error(`unexpected Alchemy address ${u}`);
    return json({ coins: {} }); // prices
  };
  return log;
}

test('the key is taken from a pasted address too; a network not switched on is not used', () => {
  assert.equal(alchemyKeyOf('https://linea-mainnet.g.alchemy.com/v2/abc_123'), 'abc_123');
  assert.equal(alchemyKeyOf('  abc_123 '), 'abc_123');
  assert.equal(alchemyUrl(CHAIN), AL);
  setAlchemy({ alchemyKey: 'k', alchemyNets: { [CHAIN.id]: { state: 'off' } } });
  assert.equal(alchemyUrl(CHAIN), null);
  setAlchemy({ alchemyKey: '', alchemyNets: { [CHAIN.id]: { state: 'on' } } });
  assert.equal(alchemyUrl(CHAIN), null);
});

test('reads: the public nodes first, Alchemy when none answers (and it does not become the preferred one)', async () => {
  let log = network({ alchemy: (m) => (m === 'eth_blockNumber' ? '0x10' : null) });
  assert.equal(await rpc(CHAIN, 'eth_blockNumber'), '0x');
  assert.deepEqual(log, ['public']);

  log = network({ publicDown: true, alchemy: (m) => (m === 'eth_blockNumber' ? '0x10' : null) });
  assert.equal(await rpc(CHAIN, 'eth_blockNumber'), '0x10');
  assert.deepEqual(log, ['public', 'alchemy:eth_blockNumber']);

  log = network({ alchemy: () => '0x10' });
  await rpc(CHAIN, 'eth_blockNumber');
  assert.deepEqual(log, ['public'], 'the public node is asked first again');
});

test('sends: Alchemy first; without its key, the public nodes', async () => {
  let log = network({ alchemy: (m) => (m === 'eth_sendRawTransaction' ? '0xalchemy' : null) });
  assert.deepEqual(await sendRaw(CHAIN, '0xsigned'), { hash: '0xalchemy', protected: false });
  assert.deepEqual(log, ['alchemy:eth_sendRawTransaction']);

  setAlchemy({ alchemyKey: '', alchemyNets: {} });
  log = network({});
  assert.deepEqual(await sendRaw(CHAIN, '0xsigned'), { hash: '0xpublic', protected: false });
  assert.deepEqual(log, ['public']);
});

const holdings = (m, p) => {
  if (m === 'alchemy_getTokenBalances') return { tokenBalances: [{ contractAddress: TOKEN, tokenBalance: hex(2_500_000) }, { contractAddress: OTHER, tokenBalance: '0x0' }] };
  if (m === 'alchemy_getTokenMetadata') return { symbol: 'TKN', name: 'Token', decimals: 6, logo: null };
  return null;
};

test('tokens: Etherscan first; Alchemy only when Etherscan cannot (here its free pool ran out)', async () => {
  let log = network({ alchemy: holdings, etherscan: { status: '1', message: 'OK', result: [] } });
  let p = await loadPortfolio(CHAIN, ME, { etherscanKey: 'free' });
  assert.equal(log.filter((x) => x.startsWith('alchemy')).length, 0, 'Etherscan answered: Alchemy not asked');

  log = network({ alchemy: holdings, etherscan: { status: '0', message: 'NOTOK', result: 'Community Free API Limit reached. Resets 2026-11-18 00:00:00 UTC.' } });
  p = await loadPortfolio(CHAIN, ME, { etherscanKey: 'free' });
  assert.deepEqual([p.indexerOk, p.noIndexer, p.indexerLimit], [true, false, 0], 'no notice: Alchemy covered it');
  const t = p.tokens.find((x) => x.address === TOKEN);
  assert.equal(t?.symbol, 'TKN');
  assert.equal(t?.amount, 2.5);
  assert.equal(p.tokens.some((x) => x.address === OTHER), false, 'zero balances are left out');
});

test('tokens without any Etherscan key: from Alchemy, no "add a key" notice', async () => {
  network({ alchemy: holdings });
  const p = await loadPortfolio(CHAIN, ME, {});
  assert.equal(p.noIndexer, false);
  assert.ok(p.tokens.some((x) => x.address === TOKEN));
});

test('history from Alchemy: times from the blocks when missing, fee / outcome / method from the receipts, pages', async () => {
  const sent = [
    { uniqueId: 'a', category: 'external', blockNum: '0x10', hash: '0xa1', from: ME, to: OTHER, asset: 'AL', rawContract: { value: hex(10n ** 17n), address: null, decimal: '0x12' } },
    { uniqueId: 'b', category: 'external', blockNum: '0x0f', hash: '0xa2', from: ME, to: TOKEN, asset: 'AL', rawContract: { value: '0x0', address: null, decimal: '0x12' } },
    { uniqueId: 'c', category: 'erc20', blockNum: '0x0f', hash: '0xa2', from: ME, to: OTHER, asset: 'TKN', rawContract: { value: hex(1_000_000), address: TOKEN, decimal: '0x6' } },
  ];
  const got = [{ uniqueId: 'd', category: 'erc20', blockNum: '0x0e', hash: '0xa3', from: OTHER, to: ME, asset: 'TKN', metadata: { blockTimestamp: '2023-11-14T22:00:00.000Z' }, rawContract: { value: hex(5_000_000), address: TOKEN, decimal: '0x6' } }];
  const asked = [];
  network({
    alchemy: (m, p) => {
      if (m === 'alchemy_getAssetTransfers') { asked.push(p[0]); return p[0].fromAddress ? { transfers: sent, pageKey: 'more-sent' } : { transfers: got }; }
      if (m === 'eth_getBlockByNumber') return { timestamp: hex(1_700_000_000 + Number(p[0])) };
      if (m === 'eth_getTransactionReceipt') return { status: p[0] === '0xa1' ? '0x0' : '0x1', gasUsed: hex(21000), effectiveGasPrice: hex(1000) };
      if (m === 'eth_getTransactionByHash') return { input: p[0] === '0xa2' ? '0xa9059cbb0000' : '0x' };
      return null;
    },
  });
  const h = await loadHistory(CHAIN, ME, null, {}); // no Etherscan key: the usual service isn't there
  assert.deepEqual([h.error, h.unsupported], [null, false]);
  assert.deepEqual(h.items.map((x) => x.hash), ['0xa1', '0xa2', '0xa3']);
  const [failed, token, received] = h.items;
  assert.equal(failed.time, (1_700_000_000 + 16) * 1000, 'time from the block');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.fee, String(21000 * 1000));
  assert.equal(token.transfers[0].symbol, 'TKN');
  assert.equal(token.transfers[0].decimals, 6);
  assert.equal(received.time, Date.parse('2023-11-14T22:00:00.000Z'), "Alchemy's own time when it gives one");
  assert.deepEqual(h.next, { from: 'more-sent', to: null, src: 'alchemy' });
  assert.deepEqual(asked.map((q) => q.category.join()), ['external,erc20', 'external,erc20']);

  asked.length = 0;
  const h2 = await loadHistory(CHAIN, ME, h.next, { etherscanKey: 'free' });
  assert.equal(asked.length, 1, 'the next page: only the list with more, from Alchemy (not Etherscan)');
  assert.equal(asked[0].pageKey, 'more-sent');
  assert.equal(h2.error, null);
});

test('history: Etherscan answers, Alchemy is not asked', async () => {
  const log = network({ alchemy: () => ({ transfers: [] }), etherscan: { status: '0', message: 'No transactions found', result: [] } });
  const h = await loadHistory(CHAIN, ME, null, { etherscanKey: 'free' });
  assert.equal(h.error, null);
  assert.equal(log.some((x) => x.startsWith('alchemy')), false);
});

test("the key's networks: switched on, to switch on (with the link of the app), a key Alchemy doesn't know", async () => {
  const chains = [{ id: 1, alchemy: 'eth-mainnet' }, { id: 56, alchemy: 'bnb-mainnet' }, { id: 10, alchemy: 'opt-mainnet' }, { id: 77, name: 'no alchemy' }];
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u.includes('eth-mainnet')) return json({ jsonrpc: '2.0', id: 1, result: '0x1' });
    if (u.includes('bnb-mainnet')) return json({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'BNB_MAINNET is not enabled for this app. Visit this page to enable the network: https://dashboard.alchemy.com/apps/abc/networks' } }, 403);
    throw new Error('offline');
  };
  const r = await checkAlchemy('k', chains);
  assert.deepEqual(r.nets, {
    1: { state: 'on' },
    56: { state: 'off', link: 'https://dashboard.alchemy.com/apps/abc/networks' },
    10: { state: 'error' },
  });

  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Must be authenticated!' } }) });
  assert.deepEqual(await checkAlchemy('wrong', chains), { bad: true });
});
