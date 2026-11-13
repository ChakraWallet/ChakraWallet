// Polymarket trading from the UI: account detection (own address or Polymarket Safe), API key, orders,
// approvals, deposits / withdrawals, redeems. Every signature and transaction goes through the background
// with the password the caller got from authorize() (fingerprint / password), once per user action.
import { getAddress } from 'ethers';
import { bg } from '../shared/ext.js';
import { BUILTIN_CHAINS } from '../shared/chains.js';
import { rpc, ethCall, waitForReceipt } from '../shared/rpc.js';
import { prepareTx, finalizeTx } from '../shared/tx.js';
import { getJson } from '../shared/http.js';
import { t } from '../shared/i18n.js';
import {
  C, SIG, iface, call, safeAddressOf, safeExec, exchangeFor, positionsContractFor, isV3Token,
  buildOrder, authTyped, hmacSign, marketAmounts, limitAmounts, snap, walkBook, walletBatchTyped,
} from '../shared/polytrade.js';
import { accountsOf } from '../shared/polymarket.js';

export const POLYGON = BUILTIN_CHAINS.find((c) => c.id === 137);
const CLOB = 'https://clob.polymarket.com';
const lc = (a) => String(a || '').toLowerCase();
const err = (key, vars) => Object.assign(new Error(t(key, vars)), { key });

// ------------------------------------------------------------ account
/**
 * { mode: 'eoa' | 'safe' | 'deposit' | 'readonly', wallet (holds funds and positions), signer (the EOA), sigType, reason? }
 * deposit: polymarket.com account created since May 2026 (Deposit Wallet owned by this address: orders signed
 * here, wallet operations through Polymarket's relayer). safe: older polymarket.com account (a 1-of-1 Safe it
 * owns). eoa: no Polymarket account, trades from the address itself (Polymarket must allow it).
 * readonly: a wallet we can't operate (email accounts, wallets owned by someone else).
 */
const accCache = new Map();
export async function polyAccount(address) {
  const key = lc(address);
  // short cache: an account created meanwhile on polymarket.com (e.g. from the in-app browser) is seen soon
  const hit = accCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.acc;
  const signer = getAddress(address);
  const safe = safeAddressOf(signer);
  const [accounts, code] = await Promise.all([accountsOf(address).catch(() => [key]), rpc(POLYGON, 'eth_getCode', [safe, 'latest']).catch(() => '0x')]);
  const proxy = accounts.find((a) => a !== key);
  let acc;
  if (code && code !== '0x' && (!proxy || proxy === lc(safe))) {
    const [owners, threshold] = await Promise.all([
      ethCall(POLYGON, safe, iface.safe.encodeFunctionData('getOwners')).then((r) => iface.safe.decodeFunctionResult('getOwners', r)[0].map(lc)).catch(() => []),
      ethCall(POLYGON, safe, iface.safe.encodeFunctionData('getThreshold')).then((r) => Number(BigInt(r))).catch(() => 0),
    ]);
    acc = owners.includes(key) && threshold === 1
      ? { mode: 'safe', wallet: safe, signer, sigType: SIG.SAFE }
      : { mode: 'readonly', wallet: safe, signer, reason: 'predict.acc.safeOwners' };
  } else if (proxy) {
    // Deposit Wallet: its owner() is this address
    const owner = await ethCall(POLYGON, proxy, iface.dw.encodeFunctionData('owner')).then((r) => lc(iface.dw.decodeFunctionResult('owner', r)[0])).catch(() => '');
    acc = owner === key
      ? { mode: 'deposit', wallet: getAddress(proxy), signer, sigType: SIG.DEPOSIT }
      : { mode: 'readonly', wallet: getAddress(proxy), signer, reason: 'predict.acc.unsupported' };
  }
  else acc = { mode: 'eoa', wallet: signer, signer, sigType: SIG.EOA };
  accCache.set(key, { acc, at: Date.now() });
  return acc;
}

// ------------------------------------------------------------ CLOB API (L1 / L2 auth)
const creds = new Map(); // address -> { apiKey, secret, passphrase } (memory only)
export const hasCreds = (acc) => creds.has(lc(acc.signer));

async function clobFetch(method, path, { query, body, headers = {} } = {}) {
  const url = `${CLOB}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, { method, headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw Object.assign(new Error(json?.error || json?.errorMsg || json?.message || `Polymarket ${res.status}`), { status: res.status, body: json });
  return json;
}

/** API key for the account: created (or derived, if it exists) with one EIP-712 signature. */
export async function ensureCreds(acc, password) {
  const key = lc(acc.signer);
  if (creds.has(key)) return creds.get(key);
  const ts = Math.floor(Date.now() / 1000);
  const signature = await bg('polySign', { from: acc.signer, typed: authTyped(acc.signer, ts), password });
  const headers = { POLY_ADDRESS: acc.signer, POLY_SIGNATURE: signature, POLY_TIMESTAMP: String(ts), POLY_NONCE: '0' };
  let r;
  try { r = await clobFetch('POST', '/auth/api-key', { headers }); } catch (e) {
    if (e.status !== 400) throw e;
    r = await clobFetch('GET', '/auth/derive-api-key', { headers });
  }
  const c = { apiKey: r.apiKey || r.key, secret: r.secret, passphrase: r.passphrase };
  if (!c.apiKey || !c.secret) throw new Error('Polymarket API key');
  creds.set(key, c);
  return c;
}

async function l2(acc, method, path, { query, json } = {}) {
  const c = creds.get(lc(acc.signer));
  if (!c) throw err('predict.err.locked');
  const body = json !== undefined ? JSON.stringify(json) : undefined;
  const ts = Math.floor(Date.now() / 1000);
  const headers = {
    POLY_ADDRESS: acc.signer, POLY_API_KEY: c.apiKey, POLY_PASSPHRASE: c.passphrase,
    POLY_TIMESTAMP: String(ts), POLY_SIGNATURE: await hmacSign(c.secret, ts, method, path, body), // path without the query
  };
  return clobFetch(method, path, { query, body, headers });
}

// ------------------------------------------------------------ market data
/** Order book + trading parameters of an outcome token. */
export async function bookOf(tokenId) {
  const b = await getJson(`${CLOB}/book?token_id=${tokenId}`, { label: 'Polymarket', timeout: 12000 });
  if (!b) throw err('predict.err.noBook');
  return {
    bids: b.bids || [], asks: b.asks || [], tick: Number(b.tick_size || 0.01), negRisk: !!b.neg_risk,
    minSize: Number(b.min_order_size || 0), last: b.last_trade_price != null ? Number(b.last_trade_price) : null,
  };
}
// ------------------------------------------------------------ balances
const bal20 = (token, owner) => ethCall(POLYGON, token, iface.erc20.encodeFunctionData('balanceOf', [owner])).then((r) => BigInt(r)).catch(() => 0n);
const allowance = (token, owner, spender) => ethCall(POLYGON, token, iface.erc20.encodeFunctionData('allowance', [owner, spender])).then((r) => BigInt(r)).catch(() => 0n);
const approvedAll = (erc1155, owner, operator) => ethCall(POLYGON, erc1155, iface.erc1155.encodeFunctionData('isApprovedForAll', [owner, operator])).then((r) => BigInt(r) === 1n).catch(() => false);
/**
 * "Auto redeem your wins" (polymarket.com setting): turning it on lets Polymarket's AutoRedeemer move the account's
 * positions, on both ledgers; turning it off takes that back. A failed read counts as off.
 */
export async function autoRedeemOn(acc) {
  const [ctf, v2] = await Promise.all([approvedAll(C.ctf, acc.wallet, C.autoRedeemer), approvedAll(C.positionManager, acc.wallet, C.autoRedeemer)]);
  return ctf && v2;
}
export const shareBalance = (acc, tokenId) => ethCall(POLYGON, positionsContractFor(tokenId), iface.erc1155.encodeFunctionData('balanceOf', [acc.wallet, BigInt(tokenId)])).then((r) => BigInt(r)).catch(() => 0n);

/**
 * Cash for trading (pUSD on the trading wallet), funds that can be deposited (USDC / USDC.e, and pUSD when the
 * trading wallet is a separate account: Safe / Deposit Wallet) on the address, and gas.
 */
export async function balances(acc) {
  const separate = lc(acc.wallet) !== lc(acc.signer);
  const [pusd, usdc, usdce, pusdOwn, pol] = await Promise.all([
    bal20(C.pusd, acc.wallet), bal20(C.usdc, acc.signer), bal20(C.usdce, acc.signer), separate ? bal20(C.pusd, acc.signer) : 0n,
    rpc(POLYGON, 'eth_getBalance', [acc.signer, 'latest']).then(BigInt).catch(() => 0n),
  ]);
  return { pusd, usdc, usdce, pusdOwn, pol, separate };
}

// ------------------------------------------------------------ transactions
const MIN_POL = 10n ** 16n; // 0.01 POL: below this even an approval won't go through

/** Send calls from the account: one by one from the address (eoa), or batched in one Safe transaction. */
async function sendCalls(acc, calls, password, title) {
  if (!calls.length) return [];
  const pol = await rpc(POLYGON, 'eth_getBalance', [acc.signer, 'latest']).then(BigInt).catch(() => 0n);
  if (pol < MIN_POL) throw err('predict.err.noGas');
  const batches = acc.mode === 'safe' ? [{ to: acc.wallet, data: safeExec(acc.signer, calls) }] : calls;
  const hashes = [];
  for (const c of batches) {
    const prepared = await prepareTx(POLYGON, acc.signer, { to: c.to, data: c.data, value: 0n });
    if (prepared.estimateError) throw Object.assign(new Error(t('predict.err.txWouldFail', { reason: prepared.estimateError })), { key: 'predict.err.txWouldFail' });
    if (BigInt(prepared.speeds.normal.maxCost) > pol) throw err('predict.err.noGas');
    const hash = await bg('sendTransaction', { from: acc.signer, tx: finalizeTx(prepared, 'normal'), title, password });
    const receipt = await waitForReceipt(POLYGON, hash);
    if (receipt.status !== '0x1') throw err('predict.err.txFailed');
    hashes.push(hash);
  }
  return hashes;
}

// ------------------------------------------------------------ Deposit Wallet: Polymarket relayer
const RELAYER = 'https://relayer-v2.polymarket.com';
export const hasRelayerKey = (acc) => bg('polyRelayerHas', { address: acc.signer }).catch(() => false);
export const setRelayerKey = (acc, key, password) => bg('polyRelayerSet', { address: acc.signer, key, password });

async function relayerFetch(key, acc, method, path, body) {
  const res = await fetch(`${RELAYER}${path}`, {
    method, signal: AbortSignal.timeout(20000),
    headers: { accept: 'application/json', RELAYER_API_KEY: key, RELAYER_API_KEY_ADDRESS: acc.signer, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (res.status === 401 || res.status === 403) throw err('predict.relayer.badKey');
  if (!res.ok) throw new Error(json?.error || json?.message || `Polymarket relayer ${res.status}`);
  return json;
}

/**
 * Calls run by the Deposit Wallet: the owner signs the batch (EIP-712), Polymarket's relayer submits it and pays
 * the gas. Needs the account's Relayer API key (created once on polymarket.com, kept encrypted in the vault).
 */
async function relayerExec(acc, calls, password, title) {
  const key = await bg('polyRelayerGet', { address: acc.signer, password });
  if (!key) throw err('predict.relayer.needKey');
  const q = new URLSearchParams({ address: acc.signer, type: 'WALLET' });
  const { nonce } = await relayerFetch(key, acc, 'GET', `/v1/account/transactions/params?${q}`);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const typed = walletBatchTyped(acc.wallet, nonce, deadline, calls);
  const signature = await bg('polySign', { from: acc.signer, typed, password });
  const sub = await relayerFetch(key, acc, 'POST', '/submit', {
    type: 'WALLET', from: acc.signer, to: C.dwFactory, nonce: String(nonce), signature, metadata: title,
    depositWalletParams: { depositWallet: acc.wallet, deadline: String(deadline), calls: typed.message.calls },
  });
  const id = sub?.transactionID || sub?.transactionId;
  if (!id) throw err('predict.relayer.failed', { reason: '—' });
  for (let i = 0; i < 90; i++) { // up to ~3 minutes
    await new Promise((r) => setTimeout(r, 2000));
    const tx = await relayerFetch(key, acc, 'GET', `/v1/account/transactions/${id}`).catch(() => null);
    const st = tx?.state || tx?.[0]?.state;
    if (st === 'STATE_CONFIRMED') return [tx.transaction_hash || tx.transactionHash || tx?.[0]?.transactionHash];
    if (st === 'STATE_FAILED' || st === 'STATE_INVALID') throw err('predict.relayer.failed', { reason: tx.error_msg || st });
  }
  throw err('predict.relayer.slow');
}

/** Calls from the trading wallet: relayer for a Deposit Wallet, a transaction (EOA / Safe) otherwise. */
const execCalls = (acc, calls, password, title) => (acc.mode === 'deposit' && calls.length ? relayerExec(acc, calls, password, title) : sendCalls(acc, calls, password, title));

// ------------------------------------------------------------ Deposit Wallet: emergency exit (owner only, needs POL)
/** { paused (s, 0 = active), delay (s), readyAt (ms), pusd } */
export async function emergencyState(acc) {
  const [paused, delay, pusd] = await Promise.all([
    ethCall(POLYGON, acc.wallet, iface.dw.encodeFunctionData('paused')).then((r) => Number(BigInt(r))).catch(() => 0),
    ethCall(POLYGON, C.dwFactory, iface.dwFactory.encodeFunctionData('timelockDelay')).then((r) => Number(BigInt(r))).catch(() => 3600),
    bal20(C.pusd, acc.wallet),
  ]);
  return { paused, delay, readyAt: paused ? (paused + delay + 1) * 1000 : 0, pusd };
}
const ownerTx = (acc, fn, args, password, title) => sendCalls({ ...acc, mode: 'eoa' }, [{ to: acc.wallet, data: iface.dw.encodeFunctionData(fn, args) }], password, title);
export const emergencyPause = (acc, password) => ownerTx(acc, 'pause', [], password, t('predict.emergency.txPause'));
export const emergencyUnpause = (acc, password) => ownerTx(acc, 'unpause', [], password, t('predict.emergency.txUnpause'));
export async function emergencyWithdraw(acc, password) {
  const amount = await bal20(C.pusd, acc.wallet);
  if (!amount) throw err('predict.emergency.empty');
  return ownerTx(acc, 'withdrawERC20', [C.pusd, acc.signer, amount], password, t('predict.emergency.txWithdraw'));
}

/** Approvals missing for an order (BUY: pUSD to the exchange; SELL: the outcome tokens to the exchange). */
async function orderApprovals(acc, { tokenId, side, negRisk, makerAmount }) {
  const ex = exchangeFor(tokenId, negRisk);
  if (side === 'BUY') return (await allowance(C.pusd, acc.wallet, ex)) >= makerAmount ? [] : [call.approve(C.pusd, ex)];
  const erc1155 = positionsContractFor(tokenId);
  return (await approvedAll(erc1155, acc.wallet, ex)) ? [] : [call.approveAll(erc1155, ex)];
}

// ------------------------------------------------------------ orders
export const SLIPPAGE = 0.03;

/**
 * Quote a market order from the book. BUY: amount in USD; SELL: amount in shares.
 * -> { shares, usd, avg, worst, limitPrice (protected price sent with the order), complete }
 */
export function quoteMarket(book, side, amount, slippage = SLIPPAGE) {
  const w = walkBook(side === 'BUY' ? book.asks : book.bids, side, amount);
  if (!w.worst) return { ...w, limitPrice: null };
  const limitPrice = side === 'BUY' ? snap(Math.min(w.worst * (1 + slippage), 1), book.tick, true) : snap(w.worst * (1 - slippage), book.tick, false);
  return { ...w, limitPrice };
}

/**
 * Place an order. o: { tokenId, side, kind: 'market' | 'limit', amount (BUY market: USD; others: shares),
 * price (limit, or the protected price of a market order), expiration (s, limit GTD), book }.
 * onStep(name) reports progress: 'auth' | 'approve' | 'sign' | 'send'.
 */
export async function placeOrder(acc, o, password, onStep = () => {}) {
  if (acc.mode === 'readonly') throw err(acc.reason);
  const { tokenId, side, book } = o;
  const amounts = o.kind === 'limit'
    ? limitAmounts({ side, price: o.price, size: o.amount, tick: book.tick })
    : marketAmounts({ side, amount: o.amount, price: o.price, tick: book.tick });
  if (amounts.makerAmount <= 0n || amounts.takerAmount <= 0n) throw err('predict.err.tooSmall');

  onStep('auth');
  await ensureCreds(acc, password);
  const missing = await orderApprovals(acc, { tokenId, side, negRisk: book.negRisk, makerAmount: amounts.makerAmount });
  if (missing.length) {
    onStep('approve');
    await execCalls(acc, missing, password, t('predict.tx.approve'));
    // let the CLOB re-read the new allowance
    const assetType = side === 'BUY' ? 'COLLATERAL' : isV3Token(tokenId) ? 'CONDITIONAL-V2' : 'CONDITIONAL';
    await l2(acc, 'GET', '/balance-allowance/update', { query: { asset_type: assetType, ...(side === 'SELL' ? { token_id: tokenId } : {}), signature_type: String(acc.sigType) } }).catch(() => {});
  }

  onStep('sign');
  const expiration = o.kind === 'limit' && o.expiration ? o.expiration : 0;
  // Deposit Wallet: the wallet is both maker and signer (it validates the owner's signature itself)
  const order = buildOrder({ tokenId, side, ...amounts, maker: acc.wallet, signer: acc.mode === 'deposit' ? acc.wallet : acc.signer, signatureType: acc.sigType, negRisk: book.negRisk, expiration });
  const signature = await bg('polySign', { from: acc.signer, typed: order.typed, password });

  onStep('send');
  const c = creds.get(lc(acc.signer));
  let r;
  try {
    r = await l2(acc, 'POST', '/order', {
      json: { deferExec: false, order: order.wire(signature), owner: c.apiKey, orderType: o.kind === 'limit' ? (expiration ? 'GTD' : 'GTC') : 'FAK' },
    });
  } catch (e) { throw notAllowed(e.message) ? err('predict.err.eoaNotAllowed') : e; }
  if (r && r.success === false) throw notAllowed(r.errorMsg) ? err('predict.err.eoaNotAllowed') : new Error(r.errorMsg || t('predict.err.rejected'));
  return { id: r?.orderID || r?.orderId, status: r?.status, making: Number(r?.makingAmount || 0), taking: Number(r?.takingAmount || 0) };
}

/** Polymarket accepts orders straight from an address only if it is allowlisted: the others need a Deposit Wallet. */
const notAllowed = (m) => /maker address not allowed|deposit wallet flow/i.test(String(m || ''));

export async function openOrders(acc) {
  const r = await l2(acc, 'GET', '/data/orders');
  const rows = Array.isArray(r) ? r : r?.data || [];
  return rows.map((o) => ({
    id: o.id, tokenId: o.asset_id, side: o.side, price: Number(o.price), size: Number(o.original_size), filled: Number(o.size_matched || 0),
    outcome: o.outcome || '', market: o.market, created: Number(o.created_at || 0) * 1000, expiration: Number(o.expiration || 0) * 1000,
  }));
}
export const cancelOrder = (acc, id) => l2(acc, 'DELETE', '/order', { json: { orderID: id } });

// ------------------------------------------------------------ cash in / out, redeem
/**
 * USDC or USDC.e on the address -> pUSD on the trading wallet; pUSD already on the address is simply moved there.
 * Always sent from the address (it holds the funds): no Safe / relayer call needed.
 */
export async function deposit(acc, asset, amount, password) {
  if (lc(asset) === lc(C.pusd)) {
    if (lc(acc.wallet) === lc(acc.signer)) throw err('predict.cash.alreadyThere');
    return sendCalls({ ...acc, mode: 'eoa' }, [call.transfer(C.pusd, acc.wallet, amount)], password, t('predict.tx.deposit'));
  }
  const calls = [];
  if ((await allowance(asset, acc.signer, C.onramp)) < amount) calls.push(call.approve(asset, C.onramp, amount));
  calls.push(call.wrap(asset, acc.wallet, amount));
  // always from the address itself (it holds the USDC)
  return sendCalls({ ...acc, mode: 'eoa' }, calls, password, t('predict.tx.deposit'));
}
/** pUSD on the trading wallet -> USDC on the address. */
export async function withdraw(acc, amount, password) {
  const calls = [];
  if ((await allowance(C.pusd, acc.wallet, C.offramp)) < amount) calls.push(call.approve(C.pusd, C.offramp, amount));
  calls.push(call.unwrap(C.usdc, acc.signer, amount));
  return execCalls(acc, calls, password, t('predict.tx.withdraw'));
}
/** Redeem a resolved position (pays pUSD into the trading wallet). */
export const redeem = (acc, pos, password) => redeemMany(acc, [pos], password);

/**
 * Redeem several resolved positions at once. Deposit Wallet and Safe accounts send them in one transaction;
 * a plain address sends them one after the other, under the same authorization. Each approval is added once,
 * before the first redemption that needs it; a CTF condition is redeemed once (it pays both outcomes).
 */
export async function redeemMany(acc, list, password) {
  const calls = [], approvals = new Set(), done = new Set();
  let redeems = 0;
  const approve = async (contract, operator) => {
    const k = `${contract}>${operator}`;
    if (approvals.has(k)) return;
    approvals.add(k);
    if (!(await approvedAll(contract, acc.wallet, operator))) calls.push(call.approveAll(contract, operator));
  };
  for (const pos of list) {
    if (isV3Token(pos.token)) {
      if (done.has(pos.token)) continue;
      done.add(pos.token);
      const amount = await shareBalance(acc, pos.token);
      if (!amount) continue;
      await approve(C.positionManager, C.router);
      calls.push(call.redeemV3(pos.token, amount));
    } else {
      const k = `${pos.conditionId}:${!!pos.negRisk}`;
      if (done.has(k)) continue;
      done.add(k);
      await approve(C.ctf, pos.negRisk ? C.negRiskCollateralAdapter : C.collateralAdapter);
      calls.push(call.redeemCtf(pos.conditionId, pos.negRisk));
    }
    redeems++;
  }
  if (!redeems) throw err('predict.err.nothingToRedeem');
  return execCalls(acc, calls, password, redeems > 1 ? t('predict.tx.redeemMany', { n: redeems }) : t('predict.tx.redeem'));
}
