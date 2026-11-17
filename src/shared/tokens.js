// Popular tokens per chain: used as suggestions in Swap and to check balances on chains without an indexer.
// Icons of the well-known tokens (same CoinGecko images the indexers return). Bound to these exact contract
// addresses: a spam token with the same symbol never gets them.
const CG = 'https://assets.coingecko.com/coins/images/';
const ICONS = {
  USDC: `${CG}6319/small/usdc.png`, USDT: `${CG}325/small/Tether.png`, DAI: `${CG}9956/small/Badge_Dai.png`,
  WBTC: `${CG}7598/small/wrapped_bitcoin_wbtc.png`, cbBTC: `${CG}40143/small/cbbtc.webp`,
  LINK: `${CG}877/small/chainlink-new-logo.png`, UNI: `${CG}12504/small/uniswap-logo.png`,
  WETH: `${CG}2518/small/weth.png`, wstETH: `${CG}18834/small/wstETH.png`, weETH: `${CG}33033/small/weETH.png`,
  // Linea and the MetaMask Card's tokens
  mUSD: `${CG}68451/small/MetaMask-mUSD-Icon-200x200.png`, EURe: `${CG}54303/small/eure.jpg`, GBPe: `${CG}39004/small/gbp.png`,
  LINEA: `${CG}68507/small/linea-logo.jpeg`,
};
const t = (address, symbol, name, decimals, icon = ICONS[symbol]) => ({ address: address.toLowerCase(), symbol, name, decimals, ...(icon ? { icon } : {}) });

// Legitimate older/bridged versions that use the same symbol as a well-known token (not fakes)
export const LEGIT_VARIANTS = new Set([
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // Polygon USDC.e
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // Arbitrum USDC.e
  '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // Optimism USDC.e
  '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664', // Avalanche USDC.e
  '0xc7198437980c041c805a1edcba50c1ce5db95118', // Avalanche USDT.e
  '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0', // Gnosis USDC.e
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // Base USDbC
  '0x4ecaba5870353805a9f068101a40e0f32ed605c6', // Gnosis USDT
]);

export const POPULAR_TOKENS = {
  1: [
    t('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 'USD Coin', 6),
    t('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 'Tether USD', 6),
    t('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI', 'Dai Stablecoin', 18),
    t('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 'Wrapped Ether', 18),
    t('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 'Wrapped BTC', 8),
    t('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'LINK', 'Chainlink', 18),
    t('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 'UNI', 'Uniswap', 18),
  ],
  8453: [
    t('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'USD Coin', 6),
    t('0x4200000000000000000000000000000000000006', 'WETH', 'Wrapped Ether', 18),
    t('0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 'DAI', 'Dai Stablecoin', 18),
    t('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC', 'Coinbase Wrapped BTC', 8),
  ],
  42161: [
    t('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC', 'USD Coin', 6),
    t('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USDT', 'Tether USD', 6),
    t('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH', 'Wrapped Ether', 18),
    t('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'WBTC', 'Wrapped BTC', 8),
    t('0x912CE59144191C1204E64559FE8253a0e49E6548', 'ARB', 'Arbitrum', 18),
  ],
  10: [
    t('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC', 'USD Coin', 6),
    t('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT', 'Tether USD', 6),
    t('0x4200000000000000000000000000000000000006', 'WETH', 'Wrapped Ether', 18),
    t('0x4200000000000000000000000000000000000042', 'OP', 'Optimism', 18),
  ],
  137: [
    t('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC', 'USD Coin', 6),
    t('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT', 'Tether USD', 6),
    t('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'WETH', 'Wrapped Ether', 18),
    t('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'WPOL', 'Wrapped POL', 18),
    t('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 'USDC.e', 'USD Coin (PoS)', 6, ICONS.USDC), // bridged USDC (on-chain symbol "USDC")
    t('0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', 'pUSD', 'Polymarket USD', 6, `${CG}102173037/small/polymarket.png`), // Polymarket's collateral
  ],
  56: [
    t('0x55d398326f99059fF775485246999027B3197955', 'USDT', 'Tether USD', 18),
    t('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC', 'USD Coin', 18),
    t('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'WBNB', 'Wrapped BNB', 18),
    t('0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'ETH', 'Binance-Peg Ether', 18),
  ],
  43114: [
    t('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USDC', 'USD Coin', 6),
    t('0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 'USDT', 'Tether USD', 6),
    t('0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', 'WAVAX', 'Wrapped AVAX', 18),
  ],
  59144: [ // the first six are the ones the MetaMask Card spends (shared/mmcard.js)
    t('0x176211869cA2b568f2A7D4EE941E073a821EE1ff', 'USDC', 'USD Coin', 6),
    t('0xA219439258ca9da29E9Cc4cE5596924745e12B93', 'USDT', 'Tether USD', 6),
    t('0xacA92E438df0B2401fF60dA7E4337B687a2435DA', 'mUSD', 'MetaMask USD', 6),
    t('0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', 'WETH', 'Wrapped Ether', 18),
    t('0x3ff47c5Bf409C86533FE1f4907524d304062428D', 'EURe', 'Monerium EUR emoney', 18),
    t('0x3Bce82cf1A2bc357F956dd494713Fe11DC54780f', 'GBPe', 'Monerium GBP emoney', 18),
    t('0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4', 'WBTC', 'Wrapped BTC', 8),
    t('0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5', 'DAI', 'Dai Stablecoin', 18),
    t('0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F', 'wstETH', 'Wrapped liquid staked Ether', 18),
    t('0x1Bf74C010E6320bab11e2e5A532b5AC15e0b8aA6', 'weETH', 'Wrapped eETH', 18),
    t('0x1789e0043623282D5DCc7F213d703C6D8BAfBB04', 'LINEA', 'Linea', 18),
  ],
  100: [
    t('0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', 'USDC', 'USD Coin', 6),
    t('0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', 'WXDAI', 'Wrapped xDAI', 18),
  ],
};
