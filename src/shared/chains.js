// Built-in networks. Custom networks added by the user/dapps are stored in storage.local ("customChains").
export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const BUILTIN_CHAINS = [
  {
    id: 1, name: 'Ethereum', short: 'ETH', color: '#627EEA',
    native: { symbol: 'ETH', name: 'Ether', decimals: 18, priceId: 'coingecko:ethereum' },
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'],
    explorer: 'https://etherscan.io',
    indexer: { type: 'blockscout', url: 'https://eth.blockscout.com' },
    // eth.blockscout.com is often slow (5-10 s) or failing: Routescan (Etherscan-compatible, free, no key) is used
    // first for the history and as the fallback for token discovery
    altIndexer: { type: 'etherscan', url: 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api' },
    historyIndexer: 'alt',
    llama: 'ethereum', swap: true,
  },
  {
    id: 8453, name: 'Base', short: 'BASE', color: '#0052FF', opStack: true,
    native: { symbol: 'ETH', name: 'Ether', decimals: 18, priceId: 'coingecko:ethereum' },
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org',
    indexer: { type: 'blockscout', url: 'https://base.blockscout.com' },
    llama: 'base', swap: true,
  },
  {
    id: 42161, name: 'Arbitrum', short: 'ARB', color: '#28A0F0',
    native: { symbol: 'ETH', name: 'Ether', decimals: 18, priceId: 'coingecko:ethereum' },
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io',
    indexer: { type: 'blockscout', url: 'https://arbitrum.blockscout.com' },
    llama: 'arbitrum', swap: true,
  },
  {
    id: 10, name: 'Optimism', short: 'OP', color: '#FF0420', opStack: true,
    native: { symbol: 'ETH', name: 'Ether', decimals: 18, priceId: 'coingecko:ethereum' },
    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    explorer: 'https://optimistic.etherscan.io',
    indexer: { type: 'blockscout', url: 'https://optimism.blockscout.com' },
    llama: 'optimism', swap: true,
  },
  {
    id: 137, name: 'Polygon', short: 'POL', color: '#8247E5', minPriorityFee: 30_000_000_000n,
    native: { symbol: 'POL', name: 'Polygon', decimals: 18, priceId: 'coingecko:polygon-ecosystem-token' },
    rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    explorer: 'https://polygonscan.com',
    indexer: { type: 'blockscout', url: 'https://polygon.blockscout.com' },
    llama: 'polygon', swap: true,
  },
  {
    id: 56, name: 'BNB Chain', short: 'BNB', color: '#F0B90B',
    native: { symbol: 'BNB', name: 'BNB', decimals: 18, priceId: 'coingecko:binancecoin' },
    rpc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
    explorer: 'https://bscscan.com',
    indexer: { type: 'etherscan', url: 'https://api.etherscan.io/v2/api', needsKey: true },
    llama: 'bsc', swap: true,
  },
  {
    id: 43114, name: 'Avalanche', short: 'AVAX', color: '#E84142',
    native: { symbol: 'AVAX', name: 'Avalanche', decimals: 18, priceId: 'coingecko:avalanche-2' },
    rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    explorer: 'https://snowtrace.io',
    indexer: { type: 'etherscan', url: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api' },
    llama: 'avax', swap: true,
  },
  {
    id: 100, name: 'Gnosis', short: 'GNO', color: '#3E6957',
    native: { symbol: 'xDAI', name: 'xDAI', decimals: 18, priceId: 'coingecko:xdai' },
    rpc: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'],
    explorer: 'https://gnosisscan.io',
    indexer: { type: 'blockscout', url: 'https://gnosis.blockscout.com' },
    llama: 'xdai', swap: true,
  },
  {
    // Linea (Consensys): the network of the MetaMask Card. No free keyless indexer: Etherscan V2 (its free key
    // covers Linea) for the history and token discovery; without a key, the balances of the well-known tokens
    id: 59144, name: 'Linea', short: 'LINEA', color: '#61DFFF',
    native: { symbol: 'ETH', name: 'Ether', decimals: 18, priceId: 'coingecko:ethereum' },
    rpc: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'],
    explorer: 'https://lineascan.build',
    indexer: { type: 'etherscan', url: 'https://api.etherscan.io/v2/api', needsKey: true },
    llama: 'linea', swap: true,
  },
  {
    id: 11155111, name: 'Sepolia (test)', short: 'SEP', color: '#9CA3AF', testnet: true,
    native: { symbol: 'ETH', name: 'Sepolia Ether', decimals: 18, priceId: null },
    rpc: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
    explorer: 'https://sepolia.etherscan.io',
    indexer: { type: 'blockscout', url: 'https://eth-sepolia.blockscout.com' },
    llama: null, swap: false,
  },
];

// Non-EVM networks added by the Android app (TON: src/mobile/tonPlugin.js). They have kind: 'ton'; code that works
// only on EVM networks iterates BUILTIN_CHAINS, or checks kind.
const EXTRA = [];
export function registerChains(list) { for (const c of list) if (!EXTRA.some((x) => x.id === c.id)) EXTRA.push(c); }
export const isEvm = (c) => !!c && (!c.kind || c.kind === 'evm'); // other families (TON...) have a kind of their own

/** Every network, in list order: Ethereum, then TON (Android app), the other networks, test networks, custom ones. */
export function allChains(customChains = []) {
  return [BUILTIN_CHAINS[0], ...EXTRA.filter((c) => !c.testnet), ...BUILTIN_CHAINS.slice(1), ...EXTRA.filter((c) => c.testnet), ...customChains.map(normalizeCustom)];
}
/** Built-in networks of this platform in list order (no custom ones): what Settings and onboarding list. */
export const builtinNetworks = () => allChains([]);

/** Networks that can't be switched off: Ethereum, and TON in the Android app. */
export const ALWAYS_ON = new Set([1, -239]);
/** Networks switched off in Settings (settings.disabledChains). */
export const isChainEnabled = (id, settings) => ALWAYS_ON.has(Number(id)) || !(settings?.disabledChains || []).includes(Number(id));

export function getChain(chainId, customChains = []) {
  return allChains(customChains).find((c) => c.id === Number(chainId));
}

export function normalizeCustom(c) {
  return {
    color: '#64748B', indexer: null, llama: null, swap: false, custom: true,
    ...c,
    short: c.short || c.native?.symbol || 'NET',
  };
}

// Build a custom chain from an EIP-3085 wallet_addEthereumChain parameter
export function chainFromEip3085(p) {
  const id = Number(BigInt(p.chainId));
  return normalizeCustom({
    id,
    name: String(p.chainName || `Chain ${id}`).slice(0, 40),
    native: {
      symbol: String(p.nativeCurrency?.symbol || 'ETH').slice(0, 10),
      name: String(p.nativeCurrency?.name || 'Ether').slice(0, 30),
      decimals: Number(p.nativeCurrency?.decimals ?? 18),
      priceId: null,
    },
    rpc: (p.rpcUrls || []).filter((u) => /^https:\/\//i.test(u)).slice(0, 3),
    explorer: (p.blockExplorerUrls || [])[0]?.replace(/\/$/, '') || '',
  });
}

export const toHex = (n) => '0x' + BigInt(n).toString(16);
