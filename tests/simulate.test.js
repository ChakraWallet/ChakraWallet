import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id, zeroPadValue, AbiCoder, MaxUint256 } from 'ethers';
import { analyzeCall, riskOf, delegateOf, isUnlimited, simulateTx, PERMIT2, wrappedNative } from '../src/shared/simulate.js';
import { readPermit, readSeaport } from '../src/shared/typedData.js';

const coder = AbiCoder.defaultAbiCoder();
const ME = '0x1111111111111111111111111111111111111111';
const DAPP = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const NFT = '0x4444444444444444444444444444444444444444';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const T = (sig) => id(sig);
const A = (a) => zeroPadValue(a, 32);
const U = (n) => coder.encode(['uint256'], [n]);
const log = (address, topics, data = '0x') => ({ address, topics, data });
const ok = (logs) => ({ status: '0x1', logs });

const transfer = (token, from, to, v) => log(token, [T('Transfer(address,address,uint256)'), A(from), A(to)], U(v));

test('balance changes: tokens, the native coin, net of what comes back', () => {
  const r = analyzeCall(ok([
    transfer(USDC, ME, DAPP, 1000_000000n),
    transfer(USDC, DAPP, ME, 10_000000n), // a refund
    transfer(NATIVE, DAPP, ME, 5n * 10n ** 17n), // traceTransfers: the coin
    transfer(USDC, DAPP, OTHER, 7n), // not ours
  ]), ME);
  assert.equal(r.failed, false);
  assert.deepEqual(r.changes, [
    { kind: 'erc20', token: USDC, delta: -990_000000n },
    { kind: 'native', token: NATIVE, delta: 5n * 10n ** 17n },
  ]);
  assert.deepEqual(r.approvals, []);
});

test('NFTs: ERC-721 and ERC-1155 (single and batch)', () => {
  const single = log(NFT, [T('TransferSingle(address,address,address,uint256,uint256)'), A(DAPP), A(ME), A(OTHER)], coder.encode(['uint256', 'uint256'], [7n, 2n]));
  const batch = log(NFT, [T('TransferBatch(address,address,address,uint256[],uint256[])'), A(DAPP), A(OTHER), A(ME)], coder.encode(['uint256[]', 'uint256[]'], [[1n, 2n], [3n, 4n]]));
  const r = analyzeCall(ok([
    log(NFT, [T('Transfer(address,address,uint256)'), A(ME), A(DAPP), U(42n)]),
    single, batch,
  ]), ME);
  assert.deepEqual(r.changes.map((c) => [c.kind, c.id, c.delta]), [['nft', 42n, -1n], ['nft', 7n, -2n], ['nft', 1n, 3n], ['nft', 2n, 4n]]);
});

test('permissions left behind: approve, NFT approvals, Permit2; the last one per spender wins', () => {
  const approval = (owner, spender, v) => log(USDC, [T('Approval(address,address,uint256)'), A(owner), A(spender)], U(v));
  const r = analyzeCall(ok([
    approval(ME, DAPP, 5n),
    approval(ME, DAPP, MaxUint256), // replaces the first one
    approval(ME, OTHER, 0n), // a revocation
    approval(OTHER, DAPP, MaxUint256), // someone else's
    log(NFT, [T('ApprovalForAll(address,address,bool)'), A(ME), A(DAPP)], U(1n)),
    log(NFT, [T('Approval(address,address,uint256)'), A(ME), A(OTHER), U(9n)]),
    log(PERMIT2, [T('Approval(address,address,address,uint160,uint48)'), A(ME), A(USDC), A(DAPP)], coder.encode(['uint160', 'uint48'], [123n, 1700000000n])),
  ]), ME);
  assert.deepEqual(r.approvals, [
    { kind: 'erc20', token: USDC, spender: DAPP, amount: MaxUint256, revoke: false },
    { kind: 'erc20', token: USDC, spender: OTHER, amount: 0n, revoke: true },
    { kind: 'all', token: NFT, spender: DAPP, revoke: false },
    { kind: 'nft', token: NFT, spender: OTHER, id: 9n, revoke: false },
    { kind: 'permit2', token: USDC, spender: DAPP, amount: 123n, expiration: 1700000000, revoke: false },
  ]);
  assert.equal(isUnlimited(MaxUint256), true);
  assert.equal(isUnlimited((1n << 160n) - 1n, 160), true);
  assert.equal(isUnlimited(10n ** 24n), false);
});

test('the wrapped coin: Deposit and Withdrawal move its tokens without a Transfer', () => {
  assert.equal(wrappedNative({ id: 1, native: { symbol: 'ETH' } }), WETH);
  const r = analyzeCall(ok([
    transfer(NATIVE, ME, WETH, 10n ** 18n),
    log(WETH, [T('Deposit(address,uint256)'), A(ME)], U(10n ** 18n)),
    log(OTHER, [T('Deposit(address,uint256)'), A(ME)], U(5n)), // another contract's Deposit: not a token
  ]), ME, { wrapped: WETH });
  assert.deepEqual(r.changes, [{ kind: 'native', token: NATIVE, delta: -(10n ** 18n) }, { kind: 'erc20', token: WETH, delta: 10n ** 18n }]);
});

test('a reverted call: the reason without the prefix', () => {
  assert.deepEqual(analyzeCall({ status: '0x0', logs: [], error: { message: 'execution reverted: ERC20: transfer amount exceeds balance' } }, ME),
    { failed: true, reason: 'ERC20: transfer amount exceeds balance' });
  assert.equal(analyzeCall(null, ME), null);
});

test('risk: a permission to an ordinary account must be confirmed', () => {
  const base = { failed: false, changes: [], approvals: [] };
  assert.equal(riskOf(base), null);
  assert.equal(riskOf({ ...base, approvals: [{ kind: 'erc20', unlimited: false, spenderKind: 'contract' }] }), null);
  assert.equal(riskOf({ ...base, approvals: [{ kind: 'erc20', unlimited: true, spenderKind: 'contract' }] }), 'danger');
  assert.equal(riskOf({ ...base, approvals: [{ kind: 'all', spenderKind: 'contract' }] }), 'danger');
  assert.equal(riskOf({ ...base, approvals: [{ kind: 'erc20', unlimited: false, spenderKind: 'account' }] }), 'ack');
  assert.equal(riskOf({ ...base, approvals: [{ kind: 'erc20', spenderKind: 'delegated' }] }), 'ack');
  assert.equal(riskOf({ ...base, approvals: [{ kind: 'erc20', spenderKind: 'account', revoke: true }] }), null);
  assert.equal(riskOf({ ...base, changes: [{ kind: 'erc20', delta: -1n, all: true }] }), 'danger');
});

test('EIP-7702: the delegate from the account code', () => {
  assert.equal(delegateOf('0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b'), '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B');
  assert.equal(delegateOf('0x'), null);
  assert.equal(delegateOf('0x6080604052'), null);
});

test('simulateTx: skips nodes that can\'t simulate; a transaction error is a failure; none -> null', async () => {
  const chain = { id: 1, rpc: ['https://a', 'https://b', 'https://c'], native: { symbol: 'ETH' } };
  const answers = {
    'https://a': { error: { code: -32601, message: 'Method not found' } },
    'https://b': { result: [{ calls: [{ status: '0x1', logs: [] }] }] },
  };
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push(url);
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'eth_simulateV1');
    assert.equal(body.params[0].traceTransfers, true);
    return { ok: true, json: async () => answers[url] };
  };
  assert.deepEqual(await simulateTx(chain, { from: ME, to: DAPP, value: '0x1', data: '0x' }), { status: '0x1', logs: [] });
  assert.deepEqual(asked, ['https://a', 'https://b']);

  answers['https://a'] = { error: { code: -38014, message: 'insufficient funds' } };
  assert.deepEqual(await simulateTx(chain, { from: ME, to: DAPP }), { status: '0x0', logs: [], error: { message: 'insufficient funds' } });

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: { code: -32601, message: 'the method eth_simulateV1 does not exist' } }) });
  assert.equal(await simulateTx(chain, { from: ME, to: DAPP }), null);
});

// ---------------------------------------------------------------- typed data
const NOW = 1_800_000_000;

test('EIP-2612 and DAI permits', () => {
  const p = readPermit({ primaryType: 'Permit', domain: { name: 'USD Coin', verifyingContract: USDC }, message: { owner: ME, spender: DAPP, value: '1000000', nonce: 0, deadline: String(NOW + 3600) } }, NOW);
  assert.deepEqual(p, { kind: 'permit', spender: DAPP, items: [{ token: USDC, amount: 1000000n, unlimited: false }], at: NOW + 3600, never: false, revoke: false });
  const dai = readPermit({ primaryType: 'Permit', domain: { name: 'Dai Stablecoin', verifyingContract: OTHER }, message: { holder: ME, spender: DAPP, nonce: 1, expiry: 0, allowed: true } }, NOW);
  assert.deepEqual(dai, { kind: 'dai', spender: DAPP, items: [{ token: OTHER, amount: null, unlimited: true }], at: null, never: false, revoke: false });
  assert.equal(readPermit({ primaryType: 'Mail', domain: {}, message: {} }), null);
});

test('Permit2: one token, a batch (shortest expiry), transfers', () => {
  const domain = { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' };
  const max160 = ((1n << 160n) - 1n).toString();
  const single = readPermit({ primaryType: 'PermitSingle', domain, message: { details: { token: USDC, amount: max160, expiration: '281474976710655', nonce: 0 }, spender: DAPP, sigDeadline: NOW } }, NOW);
  assert.deepEqual(single, { kind: 'permit2', spender: DAPP, items: [{ token: USDC, amount: (1n << 160n) - 1n, unlimited: true }], at: null, never: true, revoke: false });
  const batch = readPermit({ primaryType: 'PermitBatch', domain, message: { details: [{ token: USDC, amount: '5', expiration: NOW + 100, nonce: 0 }, { token: OTHER, amount: '6', expiration: NOW + 50, nonce: 0 }], spender: DAPP, sigDeadline: NOW } }, NOW);
  assert.equal(batch.items.length, 2);
  assert.equal(batch.at, NOW + 50);
  const transfer = readPermit({ primaryType: 'PermitBatchTransferFrom', domain, message: { permitted: [{ token: USDC, amount: '7' }], spender: DAPP, nonce: 1, deadline: NOW + 10 } }, NOW);
  assert.deepEqual(transfer, { kind: 'permit2transfer', spender: DAPP, items: [{ token: USDC, amount: 7n, unlimited: false }], at: NOW + 10, never: false, revoke: false });
});

test('Seaport: an NFT listed for nothing is flagged', () => {
  const order = (consideration) => ({
    primaryType: 'OrderComponents', domain: { name: 'Seaport', version: '1.6' },
    message: { offerer: ME, offer: [{ itemType: 2, token: NFT, identifierOrCriteria: '42', startAmount: '1', endAmount: '1' }], consideration },
  });
  const free = readSeaport(order([{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: OTHER }]));
  assert.equal(free.free, true);
  assert.equal(free.give[0].nft, true);
  assert.equal(free.toOthers.length, 1);
  const sale = readSeaport(order([{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '1000000000000000000', endAmount: '1000000000000000000', recipient: ME }]));
  assert.equal(sale.free, false);
  assert.equal(sale.get[0].amount, 10n ** 18n);
  assert.equal(readSeaport({ primaryType: 'OrderComponents', domain: { name: 'Other' }, message: {} }), null);
});
