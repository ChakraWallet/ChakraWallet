// Bitcoin driver: the wallet screens' interface for Bitcoin (src/ui/chains/driver.d.md). An account is a
// whole HD wallet - many addresses of two types, SegWit (bc1q…) and Taproot (bc1p…) - so its `raw` is the account's
// public side (src/shared/btc/account.js), and `address` the next receive address. Balances, coins and history over
// all its addresses; runes as tokens and inscriptions as NFTs when UniSat can be read; sends that pick coins and leave
// alone the ones that may carry inscriptions or runes; speed up / cancel (RBF) and speeding up a payment on its way in
// (CPFP). Registered by src/mobile/btcPlugin.js.
import { bg } from '../../shared/ext.js';
import { t, i18nError } from '../../shared/i18n.js';
import { NATIVE } from '../../shared/chains.js';
import { toFloat } from '../../shared/format.js';
import { getPrices } from '../../shared/prices.js';
import { rememberRecipient, prefixLen, suffixLen } from '../../shared/poison.js';
import { decodeAddress } from '../../shared/btc/keys.js';
import { addressNetwork } from '../../shared/btc/networks.js';
import { encodeAccount, decodeAccount, loadState, scanAccount, totals, receiveAddress, usedAddresses } from '../../shared/btc/account.js';
import { loadBtcHistory } from '../../shared/btc/history.js';
import { unisatReady, runeBalances, brc20Balances, inscriptionsOf, contentUrl } from '../../shared/btc/unisat.js';
import { prepareBtcSend, prepareReplacement, prepareCpfp, withPrevHex } from './plan.js';

// ------------------------------------------------------------ addresses, links
/** Bech32 addresses are case-insensitive (lower case); base58 ones (1…, 3…) aren't. */
const canonical = (a) => { const s = String(a || '').trim(); return /^(bc1|tb1)/i.test(s) ? s.toLowerCase() : s; };
/** Address poisoning: look-alikes copy the first characters after the prefix (bc1q…) and the last ones. */
export const btcPoisonKit = () => ({
  canonical: (a) => { const s = canonical(a); return addressNetwork(s) ? s : null; },
  display: (a) => a,
  lookalike: (a, b) => { const p = (x) => x.replace(/^(bc1[qp]|tb1[qp]|[13mn2])/i, ''); return a !== b && prefixLen(p(a), p(b)) >= 4 && suffixLen(a, b) >= 4; },
  store: 'btcRecipients',
});

const ownSets = new Map(); // account id -> Set of its used addresses (sends to oneself)
const rememberOwn = (a, s) => { ownSets.set(a.id, usedAddresses(s)); };

/** sats <-> decimal text */
export function satsToText(sats) {
  const s = BigInt(sats).toString().padStart(9, '0');
  const int = s.slice(0, -8), frac = s.slice(-8).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
export function textToSats(text) {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(String(text || '').trim());
  return m ? BigInt(m[1] + (m[2] || '').padEnd(8, '0')) : null;
}

/** A payment link (BIP21: bitcoin:<address>?amount=0.001&label=…), or a bare address -> { address, amount } | null. */
export function parseBip21(text, chain) {
  const s = String(text || '').trim();
  const m = /^bitcoin:([^?]+)(\?.*)?$/i.exec(s);
  const address = canonical(m ? m[1] : s);
  if (!decodeAddress(address, chain.net)) return null;
  const q = new URLSearchParams((m?.[2] || '').slice(1));
  const amount = q.get('amount');
  return { address, amount: amount && textToSats(amount) != null ? amount : null, label: q.get('label') || q.get('message') || null };
}

// ------------------------------------------------------------ portfolio
async function loadPortfolio(chain, raw, { hiddenTokens = [], full = false } = {}) {
  const a = decodeAccount(raw);
  const s = await scanAccount(chain, a, { full });
  rememberOwn(a, s);
  const { confirmed, pending } = totals(s);
  const price = chain.native.priceId ? (await getPrices([chain.native.priceId]))[chain.native.priceId] ?? null : null;
  const balance = confirmed + pending;
  const amount = toFloat(balance, 8);
  const rows = [];
  let indexerOk = true, indexerError = '';
  // runes and BRC-20 (UniSat): per address holding coins
  if (unisatReady(chain)) {
    const holders = Object.entries(s.addrs).filter(([, x]) => BigInt(x.funded) + BigInt(x.mFunded) > BigInt(x.spent) + BigInt(x.mSpent)).map(([addr]) => addr);
    const runes = new Map(), brc = new Map();
    for (const address of holders) {
      try {
        for (const r of await runeBalances(chain, address)) {
          const cur = runes.get(r.id) || { ...r, amount: 0n };
          cur.amount += r.amount;
          runes.set(r.id, cur);
        }
        if (!chain.testnet) {
          for (const b of await brc20Balances(chain, address).catch(() => [])) {
            const cur = brc.get(b.ticker) || { ticker: b.ticker, overall: 0 };
            cur.overall += Number(b.overall) || 0;
            brc.set(b.ticker, cur);
          }
        }
      } catch (e) { indexerOk = false; indexerError = e.message; }
    }
    for (const r of runes.values()) {
      if (r.amount <= 0n) continue;
      rows.push({ address: r.id, symbol: r.spaced, name: r.symbol ? `${r.symbol} · Rune` : 'Rune', decimals: r.divisibility, balance: r.amount.toString(), amount: toFloat(r.amount, r.divisibility), price: null, usd: null, icon: '', rune: true, priceKey: null });
    }
    for (const b of brc.values()) {
      if (!(b.overall > 0)) continue;
      rows.push({ address: `brc20:${b.ticker}`, symbol: b.ticker, name: 'BRC-20', decimals: 0, balance: String(Math.floor(b.overall)), amount: b.overall, price: null, usd: null, icon: '', brc20: true, priceKey: null });
    }
  }
  const hidden = new Set(hiddenTokens);
  const usd = price != null ? amount * price : null;
  return {
    native: { balance: balance.toString(), amount, price, usd },
    tokens: rows.filter((x) => !hidden.has(x.address)),
    hidden: rows.filter((x) => hidden.has(x.address)).map((x) => ({ ...x, hidden: true })),
    totalUsd: usd || 0,
    btc: { confirmed: confirmed.toString(), pending: pending.toString(), addresses: Object.keys(s.addrs).length, unisat: unisatReady(chain) },
    indexerOk, indexerError, noIndexer: !unisatReady(chain), updated: Date.now(),
  };
}

// ------------------------------------------------------------ NFTs (inscriptions)
async function loadNfts(chain, raw) {
  if (!unisatReady(chain)) return { items: [], unsupported: false, note: t('btc.ord.needKey') };
  const a = decodeAccount(raw);
  const s = await loadState(chain, a);
  const holders = Object.entries(s.addrs).filter(([, x]) => BigInt(x.funded) + BigInt(x.mFunded) > BigInt(x.spent) + BigInt(x.mSpent)).map(([addr]) => addr);
  const items = [];
  for (const address of holders) {
    for (const x of await inscriptionsOf(chain, address)) {
      if (x.brc20) continue; // BRC-20 transfer inscriptions: tokens, not pictures
      const image = /^image\//.test(x.contentType) ? contentUrl(chain, x.id) : '';
      items.push({
        key: x.id, contract: 'ordinals', tokenId: String(x.number ?? ''), name: t('btc.ord.name', { n: x.number ?? '?' }), collection: null,
        image, description: image ? '' : x.contentType, standard: 'Ordinals', amount: '1', spam: false, address, inscription: { id: x.id, contentType: x.contentType },
      });
    }
  }
  return { items, unsupported: false };
}

// ------------------------------------------------------------ the driver (interface: src/ui/chains/driver.d.md)
export const btcDriver = {
  kind: 'bitcoin',
  features: { poisonCheck: true },
  poisonKit: btcPoisonKit,
  defaultChainId: -8333, // where an account imported from another Bitcoin app lives

  // ---------------------------------------------------------------- addresses
  async resolveAddresses(chain, accounts) {
    const map = await bg('btcAccounts', { chainId: chain.id }).catch(() => ({}));
    const out = {};
    for (const acc of accounts) {
      const a = map[acc.address];
      if (!a) { out[acc.address] = null; continue; }
      const s = await loadState(chain, a);
      out[acc.address] = { address: receiveAddress(chain, a, s, 'p2wpkh').address, raw: encodeAccount(a) };
    }
    return out;
  },
  validateAddress(chain, text, own) {
    const s = canonical(text);
    if (/^0x[0-9a-f]{40}$/i.test(s)) return { ok: false, error: 'btc.send.evmAddress' };
    if (/^(lnbc|lntb|lnurl|lightning:)/i.test(s)) return { ok: false, error: 'btc.send.lightning' };
    const d = decodeAddress(s, chain.net);
    if (!d) return { ok: false, error: addressNetwork(s) && addressNetwork(s) !== (chain.testnet ? 'test' : 'main') ? (chain.testnet ? 'btc.send.mainnetAddress' : 'btc.send.testnetAddress') : 'btc.send.badAddress' };
    const mine = [...ownSets.values()].some((set) => set.has(s)) || s === own;
    const warnings = d.type === 'unknown' ? [{ key: 'btc.send.futureType' }] : [];
    return { ok: true, normalized: s, toSelf: mine, warnings };
  },
  addressPlaceholder: () => t('btc.send.placeholder'),
  paymentLink(chain, { address, amountRaw, ask }) {
    if (!ask || amountRaw == null || BigInt(amountRaw) <= 0n) return ask ? `bitcoin:${address}` : address;
    return `bitcoin:${address}?amount=${satsToText(amountRaw)}`;
  },
  parseQr(chain, text) {
    const p = parseBip21(text, chain);
    if (!p) return null;
    return { address: p.address, token: p.amount ? NATIVE : null, amountRaw: p.amount ? textToSats(p.amount) : null };
  },
  receiveTokens: (chain, held) => held.filter((x) => x.native),
  receiveNote: (chain, ask) => ({ key: chain.testnet ? 'btc.receive.noteTest' : ask ? 'btc.receive.noteAsk' : 'btc.receive.note' }),
  displayAddress: (account) => account.address,

  // ---------------------------------------------------------------- data
  loadPortfolio,
  async loadHistory(chain, raw, cursor) {
    const r = await loadBtcHistory(chain, decodeAccount(raw), cursor);
    return { ...r, unsupported: false };
  },
  priceKey: (chain, token) => (token.native ? chain.native.priceId ?? null : null),
  explorerToken: (chain, id) => (chain.testnet || String(id).startsWith('brc20:') ? null : `https://ordinals.com/rune/${id}`),
  loadNfts,
  explorerNft: (chain, nft) => (chain.testnet ? `${chain.explorer}/tx/${String(nft.key).split('i')[0]}` : `https://ordinals.com/inscription/${nft.key}`),
  tokenWarning: (chain, token) => (token.brc20 ? 'btc.brc20.readOnly' : null),
  isTokenAddress: () => false,

  // ---------------------------------------------------------------- send
  async prepareSend(chain, { wallet, token, to, amountRaw, isMax }) {
    if (token?.brc20) throw i18nError('btc.brc20.readOnly');
    const r = await prepareBtcSend(chain, { wallet, token, to, amountRaw, isMax, manual: takeManual(wallet.raw) });
    return r;
  },
  async confirmSend(chain, review, { account, speed, authorize, title }) {
    const plan = review._btc.planFor(speed);
    if (!plan) throw new Error(review.problem(speed) || t('btc.err.badPlan'));
    await withPrevHex(chain, plan);
    const r = await authorize((password) => bg('btcSend', { from: account.address, chainId: chain.id, plan, meta: { title }, password }), t('send.confirmTitle'));
    manual = null; // coins chosen by hand: for that send only
    if (review.recipient) rememberRecipient(review.recipient, btcPoisonKit()).catch(() => {});
    return { hash: r.txid };
  },

  // ---------------------------------------------------------------- speed up / cancel (RBF), CPFP
  replace: {
    options(chain, it) {
      if (it.sentByMe && it.replaceable && (it.status === 'pending' || it.status === 'dropped')) return { speedUp: true, cancel: it.status === 'pending' && it.replacement !== 'cancel' };
      if (!it.sentByMe && it.status === 'pending' && it.kind === 'receive' && it.btc?.vsize) return { speedUp: true, cancel: false }; // CPFP
      return null;
    },
    prepare(chain, it, { mode, wallet }) {
      return !it.sentByMe ? prepareCpfp(chain, it, { wallet }) : prepareReplacement(chain, it, { mode, wallet });
    },
    async confirm(chain, review, { account, speed, authorize, title }) {
      const plan = review._btc.planFor(speed);
      if (!plan) throw new Error(review.problem(speed) || t('btc.err.badPlan'));
      await withPrevHex(chain, plan);
      const r = review._btc.mode === 'cpfp'
        ? await authorize((password) => bg('btcSend', { from: account.address, chainId: chain.id, plan, meta: { mode: 'cpfp', parent: review._btc.parent, title }, password }), title)
        : await authorize((password) => bg('btcReplace', { from: account.address, chainId: chain.id, txid: review._btc.txid, mode: review._btc.mode, plan, password }), title);
      return { hash: r.txid };
    },
  },
};

// ------------------------------------------------------------ coin control: coins chosen by hand for the next send
let manual = null; // { raw, outpoints }
/** The Coins page: the next send of this account spends exactly these coins. */
export const useCoinsForNextSend = (raw, outpoints) => { manual = outpoints?.length ? { raw, outpoints } : null; };
export const manualSelection = (raw) => (manual?.raw === raw ? manual.outpoints : null);
function takeManual(raw) { return manualSelection(raw); }
