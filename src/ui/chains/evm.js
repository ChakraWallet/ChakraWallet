// EVM driver: Ethereum and every EVM network (Base, Arbitrum, Polygon, custom networks...). Interface: driver.d.md.
import { isAddress, getAddress } from 'ethers';
import { bg } from '../../shared/ext.js';
import { NATIVE, getChain } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { erc20, getTokenInfo, getAllowance, waitForReceipt } from '../../shared/rpc.js';
import { prepareTx, finalizeTx, getFeeData } from '../../shared/tx.js';
import { loadPortfolio } from '../../shared/portfolio.js';
import { loadHistory } from '../../shared/history.js';
import { loadEvmNfts } from '../../shared/nft.js';
import { getPrices, tokenPriceKey } from '../../shared/prices.js';
import { getQuotes, swapSupported } from '../../shared/swap.js';
import { BRIDGE_CHAINS, getBridgeQuotes, requote } from '../../shared/bridge.js';
import { paymentUri, parsePaymentQr } from '../../shared/eip681.js';
import { rememberRecipient } from '../../shared/poison.js';
import { t } from '../../shared/i18n.js';
import { registerDriver, isEvmAccount } from './index.js';

const lc = (a) => String(a || '').toLowerCase();
const maxB = (a, b) => (a > b ? a : b);

/** The network fee as the review screens show it: a fee market with Slow / Normal / Fast (components.jsx FeeBox). */
const marketFee = (prepared, { valueWei = () => 0n, valueUsd = null, extraRows = [] } = {}) => ({ kind: 'market', prepared, valueWei, valueUsd, extraRows });

/** An EVM transaction step (approval, swap, bridge...): prepared with its fee, sent with the wallet password. */
export function txStep({ key, title, chain, from, build, wait = false, valueWei, valueUsd, extraRows, sentTitle, info }) {
  return {
    key, title, info, waitBeforeNext: wait,
    async prepare() {
      const tx = await build();
      const prepared = await prepareTx(chain, from, tx);
      return { fee: marketFee(prepared, { valueWei: () => valueWei || 0n, valueUsd, extraRows }), problem: () => null, _prepared: prepared };
    },
    async send(review, { speed, auth }) {
      const hash = await auth((password) => bg('sendTransaction', { from, tx: finalizeTx(review._prepared, speed), title: sentTitle, password }));
      if (!wait) return { hash };
      // an approval must be mined before the next step (the swap / bridge would fail without it)
      return { hash, wait: waitForReceipt(chain, hash).then((rc) => { if (rc.status !== '0x1') throw new Error(t('swap.approvalFailed')); return { hash }; }) };
    },
  };
}
/** Approval of exactly `amount` (never unlimited) when the current allowance is lower; null when not needed. */
export async function approvalStep({ chain, from, token, spender, amount, provider }) {
  if (!spender || token.native || token.address === NATIVE) return null;
  if ((await getAllowance(chain, token.address, from, spender)) >= amount) return null;
  return txStep({
    key: 'approve', title: t('swap.step1'), chain, from, wait: true, sentTitle: t('swap.approvalTxTitle', { symbol: token.symbol }),
    build: async () => ({ to: token.address, value: '0', data: erc20.encodeFunctionData('approve', [spender, amount]) }),
    info: { provider, symbol: token.symbol, amount },
  });
}

/** The shared bridge screen's route parameters -> shared/bridge.js parameters. */
const bridgeParams = (p) => ({
  fromChain: p.fromChain, toChain: p.toChain, fromToken: p.fromToken.address, toToken: p.toToken.address, amount: p.amount,
  from: p.fromAddr.raw, to: p.toAddr.raw, slippageBps: 50, refuel: p.refuel, nativePrice: p.nativePrice,
});

export const evmDriver = {
  kind: 'evm',
  features: {
    customTokens: true, // tokens added by contract address (home: "Add a custom token")
    customNfts: true, // NFTs added by contract and token id (home: "Add an NFT")
    poisonCheck: true, // recipients checked against the history for address poisoning
    feeMarket: true, // Slow / Normal / Fast
    approvals: true, // tokens need an approval before a swap or a bridge
    dapps: true, contracts: true, predictions: true,
  },

  // ---------------------------------------------------------------- addresses
  resolveAddressesSync(chain, accounts) {
    return Object.fromEntries(accounts.map((a) => [a.address, isEvmAccount(a) ? { address: a.address, raw: a.address } : null]));
  },
  resolveAddresses(chain, accounts) { return this.resolveAddressesSync(chain, accounts); },
  validateAddress(chain, text, own) {
    const s = String(text || '').trim();
    if (!isAddress(s)) return { ok: false, error: 'send.invalidAddress' };
    const normalized = getAddress(s);
    return { ok: true, normalized, toSelf: !!own && lc(normalized) === lc(own), warnings: [] };
  },
  addressPlaceholder: () => t('send.addressPlaceholder'),
  /** EIP-681 payment link, or the bare address when nothing is asked for. */
  paymentLink(chain, { address, token, amountRaw, ask }) {
    return ask && token ? paymentUri({ address, chainId: chain.id, token: token.native ? NATIVE : token.address, amountRaw }) : address;
  },
  /** { address, chainId?, token?, amountRaw? } or null. */
  parseQr(chain, text) { return parsePaymentQr(text); },
  receiveTokens(chain, held) {
    const seen = new Set(held.map((x) => lc(x.address)));
    return [...held.filter((x) => !x.spam), ...(POPULAR_TOKENS[chain.id] || []).filter((x) => !seen.has(x.address))];
  },
  receiveNote: (chain, ask) => (ask ? { key: 'receive.askNote' } : { key: 'receive.note', network: true }),

  // ---------------------------------------------------------------- data
  loadPortfolio: (chain, raw, opts) => loadPortfolio(chain, raw, opts),
  loadHistory: (chain, raw, cursor, opts) => loadHistory(chain, raw, cursor, opts),
  tokenInfo: (chain, address) => getTokenInfo(chain, address),
  isTokenAddress: (chain, text) => /^0x[0-9a-fA-F]{40}$/.test(String(text || '').trim()),
  tokenPlaceholder: () => '0x…',
  priceKey: (chain, token) => (token.native || token.address === NATIVE ? chain.native.priceId : tokenPriceKey(chain, token.address)),
  explorerToken: (chain, address) => (chain.explorer ? `${chain.explorer}/token/${address}` : null),
  loadNfts: (chain, raw, opts) => loadEvmNfts(chain, raw, opts),
  explorerNft: (chain, nft) => (chain.explorer ? `${chain.explorer}/nft/${nft.contract}/${nft.tokenId}` : null),
  tokenWarning: () => null,
  homeNotice: () => null,

  // ---------------------------------------------------------------- send
  async prepareSend(chain, { wallet, token, to, amountRaw, isMax, portfolio }) {
    const from = wallet.raw;
    const dest = getAddress(String(to).trim());
    const native = !!token.native;
    const tx = native ? { to: dest, value: (isMax ? 0n : amountRaw).toString(), data: '0x' }
      : { to: token.address, value: '0', data: erc20.encodeFunctionData('transfer', [dest, amountRaw]) };
    const prepared = await prepareTx(chain, from, tx);
    const balance = BigInt(token.balance || 0), nativeBal = BigInt(portfolio?.native.balance || 0);
    // "max" on the native coin: the balance minus the most the network can cost at that speed
    const amount = (speed) => (native && isMax ? maxB(balance - BigInt(prepared.speeds[speed].maxCost), 0n) : amountRaw);
    return {
      recipient: dest, rows: [], notes: [],
      amount,
      fee: marketFee(prepared, { valueWei: (speed) => (native ? amount(speed) : 0n), valueUsd: !native && token.price != null ? (Number(amountRaw) / 10 ** token.decimals) * token.price : null }),
      problem: (speed) => {
        const need = BigInt(prepared.speeds[speed].maxCost) + (native ? amount(speed) : 0n);
        return need > nativeBal || (!native && amountRaw > balance) ? t('send.insufficientNative', { symbol: chain.native.symbol }) : null;
      },
      _evm: { prepared, native, isMax },
    };
  },
  async confirmSend(chain, review, { wallet, speed, authorize, title }) {
    const from = wallet.raw;
    const v = review.amount(speed);
    const p = review._evm.native && review._evm.isMax ? { ...review._evm.prepared, tx: { ...review._evm.prepared.tx, value: '0x' + v.toString(16) } } : review._evm.prepared;
    const hash = await authorize((password) => bg('sendTransaction', { from, tx: finalizeTx(p, speed), title, password }), t('send.confirmTitle'));
    rememberRecipient(review.recipient).catch(() => {});
    return { hash };
  },

  // ---------------------------------------------------------------- swap
  swapSupported: (chain) => !!chain.swap && swapSupported(chain.id),
  swapTokens: async (chain) => (POPULAR_TOKENS[chain.id] || []).map((x) => ({ ...x, amount: 0, balance: '0' })),
  /** Max that leaves room for the swap's gas: 97% of the native coin. */
  swapMax: (chain, token, balance) => (token.native ? (balance * 97n) / 100n : balance),
  /** One round of quotes from the aggregators, best net value first. */
  swapQuotes(chain, { from, to, amountRaw, slippageBps, wallet }, { onQuotes, onError }) {
    let stopped = false;
    (async () => {
      try {
        const [fee, prices] = await Promise.all([
          getFeeData(chain),
          getPrices([chain.native.priceId, tokenPriceKey(chain, from.address), tokenPriceKey(chain, to.address)]),
        ]);
        const priceOf = (x) => (x.address === NATIVE ? prices[chain.native.priceId] : prices[tokenPriceKey(chain, x.address)] ?? x.price ?? null);
        const ctx = { gasPrice: fee.speeds.normal.effective, nativePrice: prices[chain.native.priceId] ?? null, priceIn: priceOf(from), priceOut: priceOf(to) };
        const r = await getQuotes({
          chainId: chain.id, tokenIn: from.address, tokenOut: to.address, amountIn: amountRaw, decIn: from.decimals, decOut: to.decimals,
          from: wallet.raw, slippageBps, gasPrice: ctx.gasPrice, priceOut: ctx.priceOut, nativePrice: ctx.nativePrice,
        });
        if (!stopped) onQuotes({ quotes: r.quotes, errors: r.errors, ctx });
      } catch (e) { if (!stopped) onError(e.message); }
    })();
    return { stop() { stopped = true; } };
  },
  /** Approval of the exact amount (if needed), then the swap. */
  async swapSteps(chain, quote, { from, amountRaw, wallet, inUsd, title }) {
    const address = wallet.raw;
    const approve = await approvalStep({ chain, from: address, token: from, spender: quote.spender, amount: amountRaw, provider: quote.provider });
    const swap = txStep({
      key: 'swap', title: t('swap.confirmTitle'), chain, from: address, sentTitle: title,
      build: async () => {
        try { const tx = await quote.build(); return { to: tx.to, data: tx.data, value: tx.value }; } catch (e) { throw new Error(t('swap.prepareFailed', { error: e.message })); }
      },
      valueWei: from.native ? amountRaw : 0n, valueUsd: from.native ? null : inUsd,
      extraRows: [{ k: t('swap.aggFee'), v: t('swap.aggFeeValue'), sub: t('swap.aggFeeSub') }],
    });
    return [approve, swap].filter(Boolean);
  },

  // ---------------------------------------------------------------- bridge (EVM <-> EVM: LI.FI, Relay, Across, deBridge)
  bridge: {
    chains: () => BRIDGE_CHAINS.map((id) => getChain(id)).filter((c) => c && !c.kind),
    supports: (a, b) => !a.kind && !b.kind,
    freeRecipient: true, refuel: true,
    tokens: (chain) => [{ address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals, native: true }, ...(POPULAR_TOKENS[chain.id] || [])],
    reserve: async (chain, token, balance) => {
      if (!token.native) return balance;
      try { const fd = await getFeeData(chain); const s = fd.speeds.fast; return maxB(balance - 400000n * BigInt(s.maxFee ?? s.gasPrice), 0n); } catch { return balance - balance / 50n; }
    },
    quotes: (p) => getBridgeQuotes(bridgeParams(p)),
    async steps(quote, p) {
      const from = p.fromAddr.raw;
      const approve = await approvalStep({ chain: p.fromChain, from, token: p.fromToken, spender: quote.spender, amount: BigInt(p.amount), provider: quote.provider });
      let latest = null;
      const bridge = txStep({
        key: 'bridge', title: t('bridge.confirm'), chain: p.fromChain, from, sentTitle: p.title,
        // after an approval the quote may have expired: a fresh transaction (and its reference, to track the transfer)
        build: async () => { if (!approve) return quote.tx; latest = { ...quote, ...(await requote(quote.provider, bridgeParams(p))) }; return latest.tx; },
        valueWei: p.fromToken.native ? BigInt(p.amount) : 0n,
      });
      const send = bridge.send;
      return [approve, { ...bridge, send: async (...a) => ({ ...(await send(...a)), quote: latest || quote }) }].filter(Boolean);
    },
  },
};

registerDriver(evmDriver);
