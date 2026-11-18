// Tron (coin: TRX) in the Android app: the Tron networks, the background handlers (keys, signing), the driver the
// shared screens use for Tron (balances, history, sends) and the background check of its balances.
// Loaded by the Android entry before the UI; not part of the browser extension.
import { registerChains } from '../shared/chains.js';
import { registerUiHandlers, registerDappFamily, requestApproval, ensureUnlocked, emitToOrigin } from '../background/index.js';
import { tronDappFamily } from '../background/tronDapp.js';
import { registerApprovalViews } from '../ui/screens/approve.jsx';
import { tronApprovalViews } from '../ui/tron/approvals.jsx';
import { TRON_CHAINS, setTronGridKey } from '../shared/tron/api.js';
import { tronHandlers } from '../background/tron.js';
import { tronChainDriver } from '../ui/tron/index.jsx';
import { tronWatch } from '../ui/tron/hooks.js';
import { registerWatchExtra } from '../ui/hooks.js';
import { registerDriver } from '../ui/chains/index.js';
import { ext, local } from '../shared/ext.js';

registerChains(Object.values(TRON_CHAINS));
registerUiHandlers(tronHandlers);
registerDriver(tronChainDriver);
registerWatchExtra(tronWatch); // notifications with the app closed: Tron's balances too (WatchWorker.java)

// optional TronGrid key (Settings > Service keys)
const keys = (s) => { setTronGridKey(s?.tronGridKey); };
local.get('settings', {}).then(keys);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) keys(changes.settings.newValue); });

// dapps of the in-app browser (window.tron, window.tronLink, tronWeb): requests, sessions, signatures and their screens
registerDappFamily(tronDappFamily({ requestApproval, ensureUnlocked, emitToOrigin }));
registerApprovalViews(tronApprovalViews);
