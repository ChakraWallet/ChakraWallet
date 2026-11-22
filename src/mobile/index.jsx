// Android app entry: emulated extension runtime + background + UI in a single page.
import './shim.js';
import './crashHandlers.js'; // errors of the whole page (background + UI) and the native crashes, from here on
import '../background/index.js';
import '../background/chainModules.js'; // TON, Solana, Tron, Bitcoin: networks, background handlers, Solana dapps
import './contractsTab.js'; // before the UI: the tab bar is built when app.jsx loads
import './tonPlugin.js'; // TON Connect (in-app browser, QR codes, links that open the app) - before the UI too
import './tronPlugin.js'; // Tron dapps of the in-app browser - before the UI too
import './walletconnectPlugin.js'; // WalletConnect: dapps outside the app (EVM, Solana, Tron) - after their families
import '../ui/index.jsx';
