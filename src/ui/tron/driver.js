// Tron driver (Android app): the wallet screens' interface for Tron (src/ui/chains/driver.d.md) - balances and history
// in the shapes the EVM code produces, payment links, sends of TRX, TRC-20 and TRC-10 tokens with what they cost in
// energy, bandwidth and burnt TRX, custom tokens, address-poisoning checks. Registered by src/mobile/tronPlugin.js.
import { bg } from '../../shared/ext.js';
import { t, i18nError } from '../../shared/i18n.js';
import { NATIVE } from '../../shared/chains.js';
import { fmtNum } from '../../shared/format.js';
import { rememberRecipient, prefixLen, suffixLen } from '../../shared/poison.js';
import { isAddress } from '../../shared/tron/core.js';
import { encodeRawData } from '../../shared/tron/proto.js';
import { getAccount, accountExists, chainParams, constantCall, trc20Data, trc20Read, tronTokenUrl } from '../../shared/tron/api.js';
import { loadTronPortfolio, tronTokenInfo } from '../../shared/tron/tokens.js';
import { loadTronHistory } from '../../shared/tron/history.js';
import { loadTronNfts } from '../../shared/tron/nfts.js';
import { resourceState, costOf, bandwidthBytes, feeLimitFor } from '../../shared/tron/fees.js';
import { sendContract } from './tx.js';

// ------------------------------------------------------------ addresses, links
/** Address poisoning on Tron: base58 text (case matters); scammers copy the first characters after the T and the last ones. */
export const tronPoisonKit = () => ({
  canonical: (a) => { const s = String(a || '').trim(); return isAddress(s) ? s : null; },
  display: (a) => a,
  lookalike: (a, b) => a !== b && prefixLen(a, b) >= 5 && suffixLen(a, b) >= 4,
  store: 'tronRecipients',
});

export function rawToDecimal(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
export function decimalToRaw(text, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text || '').trim());
  if (!m || (m[2] || '').length > decimals) return null;
  return BigInt(m[1] + (m[2] || '').padEnd(decimals, '0'));
}

/** A payment link (tron:<address>?amount=1.5&token=<contract>), or a bare address -> { address, amount, token } | null. */
export function parseTronLink(text) {
  const s = String(text || '').trim();
  if (isAddress(s)) return { address: s, amount: null, token: null };
  const m = /^tron:(T[1-9A-HJ-NP-Za-km-z]{33})(\?.*)?$/i.exec(s);
  if (!m || !isAddress(m[1])) return null;
  const q = new URLSearchParams((m[2] || '').slice(1));
  const amount = q.get('amount'), token = q.get('token') || q.get('contract');
  if (token && !isAddress(token) && !/^\d{7}$/.test(token)) return null;
  return { address: m[1], amount: amount && /^\d+(\.\d+)?$/.test(amount) ? amount : null, token: token || null };
}

// ------------------------------------------------------------ send
const NO_REF = { ref_block_bytes: '0000', ref_block_hash: '0000000000000000' }; // a draft: only its size counts
const trxText = (sun) => `${fmtNum(Number(sun) / 1e6, 6)} TRX`;
const int = (n) => fmtNum(Math.round(n), 0);

/** The transfer and what it costs: { contract, feeLimit, amount, cost, notes, problem, recipient, text, energyRows }. */
export async function prepareTronSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio }) {
  const me = wallet.raw;
  const text = String(memo || '').trim();
  const [res, params, dest] = await Promise.all([resourceState(chain, me), chainParams(chain), getAccount(chain, to).catch(() => null)]);
  const destExists = accountExists(dest) && Object.keys(dest || {}).length > 0;
  const sun = BigInt(portfolio?.native?.balance || 0);
  const notes = [];
  let problem = null, energy = 0, contract, feeLimit = 0, createsAccount = false;
  let amount = BigInt(amountRaw ?? 0);
  if (!res.activated) problem = t('tron.send.notActivated');
  if (dest?.type === 'Contract' && token.native) notes.push(t('tron.send.toContract'));
  if (token.native) {
    createsAccount = !destExists;
    contract = { type: 'TransferContract', parameter: { owner_address: me, to_address: to, amount: isMax ? 1 : amount } };
  } else if (token.trc10) {
    createsAccount = !destExists;
    contract = { type: 'TransferAssetContract', parameter: { asset_name: String(token.address), owner_address: me, to_address: to, amount } };
  } else {
    const data = trc20Data('transfer', [to, amount]);
    const sim = await constantCall(chain, { owner: me, contract: token.address, data });
    energy = sim.energy || 0;
    if (!sim.ok && res.activated) problem = sim.message ? t('tron.send.simFailed', { reason: sim.message }) : t('tron.send.simFailedNoReason');
    if (!energy) energy = 130_000; // the estimate failed: a transfer to a new holder, the costliest case
    feeLimit = feeLimitFor(energy, res, params);
    contract = { type: 'TriggerSmartContract', parameter: { owner_address: me, contract_address: token.address, data } };
    const held = await trc20Read(chain, token.address, 'balanceOf', [to], me).catch(() => null);
    if (held === 0n) notes.push(t('tron.send.newHolder', { symbol: token.symbol }));
    if (!destExists) notes.push(t('tron.send.inactiveRecipient'));
  }
  if (createsAccount) notes.push(t('tron.send.activates', { amount: trxText(Number(params.getCreateNewAccountFeeInSystemContract ?? 1e6) + (res.bandwidth.staked.available ? 0 : Number(params.getCreateAccountFee ?? 1e5))) }));
  if (text) notes.push(t('tron.send.memoFee', { amount: trxText(params.getMemoFee ?? 1e6) }));
  const draft = encodeRawData({ contract, ref: NO_REF, expiration: Date.now() + 120_000, timestamp: Date.now(), fee_limit: feeLimit, data: text });
  const cost = costOf({ res, params, bytes: bandwidthBytes(draft), energy, createsAccount, memo: !!text });
  if (token.native && isMax) {
    amount = sun > cost.total ? sun - cost.total : 0n;
    contract.parameter.amount = amount;
  }
  if (!problem) {
    const needTrx = cost.total + (token.native ? amount : 0n);
    if (needTrx > sun) problem = token.native && !isMax ? t('tron.send.noTrx', { amount: trxText(needTrx - sun) }) : t('tron.send.noTrxFee', { amount: trxText(cost.total) });
    else if (token.native && amount <= 0n) problem = t('tron.send.noTrxFee', { amount: trxText(cost.total) });
  }
  if (cost.energy.burn > 5_000_000n) notes.push(t('tron.send.saveHint'));
  // what the fee is made of: energy and bandwidth, from the account's own or paid by burning TRX
  const energyRows = [];
  if (energy) {
    energyRows.push({ k: t('tron.res.energy'), v: cost.energy.burn ? t('tron.fee.energyBurn', { need: int(energy), have: int(cost.energy.covered) }) : t('tron.fee.energyCovered', { need: int(energy) }) });
  }
  energyRows.push({ k: t('tron.res.bandwidth'), v: cost.bandwidth.from === 'burn' ? t('tron.fee.bwBurn', { bytes: int(cost.bandwidth.bytes) }) : t(cost.bandwidth.from === 'free' ? 'tron.fee.bwFree' : 'tron.fee.bwStaked', { bytes: int(cost.bandwidth.bytes) }) });
  if (cost.activation) energyRows.push({ k: t('tron.fee.activationRow'), v: trxText(cost.activation + (cost.bandwidth.from === 'burn' ? cost.bandwidth.burn : 0n)) });
  return { contract, feeLimit, amount, cost, notes, problem, recipient: to, text, energyRows, energy };
}

// ------------------------------------------------------------ the driver (interface: src/ui/chains/driver.d.md)
export const tronDriver = {
  kind: 'tron',
  features: {
    memo: true, // a note with the transfer (costs 1 TRX on Tron: the review says it)
    customTokens: true, // TRC-20 tokens by contract, TRC-10 by id
    poisonCheck: true, // recipients checked against the history (address poisoning is everywhere on Tron)
  },
  poisonKit: tronPoisonKit,
  defaultChainId: -195, // where an account imported from another Tron app lives

  // ---------------------------------------------------------------- addresses
  async resolveAddresses(chain, accounts) {
    const map = await bg('tronAccounts').catch(() => ({}));
    return Object.fromEntries(accounts.map((a) => [a.address, map[a.address] ? { address: map[a.address].address, raw: map[a.address].address } : null]));
  },
  validateAddress(chain, text, own) {
    const s = String(text || '').trim();
    if (!isAddress(s)) return { ok: false, error: /^0x[0-9a-f]{40}$/i.test(s) ? 'tron.send.evmAddress' : 'tron.send.badAddress' };
    return { ok: true, normalized: s, toSelf: s === own, warnings: [] };
  },
  addressPlaceholder: () => t('tron.send.placeholder'),
  tokenPlaceholder: () => t('tron.token.placeholder'),
  paymentLink(chain, { address, token, amountRaw, ask }) {
    if (!ask) return address;
    const q = new URLSearchParams();
    const decimals = token?.native || !token ? chain.native.decimals : token.decimals;
    if (amountRaw != null && BigInt(amountRaw) > 0n) q.set('amount', rawToDecimal(amountRaw, decimals));
    if (token && !token.native && token.address !== NATIVE) q.set('token', token.address);
    const qs = q.toString();
    return `tron:${address}${qs ? `?${qs}` : ''}`;
  },
  parseQr(chain, text) {
    const p = parseTronLink(text);
    if (!p) return null;
    return {
      address: p.address, token: p.token || (p.amount ? NATIVE : null),
      amountRaw: p.amount && !p.token ? decimalToRaw(p.amount, chain.native.decimals) : null,
      amountText: p.amount && p.token ? p.amount : null,
    };
  },
  receiveTokens: (chain, held) => held,
  receiveNote: (chain, ask) => ({ key: chain.testnet ? 'tron.receive.noteNile' : ask ? 'tron.receive.noteAsk' : 'tron.receive.note' }),
  displayAddress: (account) => account.address,

  // ---------------------------------------------------------------- data
  loadPortfolio: (chain, raw, opts) => loadTronPortfolio(chain, raw, opts),
  async loadHistory(chain, raw, cursor) {
    const r = await loadTronHistory(chain, raw, cursor);
    return { ...r, error: r.error ? (r.limited ? t('tron.err.busy') : r.error) : null, unsupported: false };
  },
  priceKey: (chain, token) => (token.native ? chain.native.priceId ?? null : token.priceKey ?? null),
  explorerToken: (chain, address) => tronTokenUrl(chain, address),
  loadNfts: (chain, raw) => loadTronNfts(chain, raw), // TRC-721, without a key (TronGrid's transfers, checked on each contract)
  explorerNft: (chain, nft) => `${chain.explorer}/token721/${nft.contract}/${nft.tokenId}`,
  tokenWarning: (chain, token) => (token.junk ? 'tron.token.junk' : !token.native && !token.known && !token.custom && !chain.testnet ? 'tron.token.unknown' : null),
  isTokenAddress: (chain, text) => isAddress(String(text || '').trim()) || /^\d{7}$/.test(String(text || '').trim()),
  async tokenInfo(chain, address) {
    const m = await tronTokenInfo(chain, address);
    if (!m) throw i18nError('tron.token.notToken');
    return m;
  },
  homeNotice: (chain, p) => (!p ? null : !p.tron?.activated ? (chain.testnet ? 'tron.nile.empty' : 'tron.notActivated') : null),

  // ---------------------------------------------------------------- send
  async prepareSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio }) {
    const r = await prepareTronSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio });
    return {
      recipient: r.recipient, notes: r.notes,
      rows: r.text ? [{ k: t('send.memo'), v: `“${r.text}”` }] : [],
      amount: () => r.amount, problem: () => r.problem || null,
      fee: { kind: 'fixed', amount: r.cost.total, decimals: 6, symbol: chain.native.symbol, label: t('tron.fee.label'), extraRows: r.energyRows },
      _tron: r,
    };
  },
  async confirmSend(chain, review, { account, authorize }) {
    const r = review._tron;
    const sent = await sendContract(chain, { account, contract: r.contract, feeLimit: r.feeLimit, memo: r.text, auth: (fn) => authorize(fn, t('send.confirmTitle')) });
    rememberRecipient(r.recipient, tronPoisonKit()).catch(() => {}); // a real recipient, for the poisoning check
    return sent;
  },
};
