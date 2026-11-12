// TON bridge providers on mocked APIs (shapes from real Relay / Symbiosis answers): requests and mapping.
import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erc20 } from '../src/shared/rpc.js';
import { tonBridgeQuote, TON_ASSETS, RELAY_TON, SYMBIOSIS_TON, USDT_TON } from '../src/shared/ton/bridge.js';
import { NATIVE } from '../src/shared/chains.js';

const BASE = { id: 8453, name: 'Base', native: { symbol: 'ETH', decimals: 18 } };
const ETH = { address: NATIVE, symbol: 'ETH', decimals: 18, native: true };
const USDC = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 };
const TONADDR = 'UQBJNfYc8vIE09gx6kOTWzz7W0V-2snUUQqkqASd8D4ok0jH', EVM = '0x' + '12'.repeat(20);
const SPENDER = '0x' + 'ab'.repeat(20);

function mock(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => { const body = init?.body ? JSON.parse(init.body) : null; calls.push({ url: String(url), body }); return new Response(JSON.stringify(responder(String(url), body)), { status: 200 }); };
  return calls;
}

test('Relay: GRAM out of TON -> TON messages as given (mode 1, no bounce)', async () => {
  const calls = mock(() => ({
    requestId: '0xreq',
    steps: [{ id: 'deposit', kind: 'transaction', requestId: '0xreq', items: [{ data: { messages: [{ from: 'x', to: 'EQCrdGsDTqA2t6xRR4N6V4J705F7w_VQbUdHnofsh-8lVIPs', mode: 1, value: '20000000000', bounce: false, body: 'te6cc' }] } }] }],
    details: { currencyOut: { amount: '24724627', minimumAmount: '24600000', amountUsd: '24.7' }, timeEstimate: 5 }, fees: { relayer: { amountUsd: '0.1' } },
  }));
  const q = await tonBridgeQuote({ dir: 'out', evmChain: BASE, evmToken: USDC, tonAsset: TON_ASSETS.GRAM, amount: '20000000000', evmAddress: EVM, tonAddress: TONADDR });
  const b = calls[0].body;
  assert.equal(b.originChainId, RELAY_TON);
  assert.equal(b.destinationChainId, 8453);
  assert.equal(b.originCurrency, 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
  assert.equal(b.destinationCurrency, USDC.address);
  assert.equal(b.user, TONADDR);
  assert.equal(b.recipient, EVM);
  assert.equal(q.exec.kind, 'ton');
  assert.equal(q.exec.mode, 1);
  assert.deepEqual(q.exec.messages[0], { to: 'EQCrdGsDTqA2t6xRR4N6V4J705F7w_VQbUdHnofsh-8lVIPs', value: '20000000000', bounce: false, body: 'te6cc' });
  assert.equal(q.minOut, '24600000');
  assert.equal(q.ref.requestId, '0xreq');
});

test('Relay: into TON from an ERC-20 -> EVM transaction and spender', async () => {
  const calls = mock(() => ({
    steps: [
      { id: 'approve', kind: 'transaction', items: [{ data: { to: USDC.address, data: erc20.encodeFunctionData('approve', [SPENDER, 5n]), value: '0' } }] },
      { id: 'deposit', kind: 'transaction', requestId: '0xr2', items: [{ data: { to: '0x' + 'cd'.repeat(20), data: '0x1234', value: '0' } }] },
    ],
    details: { currencyOut: { amount: '16037917639', amountUsd: '20' }, timeEstimate: 1 },
  }));
  const q = await tonBridgeQuote({ dir: 'in', evmChain: BASE, evmToken: USDC, tonAsset: TON_ASSETS.GRAM, amount: '20000000', evmAddress: EVM, tonAddress: TONADDR });
  assert.equal(calls[0].body.destinationChainId, RELAY_TON);
  assert.equal(calls[0].body.recipient, TONADDR);
  assert.equal(q.exec.kind, 'evm');
  assert.equal(q.exec.spender.toLowerCase(), SPENDER);
  assert.equal(q.exec.tx.data, '0x1234');
});

test('Symbiosis: USD₮ out of TON -> jetton messages; into TON from ETH -> EVM tx without approval', async () => {
  let calls = mock(() => ({
    type: 'ton', kind: 'crosschain-swap', estimatedTime: 24,
    tokenAmountOut: { amount: '19459812', decimals: 6, priceUsd: 0.9995 }, tokenAmountOutMin: { amount: '19070124', decimals: 6 },
    tx: { validUntil: 1, messages: [{ address: 'EQDYAb9C2POD1mZ3zV9coi_6J9tBZ1zDO5KYm58-PVKY8Tuf', amount: '200000000', payload: 'te6cc' }] },
    fees: [{ value: { amount: '250000', decimals: 6, priceUsd: 1 } }],
  }));
  let q = await tonBridgeQuote({ dir: 'out', evmChain: BASE, evmToken: USDC, tonAsset: TON_ASSETS.USDT, amount: '20000000', evmAddress: EVM, tonAddress: TONADDR });
  const b = calls[0].body;
  assert.match(calls[0].url, /symbiosis\.finance\/crosschain\/v2\/quote$/);
  assert.equal(b.tokenAmountIn.chainId, SYMBIOSIS_TON);
  assert.equal(b.tokenAmountIn.address, USDT_TON.symbiosis);
  assert.equal(b.tokenAmountIn.attributes.ton, USDT_TON.master);
  assert.equal(b.tokenAmountIn.amount, '20000000');
  assert.equal(b.tokenOut.address, USDC.address);
  assert.equal(b.from, TONADDR);
  assert.equal(b.to, EVM);
  assert.equal(q.exec.kind, 'ton');
  assert.deepEqual(q.exec.messages[0], { to: 'EQDYAb9C2POD1mZ3zV9coi_6J9tBZ1zDO5KYm58-PVKY8Tuf', value: '200000000', bounce: true, body: 'te6cc' });
  assert.equal(q.minOut, '19070124');
  assert.ok(Math.abs(q.feesUsd - 0.25) < 1e-9);
  assert.deepEqual(q.ref, { tonAddress: TONADDR, inbound: false });

  calls = mock(() => ({ type: 'evm', kind: 'crosschain-swap', approveTo: SPENDER, tokenAmountOut: { amount: '19448623', decimals: 6 }, tx: { chainId: 8453, to: SPENDER, data: '0xa11b', value: '10000000000000000' } }));
  q = await tonBridgeQuote({ dir: 'in', evmChain: BASE, evmToken: ETH, tonAsset: TON_ASSETS.USDT, amount: '10000000000000000', evmAddress: EVM, tonAddress: TONADDR });
  assert.equal(calls[0].body.tokenAmountIn.address, '', 'native ETH is "" for Symbiosis');
  assert.equal(q.exec.kind, 'evm');
  assert.equal(q.exec.spender, null, 'no approval for the native coin');
  assert.equal(q.exec.tx.value, '10000000000000000');
});

test('Symbiosis: deposit-address routes (Changelly) are refused', async () => {
  mock(() => ({ type: 'evm', kind: 'changelly-trade', tx: { depositAddress: '' } }));
  await assert.rejects(() => tonBridgeQuote({ dir: 'in', evmChain: BASE, evmToken: ETH, tonAsset: TON_ASSETS.USDT, amount: '1', evmAddress: EVM, tonAddress: TONADDR }));
});
