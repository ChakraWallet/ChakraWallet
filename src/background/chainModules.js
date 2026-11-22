// Networks of other families in the background, for both platforms: their networks, the handlers their screens
// call (keys, signing, sending) and the Solana dapps (Wallet Standard: src/solanaInpage.js is the page's side).
// Loaded after src/background/index.js, where they register: by the extension's background entry
// (src/background/extension.js) and by the Android app's entry (src/mobile/index.jsx), which adds what only the app
// has (TON Connect, Tron dapps, WalletConnect). Their screens register in the interface from src/ui/chainModules.js.
// (How the vault stores wallets imported into one family: src/background/families.js.)
import '../shared/ton/buffer.js'; // before the TON libraries: they use Node's Buffer
import { registerChains } from '../shared/chains.js';
import { ext, local } from '../shared/ext.js';
import { registerUiHandlers, registerDappFamily, requestApproval, ensureUnlocked, emitToOrigin } from './index.js';
import { TON_CHAINS, setTonCenterKey } from '../shared/ton/api.js';
import { tonHandlers } from './ton.js';
import { SOL_CHAINS, setHeliusKey } from '../shared/solana/api.js';
import { solanaHandlers } from './solana.js';
import { solanaDappFamily } from './solanaDapp.js';
import { TRON_CHAINS } from '../shared/tron/api.js';
import { tronHandlers } from './tron.js';
import { BTC_CHAINS } from '../shared/btc/networks.js';
import { btcHandlers } from './btc.js';

// in this order in the lists of networks: TON, Solana, Tron, Bitcoin (after Ethereum)
registerChains(Object.values(TON_CHAINS));
registerUiHandlers(tonHandlers);

registerChains(Object.values(SOL_CHAINS));
registerUiHandlers(solanaHandlers);
registerDappFamily(solanaDappFamily({ requestApproval, ensureUnlocked, emitToOrigin }));

registerChains(Object.values(TRON_CHAINS));
registerUiHandlers(tronHandlers);

registerChains(Object.values(BTC_CHAINS)); // no dapps
registerUiHandlers(btcHandlers);

// optional service keys the background uses (Settings > Service keys): TON Center for TON's accounts and sends,
// Helius for Solana's RPC
const keys = (s) => { setTonCenterKey(s?.tonCenterKey); setHeliusKey(s?.heliusKey); };
local.get('settings', {}).then(keys);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) keys(changes.settings.newValue); });
