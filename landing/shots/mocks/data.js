// Demo data for the landing-page screenshots. Everything here is invented: balances, transactions,
// prices and markets are plausible but not real. Accounts are matched by their position in the wallet.

export const PRICES = {
  'coingecko:ethereum': 3412.58,
  'coingecko:polygon-ecosystem-token': 0.4127,
  'coingecko:binancecoin': 612.4,
  'coingecko:avalanche-2': 31.86,
  'coingecko:xdai': 1,
  'coingecko:the-open-network': 3.12,
  'coingecko:bitcoin': 97240.15, // Bitcoin (shots: the account's coins)
  'coingecko:tron': 0.31, 'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': 1.0, // Tron (shots: the Resources page)
  // Linea: the MetaMask Card's tokens
  'linea:0x176211869ca2b568f2a7d4ee941e073a821ee1ff': 1.0001,
  'linea:0xaca92e438df0b2401ff60da7e4337b687a2435da': 0.9996,
  'linea:0x3ff47c5bf409c86533fe1f4907524d304062428d': 1.0854,
};
const USDC = 1.0001, USDT = 0.9998, DAI = 0.9999, WBTC = 97240.15, LINK = 18.42, UNI = 11.37;

// tok(address, symbol, name, decimals, amount, price)
const tok = (address, symbol, name, decimals, amount, price) => ({ address: address.toLowerCase(), symbol, name, decimals, amount, price });

/** holdings[accountIndex][chainId] = { native, tokens } */
export const HOLDINGS = [
  { // Main
    1: { native: 2.48153, tokens: [
      tok('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 'USD Coin', 6, 4820.5, USDC),
      tok('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 'Wrapped BTC', 8, 0.08421, WBTC),
      tok('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'LINK', 'Chainlink', 18, 152.3, LINK),
      tok('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 'UNI', 'Uniswap', 18, 88.04, UNI),
      tok('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI', 'Dai Stablecoin', 18, 615.2, DAI),
    ] },
    8453: { native: 0.6182, tokens: [tok('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'USD Coin', 6, 1250.75, USDC)] },
    42161: { native: 0.3517, tokens: [tok('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC', 'USD Coin', 6, 410, USDC)] },
    10: { native: 0.0941, tokens: [] },
    137: { native: 820.4, tokens: [tok('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC', 'USD Coin', 6, 312.6, USDC)] },
    59144: { native: 0.0421, tokens: [ // Linea: the MetaMask Card spends from here (CARD below)
      tok('0x176211869cA2b568f2A7D4EE941E073a821EE1ff', 'USDC', 'USD Coin', 6, 1845.2, USDC),
      tok('0xacA92E438df0B2401fF60dA7E4337B687a2435DA', 'mUSD', 'MetaMask USD', 6, 420, 0.9996),
      tok('0x3ff47c5Bf409C86533FE1f4907524d304062428D', 'EURe', 'Monerium EUR emoney', 18, 300, 1.0854),
    ] },
  },
  { // Savings
    1: { native: 5.2, tokens: [
      tok('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 'Tether USD', 6, 12000, USDT),
      tok('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 'Wrapped BTC', 8, 0.25, WBTC),
    ] },
    8453: { native: 0.12, tokens: [] },
  },
  { // DeFi
    42161: { native: 1.084, tokens: [tok('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC', 'USD Coin', 6, 2240.1, USDC)] },
    8453: { native: 0.433, tokens: [tok('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'USD Coin', 6, 980, USDC)] },
    10: { native: 0.21, tokens: [] },
  },
];

/** MetaMask Card limits (allowances to its contract on Linea) of the first account: USDC with no limit, mUSD 250. */
export const CARD = {
  '0x176211869ca2b568f2a7d4ee941e073a821ee1ff': 2199023255551n * 10n ** 6n,
  '0xaca92e438df0b2401ff60da7e4337b687a2435da': 250n * 10n ** 6n,
};

export async function accountIndex(address) {
  const accs = (await globalThis.chrome.storage.local.get('accounts')).accounts || [];
  return Math.max(0, accs.findIndex((a) => a.address.toLowerCase() === String(address).toLowerCase()));
}

// Invented counterparties (not real wallets)
export const PEERS = {
  alice: '0x7a3f19c2e4b8d05f61a92c3e7d48b1f0c5e2a9d4',
  bob: '0x3c91e5b70a2d84f6c1e9b3a57d20f8e46b1c9a72',
  shop: '0xe82d4a6f19b3c75e0a1d8f42c6b97e305a4d1f8b',
  kyber: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
  relay: '0xa5f565650890fba1824ee0f21ebbbf660a179934',
};

/**
 * The swap a site asks for in the extension's approval window (shots: extApprove; Browser extension section of the
 * landing page): 1,500 USDC to an invented swap contract, 0.4391 ETH back. Also read by capture.mjs (Node).
 */
export const DEMO_SWAP = {
  origin: 'https://swap.example', title: 'Swap',
  // its favicon: two arrows on a gradient (invented, like the site)
  icon: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset="1" stop-color="#e5487b"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M18 25h26m-7-7 7 7-7 7M46 39H20m7 7-7-7 7-7" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  router: '0x9b1f7c3e5a2d48b6e0c4f1a7d3b85e29c6a04f1d',
  usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  usdcOut: 1500n * 10n ** 6n, ethIn: 439_100_000_000_000_000n,
};
