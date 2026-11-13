import './helpers/chrome.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadHistory, receiptTransfers } from '../src/shared/history.js';
import { BUILTIN_CHAINS } from '../src/shared/chains.js';

const ETH = BUILTIN_CHAINS[0];
const ME = '0x5e83857a7719b6ae2de17af827140c04323a231c';
const ROUTER = '0x6a000f20005980200259b80c5102003040001068';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (a) => '0x' + a.slice(2).padStart(64, '0');
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const log = (token, from, to, amount) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: word(amount) });

const SWAP_HASH = '0x' + 'd7'.repeat(32);
const RECEIPT = {
  status: '0x1', gasUsed: '0x30d40', effectiveGasPrice: '0x3b9aca00',
  logs: [
    log(USDT, ME, '0x006d0e0d006109f0020f3050000a713780b7b000', 444000000n),
    log(USDT, '0x006d0e0d006109f0020f3050000a713780b7b000', '0x20861433d9119b866eeb398cb1ad46652a3cf953', 444000000n), // not mine
    log(USDC, ROUTER, ME, 443503907n),
  ],
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
/** Indexer with nothing yet (it lags behind the chain); the node knows the receipt. */
function lagging() {
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      const { id, method, params } = JSON.parse(init.body);
      const result = method === 'eth_getTransactionReceipt' && params[0] === SWAP_HASH ? RECEIPT : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    }
    return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }));
  };
}

test('receiptTransfers: only my ERC-20 transfers, with symbol and icon of well-known tokens', async () => {
  const t = await receiptTransfers(ETH, RECEIPT, ME);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => [x.symbol, x.amount, x.decimals]), [['USDT', '444000000', 6], ['USDC', '443503907', 6]]);
  assert.ok(t.every((x) => x.icon));
});

test('a swap sent from the app looks like a swap before the indexer has it', async () => {
  lagging();
  const r = await loadHistory(ETH, ME, null, {
    localLog: [{ hash: SWAP_HASH, time: Date.now(), from: ME, to: ROUTER, value: '0x0', data: '0xe3ead59e', title: 'Swap 444 USDT → USDC (Velora)', origin: 'Chakra', status: 'pending' }],
  });
  const it = r.items.find((x) => x.hash === SWAP_HASH);
  assert.equal(it.kind, 'swap');
  assert.equal(it.status, 'ok');
  assert.equal(it.fee, (200000n * 1000000000n).toString());
  assert.deepEqual(it.transfers.map((x) => `${x.dir}:${x.symbol}`).sort(), ['in:USDC', 'out:USDT']);
});

test('a local approval is an approval, from its selector', async () => {
  lagging();
  const hash = '0x' + '40'.repeat(32);
  const r = await loadHistory(ETH, ME, null, {
    localLog: [{ hash, time: Date.now(), from: ME, to: USDT, value: '0x0', data: '0x095ea7b3', title: 'Autorizzazione USDT per swap', origin: 'Chakra', status: 'ok' }],
  });
  assert.equal(r.items.find((x) => x.hash === hash).kind, 'approve');
});

test('an indexer answering only half (token transfers rate-limited) is an error, not a history without tokens', async () => {
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('tokentx')
    ? { status: '0', message: 'NOTOK', result: 'Max rate limit reached' }
    : { status: '1', message: 'OK', result: [] }));
  const r = await loadHistory({ ...ETH, altIndexer: null, indexer: ETH.altIndexer }, ME, null, {});
  assert.match(r.error, /rate limit/);
});
