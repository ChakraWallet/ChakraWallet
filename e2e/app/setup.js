// First module of the test build (no imports, so it runs before every app module): the public services point at the
// local simulated ones (e2e/env/services.mjs); the ones not simulated are switched off (null: their providers are skipped).
const S = __E2E__; // the environment's addresses, injected by e2e/app/build.mjs
globalThis.__CK_ENDPOINTS__ = {
  llama: `${S.services}/llama`, frankfurter: `${S.services}/frankfurter`,
  kyber: `${S.services}/kyber`, paraswap: null, openocean: null, lifi: null,
  relay: `${S.services}/relay`, across: null, debridge: null, debridgeStats: null,
  symbiosis: `${S.services}/symbiosis`, ston: `${S.services}/ston`, omniston: S.omniston || null,
  opensea: null, coingecko: null, getgems: null, // NFT prices: not simulated
  mevEth: null, // MEV protection: the local networks have no private channel
};
