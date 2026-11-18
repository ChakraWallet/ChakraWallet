// Base URLs of the public services the wallet talks to (prices, aggregators, bridges, TON data...). One place, so a
// test build can point them at local stand-ins (e2e/: local chains and simulated services) before the app starts:
//   globalThis.__CK_ENDPOINTS__ = { kyber: 'http://127.0.0.1:9100/kyber', paraswap: null, ... }
// null = the service is not available (its provider is skipped). Networks' own RPCs and indexers are in chains.js.
const DEFAULTS = {
  llama: 'https://coins.llama.fi', // prices and price history (DefiLlama)
  frankfurter: 'https://api.frankfurter.dev', // display currency rates (ECB)
  kyber: 'https://aggregator-api.kyberswap.com',
  paraswap: 'https://api.paraswap.io',
  openocean: 'https://open-api.openocean.finance',
  lifi: 'https://li.quest',
  relay: 'https://api.relay.link',
  across: 'https://app.across.to',
  debridge: 'https://dln.debridge.finance',
  debridgeStats: 'https://stats-api.dln.trade',
  symbiosis: 'https://api.symbiosis.finance',
  ston: 'https://api.ston.fi', // TON jettons: prices, icons
  omniston: 'wss://omni-ws.ston.fi', // TON swaps
  opensea: 'https://api.opensea.io', // NFT floor prices and sales (with a key)
  coingecko: 'https://api.coingecko.com', // NFT floor prices of the larger collections (no key)
  getgems: 'https://api.getgems.io/public-api', // TON NFT floor prices and sales (with a key)
  jupiter: 'https://lite-api.jup.ag', // Solana: token list, prices, swaps
  jito: 'https://mainnet.block-engine.jito.wtf', // Solana MEV protection: swaps as private bundles
  jitoTips: 'https://bundles.jito.wtf', // what Jito's bundles pay to land
  // TON Connect bridge (dapps outside the app, QR and links): TonAPI's public one, which every dapp listens to
  tonconnectBridge: 'https://bridge.tonapi.io/bridge',
  // MEV protection (Ethereum): signed transactions go to Flashbots Protect, a private channel to the block builders,
  // instead of the public mempool where bots can see a swap and trade around it ("sandwich")
  mevEth: 'https://rpc.flashbots.net/fast',
  mevStatus: 'https://protect.flashbots.net/tx', // what Flashbots Protect did with a transaction (/<hash>)
};

export const ENDPOINTS = { ...DEFAULTS, ...(globalThis.__CK_ENDPOINTS__ || {}) };
/** Is a service available (not switched off by a test build)? */
export const hasService = (name) => !!ENDPOINTS[name];
