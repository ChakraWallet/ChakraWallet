// Chain driver contract: every family's driver (src/ui/chains, src/ui/ton/driver.js...) is checked against the interface
// the wallet screens use (src/ui/chains/driver.d.md), on its own network simulated by a fixture below.
// A new family = its driver registered here + one fixture (a network, two addresses and its API answers).
import './helpers/chrome.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { REQUIRED, driverOf, allDrivers, registerDriver, familyOf, bridgeFor, bridgeNetworks } from '../src/ui/chains/index.js';
import '../src/ui/chains/evm.js';
import { tonDriver } from '../src/ui/ton/driver.js';
import { BUILTIN_CHAINS } from '../src/shared/chains.js';
import { TON_CHAINS, setTonCenterKey } from '../src/shared/ton/api.js';
import { registerFamily, familyKinds, familyOf as familySpec, TON_VERSIONS } from '../src/background/families.js';
import { VERSIONS } from '../src/shared/ton/core.js';

registerDriver(tonDriver);
setTonCenterKey('test'); // TON Center's 10 requests/s pace instead of 1/s

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// ---------------------------------------------------------------- fixtures: one per family
const ME_EVM = '0x5e83857a7719B6aE2DE17af827140C04323a231C';
const OTHER_EVM = '0x516fbC1Ff3B5e9824dA622c50CAf37b220081E65';
const multicall = new Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

const ME_TON_RAW = '0:5f372e9a4d8b2c1e0f6a3b7c9d1e2f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e';
const USDT_TON = '0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE';

const FIXTURES = {
  evm: {
    chain: BUILTIN_CHAINS[0],
    me: { address: ME_EVM, raw: ME_EVM }, other: OTHER_EVM, bad: '0x1234',
    async fetch(url, init = {}) {
      const u = new URL(String(url));
      if (init.method === 'POST') { // JSON-RPC
        const { id, method, params } = JSON.parse(init.body);
        if (method === 'eth_getBalance') return json({ jsonrpc: '2.0', id, result: word(2n * 10n ** 18n) });
        if (method === 'eth_call') { // multicall: every token balance 0, USDC 150
          const [calls] = multicall.decodeFunctionData('aggregate3', params[0].data);
          const out = calls.map((c) => [true, word(String(c.target).toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ? 150_000_000n : 0n)]);
          return json({ jsonrpc: '2.0', id, result: multicall.encodeFunctionResult('aggregate3', [out]) });
        }
        return json({ jsonrpc: '2.0', id, result: null });
      }
      if (u.host === 'coins.llama.fi') return json({ coins: { 'coingecko:ethereum': { price: 3000, confidence: 0.99 }, 'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { price: 1, confidence: 0.99 } } });
      if (u.pathname.endsWith('/token-balances')) return json([]);
      if (u.host === 'api.routescan.io') {
        const action = u.searchParams.get('action');
        if (action === 'txlist') return json({ status: '1', message: 'OK', result: [{ hash: '0x' + 'ab'.repeat(32), timeStamp: '1794557759', from: ME_EVM.toLowerCase(), to: OTHER_EVM.toLowerCase(), value: '1000000000000000000', gasUsed: '21000', gasPrice: '1000000000', isError: '0', functionName: '' }] });
        return json({ status: '0', message: 'No transactions found', result: [] });
      }
      return json({}, 404);
    },
  },
  ton: {
    chain: TON_CHAINS[-239],
    me: { address: 'UQBfNy6aTYssHg9qO3ydHi9KW2x9jp8KGyw9Tl9qe4ydDig2', raw: ME_TON_RAW }, other: 'UQBvW8Z5juBkMJY8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw-', bad: 'EQ-not-an-address',
    async fetch(url) {
      const u = new URL(String(url)), p = u.pathname;
      if (p === '/api/v3/walletInformation') return json({ balance: '12500000000', status: 'active', seqno: 3 });
      if (p === '/api/v3/jetton/wallets') return json({ jetton_wallets: [{ address: '0:' + '1'.repeat(64), jetton: USDT_TON, balance: '20000000' }] });
      if (p === '/api/v3/metadata') return json({ [USDT_TON]: { token_info: [{ type: 'jetton_masters', symbol: 'USD₮', name: 'Tether USD', extra: { decimals: '6' } }] } });
      if (u.host === 'api.ston.fi') return json({ asset: { dex_usd_price: '1', symbol: 'USD₮', display_name: 'Tether USD', decimals: 6 } });
      if (u.host === 'coins.llama.fi') return json({ coins: { 'coingecko:the-open-network': { price: 3.1, confidence: 0.99 } } });
      if (p === '/api/v3/actions') {
        return json({ address_book: {}, metadata: {}, next_cursor: null, actions: [
          { action_id: 'a1', trace_id: 't1', type: 'ton_transfer', success: true, start_utime: '1794557759', transactions: [Buffer.alloc(32, 1).toString('base64')], details: { source: 'UQBvW8Z5juBkMJY8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw-', destination: ME_TON_RAW, value: '1000000000', comment: 'hi' } },
        ] });
      }
      return json({ error: 'not found' }, 404);
    },
  },
};

const KINDS = ['send', 'receive', 'swap', 'approve', 'contract', 'self'];
const serializable = (v) => { assert.doesNotThrow(() => JSON.stringify(v), 'no BigInt: portfolios are cached on the device as JSON'); };

// ---------------------------------------------------------------- the contract, for every registered driver
test('every family has a fixture', () => {
  for (const d of allDrivers()) assert.ok(FIXTURES[d.kind], `fixture missing for "${d.kind}"`);
});

for (const [kind, fx] of Object.entries(FIXTURES)) {
  const d = () => driverOf(kind);

  test(`${kind}: registered, with the required functions and its features`, () => {
    assert.ok(d(), `driver "${kind}" not registered`);
    assert.equal(familyOf(fx.chain), kind);
    for (const k of REQUIRED) assert.equal(typeof d()[k], 'function', `${kind}.${k}`);
    assert.equal(typeof d().features, 'object');
    for (const k of ['addressPlaceholder', 'receiveTokens', 'receiveNote', 'priceKey', 'explorerToken']) assert.equal(typeof d()[k], 'function', `${kind}.${k}`);
  });

  test(`${kind}: addresses`, () => {
    const ok = d().validateAddress(fx.chain, fx.other, fx.me.address);
    assert.equal(ok.ok, true); assert.equal(typeof ok.normalized, 'string'); assert.equal(ok.toSelf, false);
    assert.ok(Array.isArray(ok.warnings));
    assert.equal(d().validateAddress(fx.chain, fx.me.address, fx.me.address).toSelf, true);
    const bad = d().validateAddress(fx.chain, fx.bad, fx.me.address);
    assert.equal(bad.ok, false); assert.equal(typeof bad.error, 'string', 'an i18n key for the error');
    assert.equal(d().parseQr(fx.chain, 'not a payment'), null);
    const link = d().paymentLink(fx.chain, { address: fx.me.address, token: { native: true }, amountRaw: '1000', ask: true });
    assert.ok(link.includes(fx.me.address), 'the payment link carries the address');
    const back = d().parseQr(fx.chain, link);
    assert.ok(back && d().validateAddress(fx.chain, back.address).ok, 'its own payment link reads back');
    assert.equal(typeof d().receiveNote(fx.chain, false).key, 'string');
  });

  test(`${kind}: portfolio in the shared shape`, async () => {
    globalThis.fetch = fx.fetch;
    const p = await d().loadPortfolio(fx.chain, fx.me.raw, {});
    serializable(p);
    assert.equal(typeof p.native.balance, 'string'); assert.equal(typeof p.native.amount, 'number');
    assert.ok(Array.isArray(p.tokens)); assert.ok(p.tokens.length > 0, 'the fixture holds a token');
    for (const x of p.tokens) {
      assert.equal(typeof x.address, 'string'); assert.equal(typeof x.symbol, 'string'); assert.equal(typeof x.decimals, 'number');
      assert.equal(typeof x.balance, 'string'); assert.equal(typeof x.amount, 'number');
      assert.ok(d().priceKey(fx.chain, x) === null || typeof d().priceKey(fx.chain, x) === 'string');
    }
    assert.equal(typeof p.totalUsd, 'number'); assert.equal(typeof p.updated, 'number');
    assert.ok(d().receiveTokens(fx.chain, [{ ...p.native, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', native: true }, ...p.tokens]).length >= 1);
  });

  test(`${kind}: history in the shared shape`, async () => {
    globalThis.fetch = fx.fetch;
    const r = await d().loadHistory(fx.chain, fx.me.raw, null, {});
    assert.ok(Array.isArray(r.items)); assert.ok(r.items.length > 0, 'the fixture has a transaction');
    for (const it of r.items) {
      assert.equal(typeof it.hash, 'string'); assert.equal(typeof it.time, 'number');
      assert.ok(KINDS.includes(it.kind), `kind ${it.kind}`);
      assert.ok(['ok', 'failed', 'pending'].includes(it.status));
      for (const x of it.transfers) {
        assert.ok(['in', 'out'].includes(x.dir)); assert.equal(typeof x.symbol, 'string');
        assert.equal(typeof x.decimals, 'number'); assert.equal(typeof x.amount, 'string');
      }
    }
  });

  test(`${kind}: bridge description`, () => {
    const b = d().bridge;
    if (!b) return;
    const nets = b.chains();
    assert.ok(nets.length > 0);
    for (const c of nets) {
      assert.ok(bridgeNetworks().some((x) => x.id === c.id), 'offered by the bridge screen');
      const toks = b.tokens(c, nets[0]);
      assert.ok(toks.some((x) => x.native), 'the native coin can be moved');
    }
    for (const k of ['quotes', 'steps', 'reserve', 'supports']) assert.equal(typeof b[k], 'function', `bridge.${k}`);
  });
}

// ---------------------------------------------------------------- the registry
test('a pair of networks has at most one bridge, and EVM <-> TON has TON\'s', () => {
  const eth = BUILTIN_CHAINS[0], base = BUILTIN_CHAINS.find((c) => c.id === 8453), ton = TON_CHAINS[-239];
  assert.equal(bridgeFor(eth, base), driverOf('evm').bridge);
  assert.equal(bridgeFor(eth, ton), driverOf('ton').bridge);
  assert.equal(bridgeFor(ton, base), driverOf('ton').bridge);
  assert.equal(bridgeFor(ton, ton), null);
});

test('registerDriver refuses a driver without the required functions', () => {
  assert.throws(() => registerDriver({ kind: 'broken', resolveAddresses() {} }), /missing/);
});

// ---------------------------------------------------------------- the background side: families with keys of their own
test('vault families: TON entries are checked, and the versions match the TON library', () => {
  assert.deepEqual(TON_VERSIONS, VERSIONS);
  assert.ok(familyKinds().includes('ton'));
  const ok = familySpec('ton').clean({ address: '0:' + 'AB'.repeat(32), secret: 'CD'.repeat(32), version: 'v4r2' });
  assert.deepEqual(ok, { address: '0:' + 'ab'.repeat(32), secret: 'cd'.repeat(32), version: 'v4r2' });
  assert.equal(familySpec('ton').clean({ address: 'nope', secret: 'cd'.repeat(32), version: 'v4r2' }), null);
  assert.equal(familySpec('ton').clean({ address: '0:' + 'ab'.repeat(32), secret: 'cd'.repeat(32), version: 'v9' }), null);
  registerFamily('demo', { clean: (x) => x });
  assert.ok(familyKinds().includes('demo'));
});
