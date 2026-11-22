// Android app entry: emulated extension runtime + background + UI in a single page.
import './shim.js';
import './crashHandlers.js'; // errors of the whole page (background + UI) and the native crashes, from here on
import '../background/index.js';
import './contractsTab.js'; // before the UI: the tab bar is built when app.jsx loads
import './tonPlugin.js'; // TON (GRAM): networks, background handlers, screens - before the UI too
import './solanaPlugin.js'; // Solana (SOL): networks, background handlers, screens - before the UI too
import './tronPlugin.js'; // Tron (TRX): networks, background handlers, screens - before the UI too
import './btcPlugin.js'; // Bitcoin (BTC): networks, background handlers, screens - before the UI too
import './walletconnectPlugin.js'; // WalletConnect: dapps outside the app (EVM, Solana, Tron) - after their families
import '../ui/index.jsx';
