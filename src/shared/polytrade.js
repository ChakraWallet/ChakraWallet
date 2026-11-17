// Polymarket trading (phase 2-3), client-side only. Mirrors the official SDK (@polymarket/client, MIT):
// order amounts (actions/orders/amounts.ts + fixed.ts), EIP-712 order and auth payloads (exchange.ts,
// authentication.ts), L2 HMAC (hmac.ts), Safe address derivation (wallet.ts). Everything here is pure (no
// network, no keys) so it can be unit-tested; signing happens in the background with the user's password.
import { AbiCoder, Interface, TypedDataEncoder, getAddress, getCreate2Address, keccak256, solidityPacked, concat, zeroPadValue, toBeHex, toUtf8Bytes } from 'ethers';

export const C = {
  pusd: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',          // Polymarket USD (collateral), 6 decimals
  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',          // USDC (native) on Polygon
  usdce: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',         // USDC.e (bridged) on Polygon
  onramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',        // USDC / USDC.e -> pUSD
  offramp: '0x2957922Eb93258b93368531d39fAcCA3B4dC5854',       // pUSD -> USDC / USDC.e
  ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',           // Gnosis Conditional Tokens (ERC-1155)
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  collateralAdapter: '0xAdA100Db00Ca00073811820692005400218FcE1f',
  negRiskCollateralAdapter: '0xadA2005600Dec949baf300f4C6120000bDB6eAab',
  exchange: '0xE111180000d2663C0091e4f400237545B87B996B',      // CTF Exchange V2
  negRiskExchange: '0xe2222d279d744050d28e00520010520000310F59',
  exchangeV3: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',    // protocol v2 positions
  router: '0x12121212006e4CD160D18e3f00711DA5c3372600',        // protocol v2 router (redeem)
  positionManager: '0x006F54F7f9A22e0000CC2AB60031000000ae9fEF', // protocol v2 positions (ERC-1155)
  autoRedeemer: '0xa1200000d0002264C9a1698e001292D00E1b00af',   // approved by accounts with "Auto redeem your wins" on
  safeFactory: '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b',
  safeInitCodeHash: '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf',
  multiSend: '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
  dwFactory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',     // Deposit Wallet factory (runs batches sent by the relayer)
  dwBeacon: '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a',
};
export const CHAIN_ID = 137;
export const MAX_UINT = (1n << 256n) - 1n;
export const SIG = { EOA: 0, PROXY: 1, SAFE: 2, DEPOSIT: 3 };

export const iface = {
  erc20: new Interface(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)']),
  erc1155: new Interface(['function setApprovalForAll(address operator, bool approved)', 'function isApprovedForAll(address account, address operator) view returns (bool)', 'function balanceOf(address account, uint256 id) view returns (uint256)']),
  // Polymarket can pause a ramp for one asset (it did for native USDC): wrap / unwrap then revert with OnlyUnpaused()
  ramp: new Interface(['function wrap(address _asset, address _to, uint256 _amount)', 'function unwrap(address _asset, address _to, uint256 _amount)', 'function paused(address _asset) view returns (bool)']),
  ctfRedeem: new Interface(['function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)']),
  router: new Interface(['function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)']),
  safe: new Interface([
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
    'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)',
  ]),
  multiSend: new Interface(['function multiSend(bytes transactions) payable']),
  // Deposit Wallet (accounts created on polymarket.com since May 2026): owned by the address, moved by the relayer;
  // the owner alone can only pause it and, after the factory's timelock, withdraw (emergency exit)
  dw: new Interface([
    'function owner() view returns (address)', 'function paused() view returns (uint256)',
    'function pause()', 'function unpause()', 'function withdrawERC20(address _token, address _to, uint256 _amount)',
  ]),
  dwFactory: new Interface(['function timelockDelay() view returns (uint256)']),
};

// ------------------------------------------------------------ accounts
/** Address of the Polymarket Safe ("browser wallet" accounts) owned by an EOA. */
export function safeAddressOf(eoa) {
  return getCreate2Address(C.safeFactory, keccak256(AbiCoder.defaultAbiCoder().encode(['address'], [eoa])), C.safeInitCodeHash);
}

/**
 * A call executed by a 1-of-1 Safe, sent directly by its owner (who pays the gas): the "approved by sender"
 * signature (r = owner, s = 0, v = 1) needs no off-chain signature. Several calls are batched with MultiSend.
 */
export function safeExec(owner, calls) {
  const sig = concat([zeroPadValue(owner, 32), zeroPadValue('0x00', 32), '0x01']);
  let to, data, op;
  if (calls.length === 1) ({ to, data } = calls[0]), op = 0;
  else {
    const packed = concat(calls.map((c) => solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, c.to, c.value || 0n, (c.data.length - 2) / 2, c.data])));
    to = C.multiSend; data = iface.multiSend.encodeFunctionData('multiSend', [packed]); op = 1; // delegatecall
  }
  return iface.safe.encodeFunctionData('execTransaction', [to, 0n, data, op, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', sig]);
}

// ------------------------------------------------------------ markets
const V2_RESERVED_BITS_MASK = ((1n << 64n) - 1n) << 40n;
/** Protocol v2 positions (newer markets) trade on another exchange, with EIP-712 domain version "3". */
export function isV3Token(tokenId) {
  try { return (BigInt(tokenId) & V2_RESERVED_BITS_MASK) === 0n; } catch { return false; }
}
export function exchangeFor(tokenId, negRisk) {
  return isV3Token(tokenId) ? C.exchangeV3 : negRisk ? C.negRiskExchange : C.exchange;
}
/** ERC-1155 contract holding the outcome tokens of a market (for sell approvals). */
export const positionsContractFor = (tokenId) => (isV3Token(tokenId) ? C.positionManager : C.ctf);

// ------------------------------------------------------------ amounts (6-decimal fixed point, as the SDK)
const SCALE = 1_000_000n;
const ROUNDING = { 0.1: [3, 2], 0.01: [4, 2], 0.005: [5, 2], 0.0025: [6, 2], 0.001: [5, 2], 0.0001: [6, 2] };
export function rounding(tick) {
  const r = ROUNDING[Number(tick)];
  if (!r) throw new Error(`Unsupported tick size ${tick}`);
  return { amount: r[0], size: r[1] };
}
const quantum = (dp) => 10n ** BigInt(6 - dp);
const mulDiv = (v, m, d, up = false) => { const n = v * m; const q = n / d; return up && n % d !== 0n ? q + 1n : q; };
const quantize = (v, dp) => (v / quantum(dp)) * quantum(dp); // rounds down
export function toScaled(x) {
  const s = x * 1e6, c = Math.round(s);
  return BigInt(Math.abs(s - c) <= 8 * Number.EPSILON * Math.max(1, Math.abs(s)) ? c : Math.trunc(s));
}
export function scaledPrice(p, tick) {
  const sp = BigInt(Math.round(p * 1e6)), st = BigInt(Math.round(Number(tick) * 1e6));
  if (sp < st || sp > SCALE - st) throw new Error('price out of range');
  if (sp % st !== 0n) throw new Error('price not on the tick grid');
  return sp;
}
const mulPrice = (a, p, dp) => mulDiv(a, p, SCALE * quantum(dp)) * quantum(dp);
const divPrice = (a, p, dp) => mulDiv(a, SCALE, p * quantum(dp)) * quantum(dp);

/** Limit order: size shares at price. -> { makerAmount, takerAmount } (raw 6-decimal units) */
export function limitAmounts({ side, price, size, tick }) {
  const r = rounding(tick), p = scaledPrice(price, tick), s = quantize(toScaled(size), r.size);
  return side === 'BUY' ? { makerAmount: mulPrice(s, p, r.amount), takerAmount: s } : { makerAmount: s, takerAmount: mulPrice(s, p, r.amount) };
}
/** Market order with a protected price: BUY spends `amount` USD at most at `price`; SELL sells `amount` shares at least at `price`. */
export function marketAmounts({ side, amount, price, tick }) {
  const r = rounding(tick), p = scaledPrice(price, tick), a = quantize(toScaled(amount), r.size);
  return side === 'BUY' ? { makerAmount: a, takerAmount: divPrice(a, p, r.amount) } : { makerAmount: a, takerAmount: mulPrice(a, p, r.amount) };
}
/** Snap a price to the tick grid (up for a buy limit, down for a sell limit), inside [tick, 1 - tick]. */
export function snap(price, tick, up) {
  const t = Number(tick), n = (up ? Math.ceil : Math.floor)(price / t - 1e-9);
  return Math.min(1 - t, Math.max(t, Number((n * t).toFixed(6))));
}

/**
 * Walk the order book. BUY: spend `amount` USD on the asks; SELL: sell `amount` shares on the bids.
 * Levels may come in any order. -> { filled (USD or shares used), shares, usd, avg, worst, complete }
 */
export function walkBook(levels, side, amount) {
  const sorted = [...(levels || [])].map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => l.size > 0).sort((a, b) => (side === 'BUY' ? a.price - b.price : b.price - a.price));
  let left = amount, shares = 0, usd = 0, worst = null;
  for (const l of sorted) {
    if (left <= 1e-9) break;
    const take = side === 'BUY' ? Math.min(l.size, left / l.price) : Math.min(l.size, left);
    shares += take; usd += take * l.price; worst = l.price;
    left -= side === 'BUY' ? take * l.price : take;
  }
  return { shares, usd, avg: shares ? usd / shares : null, worst, complete: left <= 1e-6 };
}

/** Polymarket platform fee (charged at match): rate × (p(1−p))^exponent per share. */
export const feePerShare = (price, fee) => (fee?.rate ? fee.rate * (price * (1 - price)) ** (fee.exponent ?? 1) : 0);

// ------------------------------------------------------------ EIP-712 payloads (ethers v6 signTypedData shape)
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' }, { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' }, { name: 'builder', type: 'bytes32' },
  ],
};
const ZERO32 = '0x' + '0'.repeat(64);
export const ORDER_DOMAIN_NAME = 'Polymarket CTF Exchange';
export const AUTH_DOMAIN_NAME = 'ClobAuthDomain';

/** 53-bit random salt (sent as a JSON number, must survive the round trip). */
export function newSalt() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return BigInt('0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')) & ((1n << 53n) - 1n);
}

/**
 * Unsigned order -> { typed: {domain, types, message} to sign, wire(signature): POST /order body.order }.
 * maker = the account holding the funds (EOA, Safe or Deposit Wallet); signer = the EOA (the Deposit Wallet itself for type 3).
 */
export function buildOrder({ tokenId, side, makerAmount, takerAmount, maker, signer, signatureType, negRisk, expiration = 0, salt = newSalt(), timestamp = Date.now() }) {
  const v3 = isV3Token(tokenId);
  const domain = { name: ORDER_DOMAIN_NAME, version: v3 ? '3' : '2', chainId: CHAIN_ID, verifyingContract: exchangeFor(tokenId, negRisk) };
  const message = {
    salt: salt.toString(), maker: getAddress(maker), signer: getAddress(signer), tokenId: BigInt(tokenId).toString(),
    makerAmount: makerAmount.toString(), takerAmount: takerAmount.toString(), side: side === 'BUY' ? 0 : 1,
    signatureType, timestamp: String(timestamp), metadata: ZERO32, builder: ZERO32,
  };
  const dw = signatureType === SIG.DEPOSIT;
  return {
    // Deposit Wallet: the owner signs the order wrapped in the wallet's TypedDataSign (ERC-7739)
    typed: dw
      ? { domain, types: { ...ORDER_TYPES, TypedDataSign: TYPED_DATA_SIGN }, message: { contents: message, name: DW_DOMAIN_NAME, version: '1', chainId: String(CHAIN_ID), verifyingContract: message.maker, salt: ZERO32 } }
      : { domain, types: ORDER_TYPES, message },
    wire: (sig) => ({
      salt: Number(salt), maker: message.maker, signer: message.signer, tokenId: message.tokenId,
      makerAmount: message.makerAmount, takerAmount: message.takerAmount, side, signatureType,
      timestamp: message.timestamp, expiration: String(expiration), metadata: ZERO32, builder: ZERO32,
      signature: dw ? wrapDepositWalletSignature(domain, message, sig) : sig,
    }),
  };
}

// ------------------------------------------------------------ Deposit Wallet (signature type 3)
// Orders are validated by the wallet through ERC-1271 + ERC-7739: the owner signs a TypedDataSign that nests the
// Order, and the signature sent to the CLOB carries the exchange's domain separator, the order's struct hash and
// the Order type string (docs.polymarket.com/trading/place-orders, wrapDepositWalletSignature).
export const ORDER_TYPE_STRING = 'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)';
export const DW_DOMAIN_NAME = 'DepositWallet';
const TYPED_DATA_SIGN = [
  { name: 'contents', type: 'Order' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' },
];

/** The signature the CLOB expects from a Deposit Wallet: inner ‖ appDomainSeparator ‖ contentsHash ‖ type ‖ uint16(len). */
export function wrapDepositWalletSignature(domain, order, innerSignature) {
  const appDomainSeparator = TypedDataEncoder.hashDomain(domain);
  const contentsHash = TypedDataEncoder.from({ Order: ORDER_TYPES.Order }).hashStruct('Order', order);
  const type = toUtf8Bytes(ORDER_TYPE_STRING);
  return concat([innerSignature, appDomainSeparator, contentsHash, type, toBeHex(type.length, 2)]);
}

/** A batch of calls run by the Deposit Wallet (signed by its owner, submitted gasless by Polymarket's relayer). */
export function walletBatchTyped(wallet, nonce, deadline, calls) {
  return {
    domain: { name: DW_DOMAIN_NAME, version: '1', chainId: CHAIN_ID, verifyingContract: getAddress(wallet) },
    types: {
      Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
      Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
    },
    message: { wallet: getAddress(wallet), nonce: String(nonce), deadline: String(deadline), calls: calls.map((c) => ({ target: getAddress(c.to), value: '0', data: c.data })) },
  };
}

/** L1 auth: EIP-712 ClobAuth signed by the EOA to create / derive the API key. */
export function authTyped(address, timestamp, nonce = 0) {
  return {
    domain: { name: AUTH_DOMAIN_NAME, version: '1', chainId: CHAIN_ID },
    types: { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
    message: { address: getAddress(address), timestamp: String(timestamp), nonce, message: 'This message attests that I control the given wallet' },
  };
}

/** L2 request signature: base64url(HMAC-SHA256(base64decode(secret), ts + METHOD + path + body)), padding kept. */
export async function hmacSign(secret, timestamp, method, path, body) {
  const raw = atob(secret.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, ''));
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(raw, (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}${method}${path}${body ?? ''}`)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_');
}

// ------------------------------------------------------------ on-chain calls
export const call = {
  approve: (token, spender, amount = MAX_UINT) => ({ to: token, data: iface.erc20.encodeFunctionData('approve', [spender, amount]) }),
  approveAll: (erc1155, operator) => ({ to: erc1155, data: iface.erc1155.encodeFunctionData('setApprovalForAll', [operator, true]) }),
  wrap: (asset, to, amount) => ({ to: C.onramp, data: iface.ramp.encodeFunctionData('wrap', [asset, to, amount]) }),
  unwrap: (asset, to, amount) => ({ to: C.offramp, data: iface.ramp.encodeFunctionData('unwrap', [asset, to, amount]) }),
  transfer: (token, to, amount) => ({ to: token, data: iface.erc20.encodeFunctionData('transfer', [to, amount]) }),
  /** CLOB V2 markets: the collateral adapter takes the winning tokens and pays out pUSD. */
  redeemCtf: (conditionId, negRisk) => ({ to: negRisk ? C.negRiskCollateralAdapter : C.collateralAdapter, data: iface.ctfRedeem.encodeFunctionData('redeemPositions', [C.pusd, ZERO32, conditionId, [1n, 2n]]) }),
  /** Protocol v2 markets: the router redeems one outcome at a time. The position id is conditionId (31 bytes) + outcome index (1 byte). */
  redeemV3: (tokenId, amount) => ({ to: C.router, data: iface.router.encodeFunctionData('redeem', [toBeHex(BigInt(tokenId) >> 8n, 31), BigInt(tokenId) & 0xffn, amount]) }),
};
