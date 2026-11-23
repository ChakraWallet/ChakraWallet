# Building Chakra for review (addons.mozilla.org)

The Firefox package is built from this repository by [`build.mjs`](build.mjs): [esbuild](https://esbuild.github.io/)
bundles and minifies `src/` together with the npm libraries pinned in `package-lock.json`. Nothing is obfuscated, and
nothing is downloaded and run at runtime: every script the extension executes is in the package.

## Environment

- **Node.js 24** with its npm. The uploaded packages are built by GitHub Actions
  ([`build.yml`](.github/workflows/build.yml): `ubuntu-latest`, Node 24).
- Any OS and CPU: the output depends on neither (esbuild; the icons are drawn and PNG-compressed in plain JavaScript).
- No other tool. `npm ci` also installs packages that only the Android app and the tests use (compilers, local test
  chains); the extension build doesn't use them. npm 11 may report that install scripts were not run (`@foundry-rs/anvil`,
  `esbuild`, `protobufjs`): the build doesn't need them (checked: a clean copy built that way gives identical files).

## Commands

```
npm ci
GITHUB_RUN_NUMBER=<n> npm run build:ext
```

The unpacked extension is in `dist/firefox/`, its zip in `dist/chakra-firefox.zip` (compare the unpacked files: the
zip's file dates differ).

`<n>` is the number of the GitHub Actions run that built the uploaded package; it is written in the notes to reviewers
of each version. The extension shows it in Settings as its build number. It is the only value taken from the
environment: without it, `popup.js` differs in that string only.

## Where things are

- `src/background/`: the background script: encrypted vault, dapp provider, approvals, signing and sending
- `src/inpage.js`, `src/solanaInpage.js`: the provider in pages (`window.ethereum` with EIP-6963, a Solana Wallet
  Standard wallet); `src/content.js`: its bridge to the background
- `src/ui/`: the popup (Preact)
- `src/shared/`: networks, RPC, prices, swaps, translations
- `scripts/icon.mjs`: the icon, drawn in code

## Network services

Declared in the manifest as `financialAndPaymentInfo`: to work, the extension sends the user's addresses and signed
transactions, and asks for balances, history and quotes, to these services. Nothing goes to the developers.

- **Blockchain nodes** (balances, fees, simulating a transaction before it is signed, sending it): public RPC
  endpoints of each network (publicnode.com, drpc.org, cloudflare-eth.com, Tenderly's gateway for Sepolia, the
  networks' own), Alchemy, Helius, NodeReal, TON Center, TonAPI, TronGrid, mempool.space and blockstream.info
  (Bitcoin), Jito (Solana). On Ethereum, transactions go to Flashbots Protect by default (protection from
  front-running; Settings > Security), and to the usual nodes if it can't be reached.
- **Indexers** (history, tokens, NFTs): Etherscan API, Routescan, Blockscout, NodeReal, UniSat, TonAPI, OpenSea, Getgems.
- **Prices and exchange rates**: DefiLlama, CoinGecko, Frankfurter (European Central Bank rates).
- **Swaps and bridges** (only when the user asks for a quote): KyberSwap, Velora (ParaSwap), OpenOcean, LI.FI, Relay,
  Across, deBridge, Symbiosis, Jupiter, STON.fi, SUN.io. SUN.io's route service is at `rot.endjgfsv.link`: it is the
  one sun.io itself uses.
- **Images**: token icons (CoinGecko, Trust Wallet's assets on GitHub), NFT images (IPFS and Arweave gateways).
- **Android app only**: WalletConnect, TON Connect bridges and Polymarket. Their code is shared and bundled, but the
  extension doesn't offer these features.

API keys the user adds (Etherscan, Alchemy, NodeReal, OpenSea, Helius, UniSat) are sent only to the service that
issued them.
