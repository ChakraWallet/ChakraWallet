// Swaps on Tron through SUN.io's Smart Router: its route service compares SunSwap V1, V2, V3, PSM and SunCurve and
// returns the best paths; the swap is one call to the router contract (SmartExchangeRouter, open source:
// github.com/sun-protocol/smart-exchange-router), simulated before it is signed. A TRC-20 sold needs an approval of
// the exact amount first. Mainnet only. No fee added by Chakra.
import { Interface } from 'ethers';
import { t } from '../../shared/i18n.js';
import { fmtNum } from '../../shared/format.js';
import { getPrices } from '../../shared/prices.js';
import { toEvmAddress } from '../../shared/tron/core.js';
import { TRON_MAINNET, constantCall, chainParams, trc20Data, trc20Read } from '../../shared/tron/api.js';
import { popularOf, llamaKey } from '../../shared/tron/tokens.js';
import { resourceState, costOf, bandwidthBytes, feeLimitFor } from '../../shared/tron/fees.js';
import { encodeRawData } from '../../shared/tron/proto.js';
import { sendContract } from './tx.js';

export const SUN_ROUTER = 'TCFNp179Lg46D16zKoumd4Poa2WFFdtqYj';
const ROUTE_API = 'https://rot.endjgfsv.link/swap/router'; // SUN.io's own route service (the one sun.io uses)
const POOLS = 'PSM,CURVE,CURVE_COMBINATION,WTRX,SUNSWAP_V1,SUNSWAP_V2,SUNSWAP_V3';
const TRX = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // the router's "TRX": the zero address
const ROUTER = new Interface(['function swapExactInput(address[] path, string[] poolVersion, uint256[] versionLen, uint24[] fees, (uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline) data) payable returns (uint256[] amountsOut)']);
const SWAP_TRX_RESERVE = 40_000_000n; // TRX kept for the energy of a swap (up to ~330,000 when the account has none)
const NO_REF = { ref_block_bytes: '0000', ref_block_hash: '0000000000000000' };

const addrOf = (token) => (token.native ? TRX : token.address);

/** Routes from SUN.io's service, best first: [{ tokens, symbols, poolVersions, poolFees, amountOut (text), impact }]. */
export async function sunRoutes(from, to, amountRaw) {
  const q = new URLSearchParams({ fromToken: addrOf(from), toToken: addrOf(to), amountIn: String(amountRaw), typeList: POOLS });
  const res = await fetch(`${ROUTE_API}?${q}`, { signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.code !== 0) throw new Error(j?.message || `SUN.io ${res.status}`);
  return j.data || [];
}

/**
 * The router's arguments for a route: a version per hop, as the service gives them; versionLen = the tokens of each
 * part of the path, the first part counting the token sold (SmartExchangeRouter.swapExactInput). Calldata, no 0x.
 */
export const versionLens = (versions) => versions.map((_, i) => (i === 0 ? 2 : 1));
export function swapCalldata(route, { amountIn, minOut, to, deadline }) {
  return ROUTER.encodeFunctionData('swapExactInput', [
    route.tokens.map(toEvmAddress), route.poolVersions, versionLens(route.poolVersions), route.poolFees.map(Number),
    [BigInt(amountIn), BigInt(minOut), toEvmAddress(to), BigInt(deadline)],
  ]).slice(2);
}
const raw = (text, decimals) => {
  const [i, f = ''] = String(text).split('.');
  return BigInt(i + f.slice(0, decimals).padEnd(decimals, '0'));
};
/** "SunSwap V3 · USD1": the pools' versions, and the tokens the route goes through (wrapping TRX aside). */
const poolName = (route) => {
  const v = [...new Set(route.poolVersions.map((x) => x.toUpperCase()))].join('+');
  const mid = (route.symbols || []).slice(1, -1).filter((s) => s !== 'WTRX');
  return `SunSwap ${v}${mid.length ? ` · ${mid.join(' › ')}` : ''}`;
};

/** What a contract call costs the account now (sun), for a quote or a step: { cost, energy, feeLimit }. */
async function callCost(chain, owner, contract, energy) {
  const [res, params] = await Promise.all([resourceState(chain, owner), chainParams(chain)]);
  const draft = encodeRawData({ contract, ref: NO_REF, expiration: Date.now(), timestamp: Date.now(), fee_limit: 100_000_000 });
  const cost = costOf({ res, params, bytes: bandwidthBytes(draft), energy });
  return { cost, energy, feeLimit: feeLimitFor(energy, res, params), res };
}

export const tronSwap = {
  swapSupported: (chain) => chain.id === TRON_MAINNET,
  swapNote: () => t('tron.swap.note'),
  swapNoQuotes: () => t('tron.swap.noRoute'),
  /** Well-known tokens to swap to. */
  async swapTokens(chain) {
    const list = popularOf(chain);
    const prices = await getPrices(list.map((x) => llamaKey(x.address))).catch(() => ({}));
    return list.map((x) => ({ ...x, price: prices[llamaKey(x.address)] ?? null, balance: '0', amount: 0 }));
  },
  swapMax: (chain, token, balance) => (token.native ? (balance > SWAP_TRX_RESERVE ? balance - SWAP_TRX_RESERVE : 0n) : balance),

  /** SUN.io's best routes, renewed every 20 seconds while the screen is open. */
  swapQuotes(chain, { from, to, amountRaw, slippageBps, wallet, nativePrice }, { onQuotes, onError }) {
    const ctx = { nativePrice, priceIn: from.price ?? null, priceOut: to.price ?? null };
    let stopped = false, timer = null, energyOf = null;
    const run = async () => {
      try {
        const routes = (await sunRoutes(from, to, amountRaw)).slice(0, 3);
        if (stopped) return;
        // the energy of the best route, simulated once (a token sold needs its approval first: then a typical figure)
        if (energyOf == null && routes[0]) {
          const sim = await constantCall(chain, {
            owner: wallet.raw, contract: SUN_ROUTER, callValue: from.native ? amountRaw : 0,
            data: swapCalldata(routes[0], { amountIn: amountRaw, minOut: 1n, to: wallet.raw, deadline: Math.floor(Date.now() / 1000) + 600 }),
          }).catch(() => null);
          energyOf = sim?.ok && sim.energy ? sim.energy : 250_000;
        }
        const { cost } = await callCost(chain, wallet.raw, { type: 'TriggerSmartContract', parameter: { owner_address: wallet.raw, contract_address: SUN_ROUTER, data: '00' } }, energyOf || 250_000);
        const gasUsd = nativePrice != null ? (Number(cost.total) / 1e6) * nativePrice : null;
        const quotes = routes.map((r) => {
          const amountOut = raw(r.amountOut, to.decimals);
          const minOut = (amountOut * BigInt(10000 - slippageBps)) / 10000n;
          const outUsd = to.price != null ? (Number(amountOut) / 10 ** to.decimals) * to.price : null;
          return {
            provider: poolName(r), amountOut, minOut, outUsd, gasUsd, gasCostWei: cost.total, netUsd: outUsd != null && gasUsd != null ? outUsd - gasUsd : null,
            impactPct: r.impact != null ? -Math.abs(Number(r.impact) * 100) : null, _route: r, _energy: energyOf,
          };
        }).sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
        onQuotes({ ctx, errors: [], quotes });
      } catch (e) {
        if (!stopped) onError(e.message || 'SUN.io');
      }
      if (!stopped) timer = setTimeout(run, 20000);
    };
    run();
    return { stop() { stopped = true; clearTimeout(timer); } };
  },

  /** An approval of the exact amount when a token is sold (and the router may not take it yet), then the swap. */
  async swapSteps(chain, quote, { from, amountRaw, account, wallet, portfolio, title }) {
    const me = wallet.raw;
    const amountIn = BigInt(amountRaw);
    const trx = BigInt(portfolio?.native?.balance || 0);
    const steps = [];
    if (!from.native) {
      const allowance = await trc20Read(chain, from.address, 'allowance', [me, SUN_ROUTER], me).catch(() => 0n);
      if ((allowance ?? 0n) < amountIn) {
        const contract = { type: 'TriggerSmartContract', parameter: { owner_address: me, contract_address: from.address, data: trc20Data('approve', [SUN_ROUTER, amountIn]) } };
        let c;
        steps.push({
          key: 'approve', title: t('swap.step1'), note: t('tron.swap.approveNote', { symbol: from.symbol }), waitBeforeNext: true,
          async prepare() {
            const sim = await constantCall(chain, { owner: me, contract: from.address, data: contract.parameter.data });
            c = await callCost(chain, me, contract, sim.energy || 30_000);
            const problem = !sim.ok ? t('tron.send.simFailed', { reason: sim.message }) : c.cost.total > trx ? t('tron.send.noTrxFee', { amount: `${Number(c.cost.total) / 1e6} TRX` }) : null;
            return { fee: { kind: 'fixed', amount: c.cost.total, decimals: 6, symbol: 'TRX', label: t('tron.fee.label') }, problem: () => problem };
          },
          send: (review, { auth }) => sendContract(chain, { account, contract, feeLimit: c.feeLimit, auth: (fn) => auth(fn), title }),
        });
      }
    }
    let built;
    steps.push({
      key: 'swap', title: t('swap.confirmTitle'),
      async prepare() {
        const contract = () => ({
          type: 'TriggerSmartContract',
          parameter: { owner_address: me, contract_address: SUN_ROUTER, call_value: from.native ? amountIn : 0n,
            data: swapCalldata(quote._route, { amountIn, minOut: quote.minOut, to: me, deadline: Math.floor(Date.now() / 1000) + 600 }) },
        });
        const sim = await constantCall(chain, { owner: me, contract: SUN_ROUTER, data: contract().parameter.data, callValue: from.native ? amountIn : 0 });
        // before the approval is on chain the router can't take the token yet: the swap is checked once it is
        const energy = sim.ok && sim.energy ? sim.energy : quote._energy || 250_000;
        const c = await callCost(chain, me, contract(), energy);
        built = { contract, feeLimit: c.feeLimit };
        let problem = null;
        const approved = from.native || ((await trc20Read(chain, from.address, 'allowance', [me, SUN_ROUTER], me).catch(() => 0n)) ?? 0n) >= amountIn;
        if (!sim.ok && approved) problem = t('tron.swap.simFailed', { reason: sim.message || '' });
        else if (c.cost.total + (from.native ? amountIn : 0n) > trx) problem = t('tron.send.noTrxFee', { amount: `${(Number(c.cost.total) / 1e6).toFixed(2)} TRX` });
        return {
          fee: { kind: 'fixed', amount: c.cost.total, decimals: 6, symbol: 'TRX', label: t('tron.fee.label'),
            extraRows: [{ k: t('tron.res.energy'), v: c.cost.energy.burn ? t('tron.fee.energyBurn', { need: fmtNum(energy, 0), have: fmtNum(c.cost.energy.covered, 0) }) : t('tron.fee.energyCovered', { need: fmtNum(energy, 0) }) },
              { k: t('swap.aggFee'), v: t('tron.swap.noFee') }] },
          problem: () => problem,
        };
      },
      send: (review, { auth }) => sendContract(chain, { account, contract: built.contract(), feeLimit: built.feeLimit, auth: (fn) => auth(fn), title }),
    });
    return steps;
  },
};
