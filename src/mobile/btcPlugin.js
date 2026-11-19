// Bitcoin (coin: BTC) in the Android app: the Bitcoin networks, the background handlers (keys, signing), the driver the
// shared screens use for Bitcoin (balances, history, sends, Ordinals and Runes) and the background check of its
// balances. Loaded by the Android entry before the UI; not part of the browser extension.
import { registerChains } from '../shared/chains.js';
import { registerUiHandlers } from '../background/index.js';
import { BTC_CHAINS } from '../shared/btc/networks.js';
import { setUnisatKey, forgetUnisat } from '../shared/btc/unisat.js';
import { btcHandlers } from '../background/btc.js';
import { btcChainDriver } from '../ui/btc/index.jsx';
import { btcWatch } from '../ui/btc/hooks.js';
import { registerWatchExtra } from '../ui/hooks.js';
import { registerDriver } from '../ui/chains/index.js';
import { ext, local } from '../shared/ext.js';

registerChains(Object.values(BTC_CHAINS));
registerUiHandlers(btcHandlers);
registerDriver(btcChainDriver);
registerWatchExtra(btcWatch); // notifications with the app closed: Bitcoin's balances too (WatchWorker.java)

// optional UniSat key (Settings > Service keys): Ordinals, Runes and BRC-20 on mainnet
const keys = (s) => { setUnisatKey(s?.unisatKey); forgetUnisat(); };
local.get('settings', {}).then(keys);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) keys(changes.settings.newValue); });
