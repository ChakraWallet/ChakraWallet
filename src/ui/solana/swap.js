// Swaps on Solana through Jupiter (the aggregator of Solana's exchanges: Raydium, Orca, Meteora…): a quote, then the
// transaction Jupiter builds for it, simulated before it's signed. No key, no fee added by Chakra.
import { t } from '../../shared/i18n.js';
import { ENDPOINTS } from '../../shared/endpoints.js';
import { jupFetch } from '../../shared/solana/jupiter.js';
import { jitoAvailable, jitoTip, sendViaJito } from '../../shared/solana/jito.js';
import { local } from '../../shared/ext.js';
import { WSOL } from '../../shared/solana/tx.js';
import { fromBase64, sol } from '../../shared/solana/core.js';
import { simulate } from '../../shared/solana/api.js';
import { tokenMetas, tokenPrices, POPULAR_SPL } from '../../shared/solana/tokens.js';
import { freshen, signAndSend, simText, BASE_FEE } from './tx.js';

/** SOL kept for fees and token accounts' rent when swapping SOL with Max. */
export const SWAP_SOL_RESERVE = 10_000_000n;
const PRIORITY_MAX = 1_000_000; // lamports: the most the priority fee of a swap may cost
const mintOf = (tk) => (tk.native ? WSOL : tk.address);

async function jup(path, init) {
  const res = await jupFetch(path, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || j.message || `Jupiter ${res.status}`);
  return j;
}

/** A Jupiter quote: { inAmount, outAmount, otherAmountThreshold, priceImpactPct, routePlan, … } */
export const jupQuote = ({ from, to, amountRaw, slippageBps }) => jup(`/swap/v1/quote?${new URLSearchParams({
  inputMint: mintOf(from), outputMint: mintOf(to), amount: String(amountRaw), slippageBps: String(slippageBps), restrictIntermediateTokens: 'true',
})}`);

/**
 * The swap transaction for a quote: { bytes (unsigned, version 0), priorityFee (lamports: the priority fee, or the
 * Jito tip when protected), lastValidBlockHeight }. jitoTip: lamports for Jito's validators (MEV protection) instead
 * of a priority fee - Jupiter adds the tip to the transaction.
 */
export async function jupSwapTx(quote, user, { jitoTip = null } = {}) {
  const r = await jup('/swap/v1/swap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: jitoTip != null ? { jitoTipLamports: Number(jitoTip) } : { priorityLevelWithMaxLamports: { maxLamports: PRIORITY_MAX, priorityLevel: 'high' } },
    }),
  });
  if (!r.swapTransaction) throw new Error(t('sol.swap.buildFailed'));
  return { bytes: fromBase64(r.swapTransaction), priorityFee: BigInt(r.prioritizationFeeLamports || 0), lastValidBlockHeight: r.lastValidBlockHeight ?? null, simError: r.simulationError || null };
}

/** MEV protection on (Settings > Security, the same switch as Ethereum's) and Jito reachable for this network? */
const protectedSwaps = async (chain) => jitoAvailable(chain) && (await local.get('settings', {})).mevProtect !== false;

const routeName = (q) => {
  const labels = [...new Set((q.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean))];
  return labels.length ? `Jupiter · ${labels.slice(0, 2).join(' + ')}` : 'Jupiter';
};

export const solanaSwap = {
  swapSupported: (chain) => !!chain.swap && !!ENDPOINTS.jupiter, // a test build may switch Jupiter off
  swapNote: () => t('sol.swap.note'),
  swapNoQuotes: (errors) => t(errors.length ? 'sol.swap.unreachable' : 'sol.swap.noRoute'),
  /** Well-known tokens to swap to: [{ address, symbol, name, decimals, icon, price }]. */
  async swapTokens(chain) {
    const mints = POPULAR_SPL.map(([m]) => m);
    const metas = await tokenMetas(chain, mints).catch(() => new Map());
    const { prices } = await tokenPrices(chain, mints, metas).catch(() => ({ prices: {} }));
    return POPULAR_SPL.map(([mint, symbol, decimals]) => {
      const m = metas.get(mint);
      return { address: mint, symbol: m?.symbol || symbol, name: m?.name || symbol, decimals: m?.decimals ?? decimals, icon: m?.icon || '', price: prices[mint] ?? null, balance: '0', amount: 0, known: true };
    });
  },
  swapMax: (chain, token, balance) => (token.native ? (balance > SWAP_SOL_RESERVE ? balance - SWAP_SOL_RESERVE : 0n) : balance),

  /** One quote, renewed every 20 seconds while the screen is open (prices move fast on Solana). */
  swapQuotes(chain, { from, to, amountRaw, slippageBps, nativePrice }, { onQuotes, onError }) {
    const ctx = { nativePrice, priceIn: from.price ?? null, priceOut: to.price ?? null };
    let stopped = false, timer = null;
    const run = async () => {
      try {
        const q = await jupQuote({ from, to, amountRaw, slippageBps });
        if (stopped) return;
        const amountOut = BigInt(q.outAmount), minOut = BigInt(q.otherAmountThreshold);
        const outUsd = to.price != null ? (Number(amountOut) / 10 ** to.decimals) * to.price : null;
        const gas = BASE_FEE + 100_000n; // signature + a typical priority fee; the exact one comes with the transaction
        const gasUsd = nativePrice != null ? sol(gas) * nativePrice : null;
        onQuotes({
          ctx, errors: [], quotes: [{
            provider: routeName(q), amountOut, minOut, outUsd, gasUsd, gasCostWei: gas, netUsd: outUsd != null && gasUsd != null ? outUsd - gasUsd : null,
            impactPct: q.priceImpactPct != null ? -Math.abs(Number(q.priceImpactPct) * 100) : null, _quote: q,
          }],
        });
      } catch (e) {
        if (stopped) return;
        if (/no route|could not find any route|TOKEN_NOT_TRADABLE|COULD_NOT_FIND/i.test(e.message)) onQuotes({ ctx, quotes: [], errors: [] });
        else onError(e.message || 'Jupiter');
      }
      if (!stopped) timer = setTimeout(run, 20000);
    };
    run();
    return { stop() { stopped = true; clearTimeout(timer); } };
  },

  async swapSteps(chain, quote, { account, wallet, portfolio, title }) {
    let built = null;
    return [{
      key: 'swap', title: t('swap.confirmTitle'),
      async prepare() {
        // protected: a tip for Jito's validators instead of a priority fee, and the swap sent as a private bundle
        const mev = await protectedSwaps(chain);
        built = await jupSwapTx(quote._quote, wallet.raw, mev ? { jitoTip: await jitoTip() } : {});
        built.mev = mev;
        const fee = BASE_FEE + built.priorityFee;
        const sim = await simulate(chain, built.bytes).catch(() => null);
        const lamports = BigInt(portfolio?.native?.balance || 0);
        let problem = sim?.err ? simText(sim.err, sim.logs || []) : null;
        if (!problem && fee > lamports) problem = t('sol.err.noSolFee');
        return {
          fee: {
            kind: 'fixed', amount: fee, decimals: 9, symbol: chain.native.symbol, unknownText: t('sol.send.feeUnknown'),
            extraRows: [{ k: t('swap.aggFee'), v: t('swap.aggFeeValue') }, ...(mev ? [{ k: t('settings.mev'), v: t('sol.swap.mevOn') }] : [])],
          },
          problem: () => problem,
        };
      },
      async send(review, { auth }) {
        const { bytes, lastValidBlockHeight } = await freshen(chain, built.bytes);
        return signAndSend(chain, { account, bytes, lastValidBlockHeight, auth, title, send: built.mev ? sendViaJito : null });
      },
    }];
  },
};
