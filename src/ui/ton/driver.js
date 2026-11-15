// TON driver (Android app): the wallet screens' interface for TON (src/ui/chains/driver.d.md) - balances and history
// in the same shapes the EVM code produces, TON addresses, sends with a comment, Omniston swaps, Relay / Symbiosis
// bridges. Registered by src/mobile/tonPlugin.js.
import { Address } from '../../shared/ton/core.js';
import { keyPairFromSeed } from '@ton/crypto';
import { Buffer } from '../../shared/ton/buffer.js';
import {
  parseAddress, parseTonLink, tonLink, commentCell, jettonTransferCell, DEFAULT_JETTON_VALUE, walletContract, signTransfer, feeQuery, cellToBase64,
} from '../../shared/ton/core.js';
import {
  TON_CHAINS, tonAccount, tonJettons, tonHistory, gramPrice, llamaKey, stonAsset, tonAddressStatus, tonEstimateFee, tonWaitApplied, tonTxUrl,
} from '../../shared/ton/api.js';
import { bg } from '../../shared/ext.js';
import { fmtNum } from '../../shared/format.js';
import { omnistonQuotes, POPULAR_JETTONS } from '../../shared/ton/swap.js';
import { TON_ASSETS, tonBridgeQuote } from '../../shared/ton/bridge.js';
import { actionFee, showAddress } from '../../shared/ton/contracts.js';
import { t } from '../../shared/i18n.js';
import { TON_TYPES } from './labels.js';
import { NATIVE } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { approvalStep, txStep } from '../chains/evm.js';

/** One spelling for a jetton master: the user-friendly bounceable form (EQ…), as explorers and STON.fi show it. */
export const jettonId = (master, testnet = false) => {
  try { return Address.parse(master).toString({ urlSafe: true, bounceable: true, testOnly: !!testnet }); } catch { return String(master); }
};
/** Same address, any spelling (raw 0:…, EQ…, UQ…)? */
export const sameTonAddress = (a, b) => { try { return Address.parse(a).equals(Address.parse(b)); } catch { return false; } };

/**
 * A TON wallet's balances as an EVM portfolio: { native, tokens, totalUsd, updated, ... } with numbers and strings
 * only (it is cached on the device like the EVM ones). Tokens carry their jetton wallet and a DefiLlama price key.
 */
export async function loadTonPortfolio(chain, raw, { hiddenTokens = [] } = {}) {
  const [acc, jettons, price] = await Promise.all([tonAccount(chain, raw), tonJettons(chain, raw), gramPrice(chain).catch(() => null)]);
  const amount = Number(acc.balance) / 1e9;
  const hidden = new Set(hiddenTokens);
  const tokens = jettons.filter((j) => !j.scam).map((j) => ({
    address: jettonId(j.master, chain.testnet), symbol: j.symbol, name: j.name, decimals: j.decimals,
    balance: j.balance.toString(), amount: j.amount, price: j.price, usd: j.usd, icon: j.image || '',
    wallet: j.wallet, known: j.known, priceKey: chain.testnet ? null : llamaKey(j.master),
  })).filter((x) => !hidden.has(x.address));
  const nativeUsd = price != null ? amount * price : null;
  return {
    native: { balance: acc.balance.toString(), amount, price, usd: nativeUsd },
    tokens,
    totalUsd: (nativeUsd || 0) + tokens.reduce((s, x) => s + (x.usd || 0), 0),
    status: acc.status, seqno: acc.seqno,
    indexerOk: true, indexerError: '', noIndexer: false, updated: Date.now(),
  };
}

const KIND = { in: 'receive', out: 'send', swap: 'swap', other: 'contract' };

/** TON history in the EVM history's item shape (see classify in src/shared/history.js). */
export async function loadTonHistory(chain, raw, cursor) {
  const me = showAddress(raw, { testnet: chain.testnet, wallet: true });
  const r = await tonHistory(chain, raw, { limit: 30, cursor: cursor || undefined });
  const side = (x, dir, counterparty) => ({
    dir, symbol: x.symbol, decimals: x.decimals, amount: String(x.amount), icon: x.image || '', native: !!x.native,
    token: x.native ? null : x.master || null, counterparty,
  });
  const items = r.rows.map((x) => {
    const kind = KIND[x.kind];
    const out = x.kind === 'out' || x.kind === 'swap';
    const transfers = x.kind === 'swap' ? [side(x.swap.in, 'out'), side(x.swap.out, 'in')]
      : x.kind === 'in' || x.kind === 'out' ? [side(x, x.kind, x.counterparty)] : [];
    // what left the wallet in GRAM, for the fee (the gas is what the wallet spent beyond it)
    const transferred = x.kind === 'out' && x.native ? BigInt(x.amount) : x.kind === 'swap' && x.swap.in.native ? BigInt(x.swap.in.amount) : 0n;
    return {
      hash: x.txHash || x.id, time: x.time, kind, transfers, status: x.ok ? 'ok' : 'failed', spam: !!x.spam,
      from: x.kind === 'in' ? x.counterparty : me, to: x.kind === 'out' ? x.counterparty : x.kind === 'in' ? me : null,
      counterparty: x.kind === 'swap' ? null : x.counterparty, sentByMe: out || x.kind === 'other', comment: x.comment || null,
      via: x.kind === 'swap' ? x.counterparty : null,
      label: x.kind === 'other' ? t(`ton.hist.type.${TON_TYPES.has(x.type) ? x.type : 'other'}`) : null,
      fee: null,
      // the fee is read from the whole trace of the action (jetton wallets' gas included): only when it is opened
      loadFee: x.kind === 'in' || !x.traceId ? null
        : () => actionFee(chain, x.traceId, raw, transferred).then((f) => (f?.fee != null ? String(f.fee) : null)),
    };
  });
  return { items, next: r.cursor, error: null, unsupported: false };
}


// ------------------------------------------------------------ send (the shared Send screen, TON part)

const DUMMY = keyPairFromSeed(Buffer.alloc(32, 7)); // fee estimates don't check signatures: never a real key there
const gram = (raw) => Number(raw) / 1e9;

/**
 * A recipient typed or scanned: { ok, display (UQ…/EQ… as typed), toSelf, otherNet } — otherNet: a testnet address
 * on mainnet or the other way round.
 */
export function checkRecipient(chain, text, ownRaw) {
  const d = parseAddress(text);
  if (!d) return { ok: false };
  let toSelf = false;
  try { toSelf = d.address.equals(Address.parse(ownRaw)); } catch { /* no own address yet */ }
  return { ok: true, toSelf, otherNet: !d.raw && d.testOnly !== !!chain.testnet };
}

/** A scanned QR: { address, amountRaw (GRAM), comment } or null. */
export function parseQr(text) {
  const l = parseTonLink(text);
  if (l) return { address: l.address, amountRaw: l.amount ?? null, comment: l.text || '' };
  return parseAddress(text) ? { address: String(text).trim(), amountRaw: null, comment: '' } : null;
}

/**
 * Builds the messages and estimates the fee. token: the shared token (native, or a jetton with its jetton wallet);
 * portfolio: the wallet's portfolio (status, seqno, native balance). Max on GRAM sends everything (fees taken from it).
 * Returns { messages, sendAll, fee (nanoGRAM | null), receive (what the recipient gets), problem, notes: [i18n text] }.
 */
export async function prepareSend(chain, { wallet, portfolio, token, to, amountRaw, isMax, comment }) {
  const dest = parseAddress(to);
  const me = Address.parse(wallet.raw);
  const native = !!token.native;
  const gramBalance = BigInt(portfolio.native.balance || 0);
  const destStatus = await tonAddressStatus(chain, dest.address.toString()).catch(() => 'unknown');
  const text = (comment || '').trim();
  const raw = native && isMax ? gramBalance : amountRaw;
  const messages = native
    // a wallet not deployed yet can't bounce funds back: send them without bounce (as every wallet does)
    ? [{ to: dest.address, value: raw, bounce: destStatus === 'active' && dest.bounceable, body: text ? commentCell(text) : null }]
    : [{ to: Address.parse(token.wallet), value: DEFAULT_JETTON_VALUE, bounce: true, body: jettonTransferCell({ amount: raw, to: dest.address, responseTo: me, comment: text || undefined }) }];
  const sendAll = native && isMax;
  const contract = walletContract(Buffer.from(wallet.publicKey, 'hex'), { version: wallet.version, testnet: !!chain.testnet });
  const deployed = portfolio.status === 'active';
  const { body } = signTransfer({ wallet: contract, secretKey: DUMMY.secretKey, seqno: deployed ? portfolio.seqno : 0, deployed, messages, sendAll });
  const fee = await tonEstimateFee(chain, feeQuery(contract, body, deployed)).catch(() => null);
  const margin = fee != null ? fee + fee / 10n : null; // the estimate can be a little short
  const sym = chain.native.symbol;
  let problem = '';
  if (native && !sendAll && margin != null && raw + margin > gramBalance) problem = t('ton.send.noFee', { symbol: sym });
  if (!native && margin != null && DEFAULT_JETTON_VALUE + margin > gramBalance) problem = t('ton.send.needGram', { amount: fmtNum(gram(DEFAULT_JETTON_VALUE + margin), 3), symbol: sym });
  if (sendAll && fee != null && fee >= gramBalance) problem = t('ton.send.noFee', { symbol: sym });
  const notes = [
    !native && t('ton.send.jettonFee', { amount: fmtNum(gram(DEFAULT_JETTON_VALUE)), symbol: sym }),
    sendAll && t('ton.send.allNote'),
    !deployed && t('ton.send.firstSend'),
    native && destStatus !== 'active' && t('ton.send.newRecipient'),
  ].filter(Boolean);
  return { messages, sendAll, fee, receive: sendAll && fee != null ? gramBalance - fee : raw, problem, notes, text, recipient: dest.address.toString({ urlSafe: true, bounceable: false, testOnly: !!chain.testnet }) };
}

/** Signs and sends (password checked by the background). Returns { wait: Promise<{ txHash }> } - the confirmation. */
export async function confirmSend(chain, { review, from, authorize, title }) {
  const messages = review.messages.map((m) => ({ to: m.to.toString(), value: String(m.value), bounce: m.bounce, body: m.body ? cellToBase64(m.body) : null }));
  const r = await authorize((password) => bg('tonSend', { from, chainId: chain.id, messages, sendAll: review.sendAll, password }), title);
  return { wait: tonWaitApplied(chain, r.wallet, r.seqno, { hash: r.hash }) };
}

export const txUrl = tonTxUrl;

// ------------------------------------------------------------ swap (the shared Swap screen, TON part)

/** GRAM kept for the swap's gas when swapping GRAM with Max. */
export const SWAP_GAS_RESERVE = 150_000_000n;

/** Well-known jettons to swap to, as shared tokens (STON.fi's data): [{ address, symbol, decimals, icon, price }]. */
export async function swapTokens() {
  const list = await Promise.all(POPULAR_JETTONS.map(async (m) => {
    const a = await stonAsset(Address.parse(m).toRawString()).catch(() => null);
    return a?.known ? { address: jettonId(m), symbol: a.symbol, name: a.name || a.symbol, decimals: a.decimals ?? 9, icon: a.image || '', price: a.price ?? null, balance: '0', amount: 0 } : null;
  }));
  return list.filter(Boolean);
}

/**
 * Live quotes (Omniston: STON.fi, DeDust, Tonco...). from / to: shared tokens. onQuote gets a quote in the shared
 * shape: { provider, amountOut, minOut, gasRaw (nanoGRAM, the unused part comes back), impactPct, rawQuote }.
 * Returns { stop(), build(quote, traderAddress) }.
 */
export function swapQuotes({ from, to, amountRaw, slippageBps }, { onQuote, onNone, onError }) {
  return omnistonQuotes({ from: from.native ? null : from.address, to: to.native ? null : to.address, units: amountRaw, slippagePips: slippageBps * 100 }, {
    onQuote: (q) => onQuote({
      provider: q.protocols.join(' · ') || q.resolver || 'Omniston', amountOut: BigInt(q.outputUnits), minOut: BigInt(q.minOutput),
      gasRaw: BigInt(q.gasBudget || 0), impactPct: q.impactPips != null ? -q.impactPips / 10000 : null, rawQuote: q,
    }),
    onNone, onError,
  });
}

/** Builds the swap's messages, checks the GRAM for gas, signs and sends. Returns { wait: Promise<{ txHash }> }. */
export async function swapSend(chain, { session, quote, wallet, gramBalance, from, authorize, title }) {
  let messages;
  try { messages = await session.build(quote.rawQuote, wallet.address); } catch (e) {
    throw e.info?.reason === 'QUOTE_VALIDATION_FAILED' ? new Error(t('ton.swap.buildFailed')) : e;
  }
  const need = messages.reduce((s, m) => s + BigInt(m.value), 0n) + 30_000_000n; // + the wallet's own fee
  if (need > BigInt(gramBalance)) throw new Error(t('ton.swap.needGram', { amount: fmtNum(gram(need), 3), symbol: chain.native.symbol }));
  const r = await authorize((password) => bg('tonSend', { from, chainId: chain.id, messages, password }), title);
  return { wait: tonWaitApplied(chain, r.wallet, r.seqno, { hash: r.hash }) };
}

// ------------------------------------------------------------ bridge (the shared Bridge screen, routes with TON on one side)

/** The TON tokens a bridge can move (GRAM through Relay, USD₮ through Symbiosis), as shared tokens. */
export const bridgeTokens = () => [
  { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', symbol: 'GRAM', name: 'Gram', decimals: 9, native: true },
  { address: jettonId(TON_ASSETS.USDT.master), symbol: TON_ASSETS.USDT.symbol, name: 'Tether USD', decimals: TON_ASSETS.USDT.decimals },
];

/**
 * One route between TON and an EVM network, in the shared quote shape (provider, amountOut, minOut, outUsd,
 * durationSec, feesUsd, ref; tx + spender when the source is EVM; exec.kind 'ton' when it is TON).
 * p: { dir: 'out' (TON -> EVM) | 'in', evmChain, evmToken, tonToken (shared), amount (raw string), evmAddress, tonAddress }
 */
export async function bridgeQuote(p) {
  const tonAsset = p.tonToken.native ? TON_ASSETS.GRAM : TON_ASSETS.USDT;
  const r = await tonBridgeQuote({ ...p, tonAsset });
  return { ...r, tool: null, tx: r.exec.kind === 'evm' ? r.exec.tx : null, spender: r.exec.kind === 'evm' ? r.exec.spender : null };
}

/** Signs a route's TON messages. Returns { hash (hex), wait: Promise<{ txHash }> }. */
export async function bridgeSendTon(chain, { exec, gramBalance, from, authorize, title }) {
  const need = exec.messages.reduce((s, m) => s + BigInt(m.value), 0n) + 30_000_000n; // + the wallet's own fee
  if (need > BigInt(gramBalance)) throw new Error(t('ton.swap.needGram', { amount: fmtNum(gram(need), 3), symbol: chain.native.symbol }));
  const r = await authorize((password) => bg('tonSend', { from, chainId: chain.id, messages: exec.messages, mode: exec.mode, password }), title);
  return { hash: Buffer.from(r.hash, 'base64').toString('hex'), wait: tonWaitApplied(chain, r.wallet, r.seqno, { hash: r.hash }) };
}

// ------------------------------------------------------------ the driver (interface: src/ui/chains/driver.d.md)

const STABLES = ['USDC', 'USDT', 'USD₮0', 'USDT0'];
const WALLET_FEE = 30_000_000n; // what the wallet itself spends on a transfer (rough; the unused part is not taken)
const fixedFee = (chain, amount, extra = {}) => ({ kind: 'fixed', amount, decimals: 9, symbol: chain.native.symbol, unknownText: t('ton.send.feeUnknown'), ...extra });

export const tonDriver = {
  kind: 'ton',
  features: { memo: true }, // a text with the transfer (exchanges ask for it on deposits)
  defaultChainId: -239, // where an account imported from another TON app lives

  // ---------------------------------------------------------------- addresses
  async resolveAddresses(chain, accounts) {
    const map = await bg('tonAccounts').catch(() => ({}));
    return Object.fromEntries(accounts.map((a) => {
      const w = map[a.address];
      const net = w && (chain.testnet ? w.testnet : w.mainnet);
      return [a.address, net ? { address: net.friendly, raw: net.raw, publicKey: w.publicKey, version: w.version } : null];
    }));
  },
  validateAddress(chain, text, own) {
    const r = checkRecipient(chain, text, own);
    if (!r.ok) return { ok: false, error: 'ton.send.badAddress' };
    return { ok: true, normalized: String(text).trim(), toSelf: r.toSelf, warnings: r.otherNet ? [{ key: chain.testnet ? 'ton.send.mainnetAddress' : 'ton.send.testnetAddress' }] : [] };
  },
  addressPlaceholder: () => 'UQ… / EQ…',
  /** ton:// link; it carries GRAM amounts only (jettons arrive at the same address). */
  paymentLink: (chain, { address, amountRaw, ask }) => tonLink(address, { amount: ask ? amountRaw : null }),
  /** ton:// links carry GRAM amounts: the amount comes with the native token. */
  parseQr(chain, text) { const q = parseQr(text); return q && { address: q.address, amountRaw: q.amountRaw, token: q.amountRaw ? NATIVE : null, memo: q.comment }; },
  receiveTokens: (chain, held) => held.filter((x) => x.native),
  receiveNote: (chain) => ({ key: chain.testnet ? 'ton.receive.noteTestnet' : 'ton.receive.note' }),
  /** The address an account imported from another TON app shows ("0:…" stored -> UQ…). */
  displayAddress: (account) => { try { return Address.parseRaw(account.address).toString({ urlSafe: true, bounceable: false }); } catch { return account.address; } },

  // ---------------------------------------------------------------- data
  loadPortfolio: (chain, raw, opts) => loadTonPortfolio(chain, raw, opts),
  loadHistory: (chain, raw, cursor) => loadTonHistory(chain, raw, cursor),
  priceKey: (chain, token) => (token.native ? chain.native.priceId : token.priceKey ?? null),
  explorerToken: (chain, address) => `${chain.explorer}/jetton/${address}`,
  tokenWarning: (chain, token) => (!token.native && token.known === false ? 'ton.token.unknown' : null),
  /** A wallet contract is deployed with its first outgoing transfer. */
  homeNotice: (chain, p) => (p?.status && p.status !== 'active' && BigInt(p.native?.balance || 0) > 0n ? 'ton.notDeployed' : null),

  // ---------------------------------------------------------------- send
  async prepareSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio }) {
    const r = await prepareSend(chain, { wallet, portfolio, token, to, amountRaw, isMax, comment: memo });
    return {
      recipient: r.recipient, notes: r.notes,
      rows: r.text ? [{ k: t('send.memo'), v: `“${r.text}”` }] : [],
      amount: () => r.receive, problem: () => r.problem || null,
      fee: fixedFee(chain, r.fee),
      _ton: r,
    };
  },
  confirmSend: (chain, review, { account, authorize }) => confirmSend(chain, { review: review._ton, from: account.address, authorize, title: t('send.confirmTitle') }),

  // ---------------------------------------------------------------- swap (Omniston: STON.fi, DeDust, Tonco...)
  swapSupported: (chain) => !!chain.swap,
  swapNote: () => t('ton.swap.note'), // where the prices come from
  swapNoQuotes: (errors) => t(errors.length ? 'ton.swap.unreachable' : 'ton.swap.noRoute'),
  swapTokens: () => swapTokens(),
  swapMax: (chain, token, balance) => (token.native ? (balance > SWAP_GAS_RESERVE ? balance - SWAP_GAS_RESERVE : 0n) : balance),
  /** Live quotes: the best route keeps updating while the screen is open. */
  swapQuotes(chain, { from, to, amountRaw, slippageBps, nativePrice }, { onQuotes, onError }) {
    const ctx = { nativePrice, priceIn: from.price ?? null, priceOut: to.price ?? null };
    const session = swapQuotes({ from, to, amountRaw, slippageBps }, {
      onQuote: (x) => {
        const outUsd = to.price != null ? (Number(x.amountOut) / 10 ** to.decimals) * to.price : null;
        const gasUsd = nativePrice != null ? gram(x.gasRaw) * nativePrice : null;
        onQuotes({ ctx, errors: [], quotes: [{ ...x, outUsd, gasUsd, gasCostWei: x.gasRaw, netUsd: outUsd != null && gasUsd != null ? outUsd - gasUsd : null, _session: session }] });
      },
      onNone: () => onQuotes({ ctx, quotes: [], errors: [] }),
      onError: (m) => onError(m || 'Omniston'),
    });
    return session;
  },
  async swapSteps(chain, quote, { account, wallet, portfolio, title }) {
    return [{
      key: 'swap', title: t('swap.confirmTitle'),
      prepare: async () => ({ fee: fixedFee(chain, quote.gasRaw, { label: t('ton.swap.gas'), extraRows: [{ k: t('swap.aggFee'), v: t('swap.aggFeeValue') }] }), problem: () => null }),
      send: (review, { auth }) => swapSend(chain, { session: quote._session, quote, wallet, gramBalance: portfolio?.native.balance || '0', from: account.address, authorize: (fn) => auth(fn), title }),
    }];
  },

  // ---------------------------------------------------------------- bridge: TON <-> EVM (GRAM through Relay, USD₮ through Symbiosis)
  bridge: {
    chains: () => [TON_CHAINS[-239]],
    supports: (a, b) => (a.kind === 'ton') !== (b.kind === 'ton') && !a.testnet && !b.testnet,
    freeRecipient: false, refuel: false, // the funds go to the same account on the other side
    onlyTokens: true, // GRAM and USD₮ on TON, the native coin or a stablecoin on the EVM side
    note: (p) => ((p.fromToken.symbol === 'USD₮' || p.toToken.symbol === 'USD₮') ? t('ton.bridge.usdtNote') : null),
    tokens(chain) {
      if (chain.kind === 'ton') return bridgeTokens();
      return [{ address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals, native: true }, ...(POPULAR_TOKENS[chain.id] || []).filter((x) => STABLES.includes(x.symbol))];
    },
    reserve: async (chain, token, balance) => (chain.kind === 'ton' && token.native ? (balance > 200_000_000n ? balance - 200_000_000n : 0n) : balance),
    async quotes(p) {
      const out = p.fromChain.kind === 'ton';
      const evm = out ? p.toAddr : p.fromAddr, ton = out ? p.fromAddr : p.toAddr;
      try {
        const q = await bridgeQuote({ dir: out ? 'out' : 'in', evmChain: out ? p.toChain : p.fromChain, evmToken: out ? p.toToken : p.fromToken, tonToken: out ? p.fromToken : p.toToken, amount: p.amount, evmAddress: evm.raw, tonAddress: ton.address });
        return { quotes: [q], errors: [] };
      } catch (e) { return { quotes: [], errors: [{ provider: (out ? p.fromToken : p.toToken).native ? 'Relay' : 'Symbiosis', error: e.message }] }; }
    },
    async steps(quote, p) {
      if (quote.exec.kind === 'ton') { // out of TON: the route's messages, signed like a send
        return [{
          key: 'bridge', title: t('bridge.confirm'),
          prepare: async () => ({ fee: fixedFee(p.fromChain, WALLET_FEE), problem: () => null }),
          send: (review, { auth }) => bridgeSendTon(p.fromChain, { exec: quote.exec, gramBalance: p.portfolio?.native.balance || '0', from: p.account.address, authorize: (fn) => auth(fn), title: p.title }),
        }];
      }
      // into TON: an EVM transaction, after an approval of the exact amount when the source is a token
      const from = p.fromAddr.raw;
      const approve = await approvalStep({ chain: p.fromChain, from, token: p.fromToken, spender: quote.spender, amount: BigInt(p.amount), provider: quote.provider });
      return [approve, txStep({
        key: 'bridge', title: t('bridge.confirm'), chain: p.fromChain, from, sentTitle: p.title,
        build: async () => (approve ? (await this.quotes(p)).quotes[0]?.tx : quote.tx), // quotes expire
        valueWei: p.fromToken.native ? BigInt(p.amount) : 0n,
      })].filter(Boolean);
    },
  },
};
