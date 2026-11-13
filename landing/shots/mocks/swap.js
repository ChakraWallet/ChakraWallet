// Demo replacement of src/shared/swap.js: four invented quotes, ranked like the real code does.
export * from '../../../src/shared/swap.js';

const RATES = { KyberSwap: 1.0, Velora: 0.99962, OpenOcean: 0.99931, 'LI.FI': 0.99874 };
const GAS = { KyberSwap: 182000n, Velora: 171000n, OpenOcean: 205000n, 'LI.FI': 236000n };

export async function getQuotes(p) {
  await new Promise((r) => setTimeout(r, 400));
  const inFloat = Number(p.amountIn) / 10 ** p.decIn;
  const inUsd = inFloat * 3412.58; // demo: the screenshots swap ETH
  const quotes = Object.keys(RATES).map((provider) => {
    const outFloat = (inUsd / (p.priceOut || 1)) * 0.9988 * RATES[provider];
    const amountOut = BigInt(Math.round(outFloat * 10 ** Math.min(p.decOut, 6))) * 10n ** BigInt(Math.max(0, p.decOut - 6));
    const q = { provider, amountOut, gas: GAS[provider], spender: '0x0000000000000000000000000000000000000001', build: async () => ({ to: '0x0', data: '0x', value: '0' }) };
    q.outUsd = p.priceOut != null ? outFloat * p.priceOut : null;
    q.gasCostWei = q.gas * (p.gasPrice || 0n);
    q.gasUsd = p.nativePrice != null ? (Number(q.gasCostWei) / 1e18) * p.nativePrice : null;
    q.netUsd = q.outUsd != null && q.gasUsd != null ? q.outUsd - q.gasUsd : null;
    q.minOut = (q.amountOut * BigInt(10000 - p.slippageBps)) / 10000n;
    return q;
  });
  quotes.sort((a, b) => b.netUsd - a.netUsd);
  return { quotes, errors: [] };
}
