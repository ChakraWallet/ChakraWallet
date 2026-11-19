# Chakra

A simple wallet for Ethereum and EVM networks, available as a browser extension for **Chrome** (and Chromium browsers: Edge, Brave, Opera) and **Firefox**, and as an **Android** app.
Sites find it by name (EIP-6963), and older sites that only know MetaMask use it too.

The interface is in English, with Italian available (Settings → General → Language; by default it follows the device language).

## Features
- **One global password** set on first launch protects every key (PBKDF2-SHA256 600k + AES-256-GCM). Configurable auto-lock.
- **Separate wallets (profiles)**: you can have several wallets, each with its own recovery phrase (new or imported) or only with private keys. They are isolated: you see, use and connect to sites only the accounts of the active wallet; switch wallet from Accounts → Active wallet or Settings → Wallets. Imported private keys go into the active wallet. One password for all of them. Any account and any wallet can be deleted (the last one too, which takes you back to the start): keys, names, site connections and local history are erased. An existing single-wallet vault is migrated automatically.
- **Accounts**: derived locally from the recovery phrase (BIP-44), accounts with an independent key, or imported private keys. QR code of the address and, after entering the password, of the private key. Every account has its own colours, derived from its address and the same everywhere (card, dot, lists).
- **Custom (vanity) addresses**: Accounts → Add account → Custom address. An account with a separate key whose address starts *or* ends with a word of up to 6 characters. Letters that are not hex become look-alike digits (o→0, i/l→1, z→2, h→4, s→5, g→6, t→7, q→9), the others are removed; a live preview shows the conversion and the address. The search runs on the device in Web Workers (one per core, incremental secp256k1 method, every batch from a fresh 256-bit random scalar), and each key found is checked again before it is saved. 6 characters take a few minutes on a phone; in the Android app the screen stays on during the search.
- **Balances**: the network currency and every ERC-20 token found automatically, with USD value. Spam filter.
- **Send / Receive** with estimated fee (Slow/Normal/Fast) in USD and in the native currency, plus the total. On Base and Optimism the L1 data cost is included.
- **Best-price swaps**: queries KyberSwap, Velora (ParaSwap), OpenOcean and LI.FI in parallel and ranks them by *net value* (what you receive minus the network fee). Approvals are for the exact amount only, never unlimited.
- **Bridge between networks**: compares LI.FI, Relay, Across and deBridge (public APIs, no keys, no fee added by Chakra) and ranks routes by net value; exact-amount approvals, optional gas top-up on arrival (Relay), recipient = same account / another account / external address. Transfers are tracked until they arrive, with a notification.
- **History** grouped by day, with filters (Sent/Received/Swap/Other), fees paid, details and explorer links. Spam transactions are hidden, including address-poisoning fakes (look-alike token names with invisible or foreign characters, well-known symbols at the wrong contract, "sent" transfers you never signed). Bridges are recognised in the history, also when made elsewhere (destination and status asked to Relay / LI.FI / Across / deBridge with the transaction hash only).
- **Dapps**: EIP-1193 provider on `window.ethereum` (`isMetaMask: true`) and EIP-6963 announcement as "Chakra"; for the rare sites that list MetaMask alone, Chakra can also announce itself as "MetaMask" (Settings → MetaMask mode, off by default: with the real MetaMask installed two wallets would claim its name). Supports connecting, `personal_sign`, `eth_signTypedData_v4` (with a warning on *permits*), `eth_sendTransaction` (decodes approve/transfer, warns about unlimited approvals), switching and adding networks, `wallet_watchAsset`.
- **Authorization of signatures and transactions**: every send, every swap (once for approval + swap) and every signature or transaction requested by a site needs the wallet password, checked by the background. In the Android app you can use your fingerprint instead (Settings → Security → Fingerprint unlock), also to unlock the wallet: the password is encrypted with a Keystore key that can only be used right after a fingerprint and is invalidated if fingerprints are added or changed on the phone. Recovery phrase, private keys, backup and reset always ask for the password.
- **Encrypted text backup** (Settings → Security): a single line of text `CHAKRA-BACKUP-2:…` with **only the active wallet** (its recovery phrase, all its keys and the account names), encrypted with a password chosen at every export (PBKDF2-SHA256 600k + AES-256-GCM). It can be imported in both the extension and the app: on first launch ("Restore from a Chakra backup") or into an existing installation ("Import backup": it becomes a new wallet without touching the others; if its phrase is already in a wallet, only the missing accounts are added there). `CHAKRA-BACKUP-1` backups can still be imported.
- **Theme**: light, dark or system (Settings → General → Theme). In the Android app the interface is 25% larger and the keyboard never covers fields or buttons.
- **Dapp browser in the Android app**: multiple tabs (up to 10, reopened after a restart and loaded only when you open them), tab previews, favicons, "open in new window" links in a new tab. Tapping the padlock shows the site certificate (issued to/by, validity, SHA-256 fingerprint) and the connected accounts, lets you disconnect the site and clear its data (cookies, storage, service workers). Invalid certificates are always refused.
- **Built-in networks**: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Gnosis, Sepolia, plus custom networks.
- **Tron in the Android app** (and Nile, its test network): TRX, TRC-20 and TRC-10 balances, history with address-poisoning filters, sends with their cost in energy, bandwidth and burnt TRX shown before signing; a Resources page to stake TRX (Stake 2.0), rent energy from JustLend, vote for Super Representatives and claim rewards, delegate resources, and check who controls the account; swaps through SUN.io's Smart Router, bridges with Relay, deBridge and LI.FI; Tron dapps in the in-app browser (`window.tron` with TIP-6963, `window.tronLink`, a real `tronWeb` loaded only on Tron sites), where a change of the account's permissions is always refused; Solidity contracts read, called and deployed; custom `T…` addresses. Accounts of the recovery phrase use TronLink's path (`m/44'/195'/0'/0/i`); an imported Ethereum key has its own Tron address (the same key).
- **Bitcoin in the Android app** (and Testnet4): every account of the recovery phrase is a full HD wallet with Native SegWit (`bc1q…`, BIP84 `m/84'/0'/n'`) and Taproot (`bc1p…`, BIP86 `m/86'/0'/n'`) addresses — a new receive address after each payment, change addresses, the standard 20-address gap limit, so Sparrow, BlueWallet or Electrum restore the same funds; older `1…`/`3…` addresses of imported wallets are found and spent too. Coin selection with Slow/Normal/Fast or a custom rate in sat/vB, "send all", coin control (freeze, choose the coins), speed up and cancel (RBF) and speeding up an incoming payment (CPFP). Coins that may carry Ordinals inscriptions or Runes are protected from plain sends without any service (the transaction that created them is read: runestones, inscription envelopes, small "postage" coins); with a free UniSat key inscriptions show as NFTs and can be sent, runes as tokens (sent with a runestone) and BRC-20 balances are shown. Watch-only export (output descriptors, xpub), import from other Bitcoin wallets (BIP39 phrase, Electrum seed, WIF key), bridges to and from EVM networks with Relay (deposit address) and LI.FI. Data from mempool.space's public API; the background signs only after checking that every coin is the account's, the change really comes back to it and the fee is sane. An imported Ethereum key has its own Bitcoin addresses (the same key).

## Build
Requirements: Node.js 22+.
```
npm install
npm run build
```
Output in `dist/`:
- `dist/chrome/` and `dist/chakra-chrome.zip`
- `dist/firefox/` and `dist/chakra-firefox.zip`

### Android
Requirements: JDK 21 and the Android SDK.
```
JAVA_HOME=/path/to/jdk ANDROID_HOME=/path/to/Android/Sdk npm run android                     # debug
JAVA_HOME=… ANDROID_HOME=… ANDROID_KEYSTORE_FILE=release.jks ANDROID_KEYSTORE_PASSWORD=… \
  ANDROID_KEY_ALIAS=chakra ANDROID_KEY_PASSWORD=… npm run android -- --release           # signed release
```
Output: `dist/chakra-android-debug.apk` / `dist/chakra-android-release.apk`.
Without the `ANDROID_KEY*` variables the release build is unsigned. `ANDROID_VERSION_CODE` / `ANDROID_VERSION_NAME` (optional) set the version.

### GitHub Actions
`.github/workflows/build.yml` builds the extensions and the signed release APK on every push to `master`, on `v*` tags (attaching the files to the GitHub Release) or manually.
Required secrets: `ANDROID_KEYSTORE_BASE64` (the keystore in base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
The `versionCode` is the run number, so every APK installs over the previous one.

## Installation

### Chrome / Edge / Brave
1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `dist/chrome` folder.

To install it on another computer, copy the `dist/chrome` folder (or the zip, extracted) and repeat the steps.
Once published on the Chrome Web Store it installs with one click.

### Firefox (128+)
- **Temporary test**: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → choose `dist/firefox/manifest.json`. It stays active until Firefox is closed.
- **Permanent installation**: Firefox only accepts signed extensions. Upload it for free to [addons.mozilla.org](https://addons.mozilla.org/developers/) as **"Unlisted"** (self-distribution): you get a signed `.xpi` file to install on any computer.
  When submitting, check the `data_collection_permissions` declaration in the manifest. Addresses are sent to public indexers/aggregators to read balances, history and quotes.

## Notes
- No own servers and no extra fees. Public services used: public RPCs, Blockscout / Routescan (tokens and history), DefiLlama (prices), DEX aggregators (swaps).
- **BNB Chain**: there is no free indexer without an API key. The main tokens and the ones added by hand are shown. The full history needs an Etherscan API key (Settings) with a plan that includes BSC.
- `eth_sign` (signing a raw 32-byte hash, like MetaMask) is off by default. Turn it on in **Settings → Advanced → Allow eth_sign**. Even then, every request shows a warning and requires ticking "I understand the risks".
- Decrypted keys stay only in `storage.session` (memory) while the wallet is unlocked.
- Development: `npm run watch` rebuilds on every change. After each build, reload the extension from the extensions page.
- Tests: `npm test` runs the unit tests in `tests/` (vault, Android storage, anti-spam and anti-poisoning, payment links, HTTP retry, vanity addresses) and the translation check. `npm run test:unit -- vault` runs only the matching files.
- End-to-end: `npm run e2e` sends, swaps and bridges on EVM and TON through the real interface, on local networks (Anvil, TON sandbox) with simulated services - no testnet or faucet; also on GitHub at every push (see [e2e/README.md](e2e/README.md)).
- Translations: `node scripts/i18n-check.mjs` lists keys used in the code that are missing from the English or Italian dictionaries (`src/shared/locales/`).

## Structure
```
src/background/     encrypted vault, dapp provider, approvals, signing and sending
src/inpage.js       window.ethereum + EIP-6963 (in the page)
src/content.js      page ↔ background bridge
src/mobile/         Android runtime (Capacitor): extension API shim, in-app browser bridge
src/shared/         networks, RPC, fees, balances, history, prices, swaps, i18n
src/shared/locales/ dictionaries (en = base and fallback, it)
src/ui/             interface (Preact): popup, screens, approvals
src/ui/chains/      chain drivers: the screens' interface to each family of networks (EVM here, TON in src/ui/ton, Solana in src/ui/solana, Tron in src/ui/tron, Bitcoin in src/ui/btc)
scripts/            Android build, icon renderer, i18n checker
android/            Capacitor Android project (native plugins: dapp browser, fingerprint, system bars)
build.mjs           build for Chrome, Firefox and Android + icons + zip
```

The wallet screens are the same for every network: each family of networks (EVM, TON, Solana, Tron, Bitcoin…) plugs in through a chain
driver (`src/ui/chains/driver.d.md`) and, for keys, a family module in the background (`src/background/families.js`).
Adding one: [docs/adding-a-chain.md](docs/adding-a-chain.md). `npm test` checks every driver
against the interface (`tests/drivers.test.js`).
