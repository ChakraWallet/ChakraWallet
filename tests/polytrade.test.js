// Polymarket trading math and payloads, checked against the vectors of the official SDK tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { TypedDataEncoder, Wallet, verifyTypedData, getAddress, AbiCoder, keccak256, toUtf8Bytes, concat, toBeHex } from 'ethers';
import { limitAmounts, marketAmounts, safeAddressOf, isV3Token, exchangeFor, walkBook, snap, buildOrder, authTyped, hmacSign, safeExec, iface, C, SIG, call, wrapDepositWalletSignature, walletBatchTyped, ORDER_TYPE_STRING } from '../src/shared/polytrade.js';

const TICKS = [
  { tick: 0.1, price: 0.3, limit: 3_702_000n, marketBuy: 41_133_000n },
  { tick: 0.01, price: 0.37, limit: 4_565_800n, marketBuy: 33_351_300n },
  { tick: 0.005, price: 0.375, limit: 4_627_500n, marketBuy: 32_906_660n },
  { tick: 0.0025, price: 0.3725, limit: 4_596_650n, marketBuy: 33_127_516n },
  { tick: 0.001, price: 0.373, limit: 4_602_820n, marketBuy: 33_083_100n },
  { tick: 0.0001, price: 0.3729, limit: 4_601_586n, marketBuy: 33_091_981n },
];

test('limit order amounts (SDK vectors)', () => {
  for (const c of TICKS) {
    assert.deepEqual(limitAmounts({ side: 'BUY', price: c.price, size: 12.34, tick: c.tick }), { makerAmount: c.limit, takerAmount: 12_340_000n }, `BUY tick ${c.tick}`);
    assert.deepEqual(limitAmounts({ side: 'SELL', price: c.price, size: 12.34, tick: c.tick }), { makerAmount: 12_340_000n, takerAmount: c.limit }, `SELL tick ${c.tick}`);
  }
  assert.deepEqual(limitAmounts({ side: 'BUY', price: 0.37, size: 12.349, tick: 0.01 }), { makerAmount: 4_565_800n, takerAmount: 12_340_000n }, 'size rounded down to 2 decimals');
  assert.deepEqual(limitAmounts({ side: 'BUY', price: 0.5, size: 2.01, tick: 0.1 }), { makerAmount: 1_005_000n, takerAmount: 2_010_000n }, 'float drift');
});

test('market order amounts (SDK vectors)', () => {
  for (const c of TICKS) assert.deepEqual(marketAmounts({ side: 'BUY', amount: 12.34, price: c.price, tick: c.tick }), { makerAmount: 12_340_000n, takerAmount: c.marketBuy }, `tick ${c.tick}`);
  assert.deepEqual(marketAmounts({ side: 'BUY', amount: 1, price: 0.07, tick: 0.01 }), { makerAmount: 1_000_000n, takerAmount: 14_285_700n });
  assert.deepEqual(marketAmounts({ side: 'BUY', amount: 1, price: 0.5, tick: 0.01 }), { makerAmount: 1_000_000n, takerAmount: 2_000_000n });
  assert.throws(() => marketAmounts({ side: 'BUY', amount: 1, price: 0.375, tick: 0.01 }), /tick/);
  assert.throws(() => marketAmounts({ side: 'BUY', amount: 1, price: 1, tick: 0.01 }), /range/);
});

test('Safe address of an owner (SDK vector)', () => {
  assert.equal(safeAddressOf('0x0000000000000000000000000000000000000001').toLowerCase(), '0x766b6851a199bf91ae3fa13b1cfac5187355118f');
});

test('protocol version and exchange from the token id', () => {
  const ctfToken = '55418511080416011078269734223992964142248251554828599457839875517681155989937';
  assert.equal(isV3Token(ctfToken), false);
  assert.equal(exchangeFor(ctfToken, false), C.exchange);
  assert.equal(exchangeFor(ctfToken, true), C.negRiskExchange);
  const v3 = (1n << 248n) | (123n << 8n) | 1n; // module 1, reserved bits clear
  assert.equal(isV3Token(v3.toString()), true);
  assert.equal(exchangeFor(v3.toString(), false), C.exchangeV3);
  const r = iface.router.decodeFunctionData('redeem', call.redeemV3(v3.toString(), 5n).data);
  assert.equal(r[1], 1n); assert.equal(r[2], 5n);
});

test('order book walk and tick snapping', () => {
  const asks = [{ price: '0.55', size: '10' }, { price: '0.50', size: '4' }];
  const b = walkBook(asks, 'BUY', 4); // 4 shares at 0.50 = 2 $, then 2 $ at 0.55
  assert.ok(b.complete); assert.equal(b.worst, 0.55); assert.ok(Math.abs(b.shares - (4 + 2 / 0.55)) < 1e-9);
  const s = walkBook([{ price: '0.40', size: '3' }, { price: '0.45', size: '2' }], 'SELL', 4);
  assert.ok(s.complete); assert.equal(s.worst, 0.4); assert.ok(Math.abs(s.usd - (2 * 0.45 + 2 * 0.4)) < 1e-9);
  assert.equal(walkBook(asks, 'BUY', 100).complete, false);
  assert.equal(snap(0.5671, 0.01, true), 0.57); assert.equal(snap(0.5671, 0.01, false), 0.56);
  assert.equal(snap(1.2, 0.01, true), 0.99); assert.equal(snap(0, 0.001, false), 0.001);
});

test('order typed data: signed by the EOA, maker = Safe', async () => {
  const w = Wallet.createRandom();
  const safe = safeAddressOf(w.address);
  const o = buildOrder({ tokenId: '55418511080416011078269734223992964142248251554828599457839875517681155989937', side: 'BUY', makerAmount: 1_000_000n, takerAmount: 2_000_000n, maker: safe, signer: w.address, signatureType: SIG.SAFE, negRisk: true, salt: 42n, timestamp: 1700000000000 });
  assert.equal(o.typed.domain.name, 'Polymarket CTF Exchange');
  assert.equal(o.typed.domain.version, '2');
  assert.equal(o.typed.domain.verifyingContract, C.negRiskExchange);
  const sig = await w.signTypedData(o.typed.domain, o.typed.types, o.typed.message);
  assert.equal(verifyTypedData(o.typed.domain, o.typed.types, o.typed.message, sig), w.address);
  const wire = o.wire(sig);
  assert.equal(wire.salt, 42); assert.equal(wire.side, 'BUY'); assert.equal(wire.signatureType, 2);
  assert.equal(wire.maker, getAddress(safe)); assert.equal(wire.signer, w.address); assert.equal(wire.expiration, '0');
  // the order type string must match the exchange's ORDER_TYPEHASH
  assert.equal(TypedDataEncoder.from(o.typed.types).encodeType('Order'),
    'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)');
});

test('auth typed data and L2 HMAC', async () => {
  const a = authTyped('0x0000000000000000000000000000000000000001', 1700000000);
  assert.equal(a.domain.name, 'ClobAuthDomain'); assert.equal(a.message.timestamp, '1700000000');
  assert.equal(TypedDataEncoder.from(a.types).encodeType('ClobAuth'), 'ClobAuth(address address,string timestamp,uint256 nonce,string message)');
  const secret = Buffer.from('a-test-secret-key-0123456789').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const body = '{"orderID":"0xabc"}';
  const expected = createHmac('sha256', Buffer.from('a-test-secret-key-0123456789')).update(`1700000000DELETE/order${body}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(await hmacSign(secret, 1700000000, 'DELETE', '/order', body), expected);
});

test('Safe execTransaction by its owner: approved-by-sender signature, MultiSend for batches', () => {
  const owner = '0x00000000000000000000000000000000000000aa';
  const one = iface.safe.decodeFunctionData('execTransaction', safeExec(owner, [call.approve(C.pusd, C.exchange)]));
  assert.equal(one[0], C.pusd); assert.equal(one[3], 0n);
  assert.equal(one[9], '0x' + '0'.repeat(24) + owner.slice(2) + '0'.repeat(64) + '01');
  const two = iface.safe.decodeFunctionData('execTransaction', safeExec(owner, [call.approve(C.pusd, C.exchange), call.unwrap(C.usdc, owner, 5n)]));
  assert.equal(two[0], C.multiSend); assert.equal(two[3], 1n); // delegatecall
});

test('Deposit Wallet order: TypedDataSign signed by the owner, ERC-7739 wrapped signature (docs algorithm)', async () => {
  const owner = Wallet.createRandom();
  const dw = '0x5bfdd20e567fcaba5f48c61a2c28174a262710bd';
  const token = '71321045679252212594626385532706912750332728571942532289631379312455583992563'; // CTF token (domain "2")
  const o = buildOrder({ tokenId: token, side: 'BUY', makerAmount: 5_200_000n, takerAmount: 10_000_000n, maker: dw, signer: dw, signatureType: SIG.DEPOSIT, negRisk: false, salt: 479249096354n, timestamp: 1_700_000_000_000 });
  assert.equal(o.typed.domain.name, 'Polymarket CTF Exchange');
  assert.equal(o.typed.message.name, 'DepositWallet');
  assert.equal(o.typed.message.verifyingContract, getAddress(dw));
  assert.equal(o.typed.message.contents.signer, getAddress(dw));
  assert.equal(o.typed.message.contents.signatureType, 3);
  // the owner signs the nested TypedDataSign (ethers picks it as primary type: it references Order)
  assert.equal(TypedDataEncoder.getPrimaryType(o.typed.types), 'TypedDataSign');
  const inner = await owner.signTypedData(o.typed.domain, o.typed.types, o.typed.message);
  assert.equal(verifyTypedData(o.typed.domain, o.typed.types, o.typed.message, inner), owner.address);

  // wrapped signature, recomputed exactly as in Polymarket's docs (wrapDepositWalletSignature)
  const enc = AbiCoder.defaultAbiCoder();
  const d = o.typed.domain, m = o.typed.message.contents;
  const appDomainSeparator = keccak256(enc.encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    keccak256(toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toUtf8Bytes(d.name)), keccak256(toUtf8Bytes(d.version)), d.chainId, d.verifyingContract]));
  const contentsHash = keccak256(enc.encode(['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint8', 'uint8', 'uint256', 'bytes32', 'bytes32'], [
    keccak256(toUtf8Bytes(ORDER_TYPE_STRING)), m.salt, m.maker, m.signer, m.tokenId, m.makerAmount, m.takerAmount, m.side, m.signatureType, m.timestamp, m.metadata, m.builder]));
  const expected = concat([inner, appDomainSeparator, contentsHash, toUtf8Bytes(ORDER_TYPE_STRING), toBeHex(ORDER_TYPE_STRING.length, 2)]);
  const wire = o.wire(inner);
  assert.equal(wire.signature, expected);
  assert.equal(wrapDepositWalletSignature(d, m, inner), expected);
  assert.equal(wire.signatureType, 3);
  assert.equal(wire.maker, getAddress(dw));
  assert.equal(wire.signer, getAddress(dw));
  assert.equal(wire.salt, 479249096354);
});

test('Deposit Wallet batch typed data (relayer)', async () => {
  const owner = Wallet.createRandom();
  const dw = '0x5bfdd20e567fcaba5f48c61a2c28174a262710bd';
  const calls = [call.approve(C.pusd, C.offramp, 5n), call.unwrap(C.usdc, owner.address, 5n)];
  const b = walletBatchTyped(dw, 7, 1_800_000_000, calls);
  assert.deepEqual(b.domain, { name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: getAddress(dw) });
  assert.equal(b.message.nonce, '7');
  assert.equal(b.message.calls.length, 2);
  assert.equal(b.message.calls[1].target, getAddress(C.offramp));
  assert.equal(b.message.calls[0].value, '0');
  const sig = await owner.signTypedData(b.domain, b.types, b.message);
  assert.equal(verifyTypedData(b.domain, b.types, b.message, sig), owner.address);
});

test('ramp pause check: the selector Polymarket\'s on/offramp expose (paused(address) on chain)', () => {
  assert.equal(iface.ramp.getFunction('paused').selector, '0x2e48152c');
});
