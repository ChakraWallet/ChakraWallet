# Adding a family of networks (e.g. Tron)

The screens never need to change: a new family is a **driver** for the UI, a **module** for keys and signing in the
background, its **networks** and its **data**. TON and Solana are complete examples (Android app only): TON in
`src/ui/ton/driver.js`, `src/background/ton.js`, `src/shared/ton/*`, registered by `src/mobile/tonPlugin.js`; Solana in
`src/ui/solana/*`, `src/background/solana.js` (+ `solanaDapp.js`, Wallet Standard dapps), `src/shared/solana/*`,
registered by `src/mobile/solanaPlugin.js`.

## Checklist

1. **Networks** — `src/shared/<family>/api.js`: the network objects with `kind: '<family>'`, `native` (symbol,
   decimals, DefiLlama `priceId`), `explorer`, `swap: true` if swaps exist; register them with `registerChains()`
   from the platform module. `isEvm()` is false for them, so dapps and EVM-only places skip them.
2. **Keys** (background) — `src/background/<family>.js`:
   - derive the family's key of an account of the recovery phrase (`vault.familyKeySource('<family>', address)` gives
     `{ phrase, index }`; standard paths: Solana `m/44'/501'/i'/0'` (ed25519, SLIP-0010), Tron `m/44'/195'/0'/0/i`
     (secp256k1, the same curve as Ethereum: an imported Ethereum key also has a Tron address));
   - a handler listing the accounts' addresses (TON: `tonAccounts`) and one that signs and broadcasts (TON: `tonSend`),
     each checking the wallet password; register them with `registerUiHandlers()`;
   - wallets imported from another app of the family: `registerFamily('<family>', { clean })` in
     `src/background/families.js` (plain data checks, no network library) and `vault.addFamilyAccount()`.
     The vault stores them as `w['<family>']`, backups carry them, accounts get `type: '<family>'`.
3. **Driver** (UI) — `src/ui/<family>/driver.js`, implementing `src/ui/chains/driver.d.md`. Start from the skeleton
   below; reuse the shapes, not the code, of `src/shared/portfolio.js` / `history.js`. Prices: DefiLlama keys
   (`coingecko:<id>`, `<chain>:<token address>`), so the price chart works too.
4. **Register** — in the platform module: `registerChains(...)`, `registerUiHandlers(...)`, `registerDriver(driver)`
   (browser extension: `src/ui/index.jsx`; Android app: `src/mobile/index.jsx` + a plugin file like `tonPlugin.js`).
5. **Words** — the family's i18n keys in `src/shared/locales/{en,it}/<family>.js` (+ `index.js`); `npm test` lists
   missing ones. Generic texts already exist (`send.memo`, `tx.waiting`, `chain.noKey.*`, …).
6. **Logo** — `src/ui/logos.jsx` (network and native token).
7. **Tests** — add a fixture to `tests/drivers.test.js` (a network, two addresses, the API answers): the contract tests
   then run on the new driver. Test the key derivation against known vectors in `tests/<family>.test.js`.
8. **Look at it** — add the family's API answers to `landing/shots/mocks/fetch.js`, then
   `cd landing && node shots/build-demo.mjs && node shots/check-chain.mjs <chainId>`: screenshots of every wallet
   screen of the network in `landing/shots/.check/<chainId>/`.

## Skeleton

```js
// src/ui/solana/driver.js
import { NATIVE } from '../../shared/chains.js';
import { bg } from '../../shared/ext.js';
import { t } from '../../shared/i18n.js';

export const solanaDriver = {
  kind: 'solana',
  features: { memo: true }, // see driver.d.md
  defaultChainId: /* the main network's id */ 0,

  async resolveAddresses(chain, accounts) {
    const map = await bg('solanaAccounts'); // background: addresses derived from the phrase / imported keys
    return Object.fromEntries(accounts.map((a) => [a.address, map[a.address] ? { address: map[a.address], raw: map[a.address] } : null]));
  },
  validateAddress(chain, text, own) { /* base58, 32 bytes */ },
  addressPlaceholder: () => 'Base58…',
  parseQr(chain, text) { /* solana: pay links */ },
  paymentLink(chain, { address, token, amountRaw, ask }) { /* solana:<address>?amount=… */ },
  receiveTokens: (chain, held) => held,
  receiveNote: () => ({ key: 'solana.receive.note' }),

  async loadPortfolio(chain, raw, { hiddenTokens = [] } = {}) { /* SOL + SPL tokens, shared shape */ },
  async loadHistory(chain, raw, cursor) { /* items as classify() */ },
  priceKey: (chain, token) => (token.native ? chain.native.priceId : `solana:${token.address}`),
  explorerToken: (chain, address) => `${chain.explorer}/token/${address}`,

  async prepareSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio }) {
    // build the transaction, estimate the fee
    return { recipient: to, rows: [], notes: [], amount: () => amountRaw, problem: () => null,
      fee: { kind: 'fixed', amount: 5000n, decimals: 9, symbol: chain.native.symbol } };
  },
  async confirmSend(chain, review, { account, authorize }) {
    const r = await authorize((password) => bg('solanaSend', { from: account.address, chainId: chain.id, /* … */ password }), t('send.confirmTitle'));
    return { hash: r.signature, wait: /* confirmation */ null };
  },
};
```
