// Solana (coin: SOL) in the Android app: the Solana networks, the background handlers (keys, signing), the driver
// the shared screens use for Solana (balances, history, sends, swaps, bridges, NFTs) and the Solana dapps of the
// in-app browser (Wallet Standard: src/mobile/solanaInpage.js, src/background/solanaDapp.js).
// Loaded by the Android entry before the UI; not part of the browser extension.
import { registerChains } from '../shared/chains.js';
import { registerUiHandlers, registerDappFamily, requestApproval, ensureUnlocked, emitToOrigin } from '../background/index.js';
import { solanaDappFamily } from '../background/solanaDapp.js';
import { registerApprovalViews } from '../ui/screens/approve.jsx';
import { solanaApprovalViews } from '../ui/solana/approvals.jsx';
import { SOL_CHAINS, setHeliusKey } from '../shared/solana/api.js';
import { solanaHandlers } from '../background/solana.js';
import { solanaChainDriver } from '../ui/solana/index.jsx';
import { solWatch } from '../ui/solana/hooks.js';
import { registerWatchExtra } from '../ui/hooks.js';
import { registerDriver } from '../ui/chains/index.js';
import { ext, local } from '../shared/ext.js';

registerChains(Object.values(SOL_CHAINS));
registerUiHandlers(solanaHandlers);
registerDriver(solanaChainDriver);
registerWatchExtra(solWatch); // notifications with the app closed: Solana's balances too (WatchWorker.java)

// optional Helius key (Settings > Service keys)
const keys = (s) => { setHeliusKey(s?.heliusKey); };
local.get('settings', {}).then(keys);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) keys(changes.settings.newValue); });

// dapps of the in-app browser: requests, sessions and signatures, and their approval screens
registerDappFamily(solanaDappFamily({ requestApproval, ensureUnlocked, emitToOrigin }));
registerApprovalViews(solanaApprovalViews);
