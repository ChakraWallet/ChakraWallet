// Bitcoin networks: mainnet and Testnet4. Balances, coins, history, fees and broadcasting come from
// mempool.space's public Esplora API (no key; blockstream.info answers the same API on mainnet when it fails).
// Ordinals and Runes come from UniSat's indexer: on mainnet with the user's free key (Settings > Service keys), on
// Testnet4 without one. The ids are negative like the other non-EVM networks: the node ports (8333, 48333).
export const BTC_MAINNET = -8333;
export const BTC_TESTNET = -48333;

const MAIN_NET = { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
const TEST_NET = { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export const BTC_CHAINS = {
  [BTC_MAINNET]: {
    id: BTC_MAINNET, kind: 'bitcoin', name: 'Bitcoin', short: 'BTC', color: '#F7931A',
    native: { symbol: 'BTC', name: 'Bitcoin', decimals: 8, priceId: 'coingecko:bitcoin' },
    esplora: ['https://mempool.space/api', 'https://blockstream.info/api'], explorer: 'https://mempool.space',
    coin: 0, net: MAIN_NET, unisat: 'https://open-api.unisat.io', unisatContent: 'https://static.unisat.io/content',
    relayId: 8253038, lifiId: 20000000000001, swap: false,
  },
  [BTC_TESTNET]: {
    id: BTC_TESTNET, kind: 'bitcoin', name: 'Bitcoin Testnet4 (test)', short: 'tBTC', color: '#9CA3AF', testnet: true,
    native: { symbol: 'BTC', name: 'Bitcoin (Testnet4)', decimals: 8 },
    esplora: ['https://mempool.space/testnet4/api'], explorer: 'https://mempool.space/testnet4',
    coin: 1, net: TEST_NET, unisat: 'https://open-api-testnet4.unisat.io', unisatContent: null, unisatFree: true,
    faucet: 'https://mempool.space/testnet4/faucet', swap: false,
  },
};

export const isBitcoin = (chain) => chain?.kind === 'bitcoin';
export const btcChain = (id) => BTC_CHAINS[id] || null;
export const btcTxUrl = (chain, txid) => (txid ? `${chain.explorer}/tx/${txid}` : null);
export const btcAddrUrl = (chain, a) => `${chain.explorer}/address/${a}`;
/** The network of an address's prefix: 'main' | 'test' | null (not a Bitcoin address). */
export function addressNetwork(text) {
  const s = String(text || '').trim();
  if (/^(bc1|[13])/i.test(s)) return 'main';
  if (/^(tb1|bcrt1|[mn2])/i.test(s)) return 'test';
  return null;
}
