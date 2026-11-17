// The local test networks, registered like any other network (src/shared/chains.js) before the app starts: two EVM
// networks (Anvil) with a USDC-like token, a DEX known to the simulated aggregator and the simulated bridge.
import { registerChains } from '../../src/shared/chains.js';
import { POPULAR_TOKENS } from '../../src/shared/tokens.js';
import { KYBER_CHAINS } from '../../src/shared/swap.js';
import { BRIDGE_CHAINS } from '../../src/shared/bridge.js';
import { TON_CHAINS } from '../../src/shared/ton/api.js';

const S = __E2E__;
registerChains(S.evm.map((n) => ({
  id: n.id, name: n.name, short: `L${n.key.toUpperCase()}`, color: n.key === 'a' ? '#7C3AED' : '#0EA5E9',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18, priceId: 'coingecko:ethereum' },
  rpc: [n.rpc], explorer: null,
  indexer: { type: 'etherscan', url: `${S.services}/idx/${n.id}/api` },
  llama: `local${n.key}`, swap: !!n.dex,
})));
for (const n of S.evm) {
  POPULAR_TOKENS[n.id] = [{ address: n.usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6 }];
  if (n.dex) KYBER_CHAINS[n.id] = `local${n.key}`;
  if (!BRIDGE_CHAINS.includes(n.id)) BRIDGE_CHAINS.push(n.id);
}

// TON: the sandbox behind a TON Center-compatible API (e2e/env/ton.mjs). In TON_CHAINS too: the background signs for it.
if (S.ton) {
  const c = {
    id: S.ton.id, kind: 'ton', name: 'TON Local', short: 'TONL', color: '#0098EA',
    native: { symbol: 'GRAM', name: 'Gram', decimals: 9, priceId: 'coingecko:the-open-network' },
    api: S.ton.api, explorer: `${S.ton.api}/explorer`, rpc: [`${S.ton.api}/api/v3`], swap: true,
    tonapi: S.ton.api, // TonAPI's routes the app uses here (names): served by the same local API
  };
  TON_CHAINS[c.id] = c;
  registerChains([c]);
}
