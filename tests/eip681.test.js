import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentQr, paymentUri } from '../src/shared/eip681.js';
import { NATIVE } from '../src/shared/chains.js';

const ME = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

test('plain address', () => {
  assert.deepEqual(parsePaymentQr(` ${ME.toLowerCase()} `), { address: ME });
});
test('native payment with chain and amount (exponent notation)', () => {
  const r = parsePaymentQr(`ethereum:${ME}@137?value=1.5e18`);
  assert.equal(r.address, ME); assert.equal(r.chainId, 137); assert.equal(r.token, NATIVE);
  assert.equal(r.amountRaw, 1500000000000000000n);
});
test('ERC-20 transfer', () => {
  const r = parsePaymentQr(`ethereum:${USDC}@1/transfer?address=${ME}&uint256=2500000`);
  assert.equal(r.address, ME); assert.equal(r.token, USDC); assert.equal(r.chainId, 1); assert.equal(r.amountRaw, 2500000n);
});
test('rejects other contract calls and garbage; fractional wei means no amount', () => {
  assert.equal(parsePaymentQr(`ethereum:${USDC}/approve?address=${ME}&uint256=1`), null);
  assert.equal(parsePaymentQr(`ethereum:${ME}?value=0.5`).amountRaw, null);
  assert.equal(parsePaymentQr('hello'), null);
  assert.equal(parsePaymentQr(`ethereum:${USDC}/transfer?address=nope`), null);
});
test('request URI round-trips', () => {
  for (const req of [
    { address: ME, chainId: 10, token: NATIVE, amountRaw: 10n ** 17n },
    { address: ME, chainId: 8453, token: USDC, amountRaw: 42n },
    { address: ME, chainId: 1, token: USDC },
  ]) {
    const r = parsePaymentQr(paymentUri(req));
    assert.equal(r.address, req.address); assert.equal(r.chainId, req.chainId);
    assert.equal(r.token.toLowerCase(), req.token.toLowerCase()); assert.equal(r.amountRaw, req.amountRaw ?? null);
  }
});
