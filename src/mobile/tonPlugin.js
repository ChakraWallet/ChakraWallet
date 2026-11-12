// TON (coin: GRAM) in the Android app: the TON networks, the background handlers (keys, signing) and the screens.
// Loaded by the Android entry before the UI; not part of the browser extension.
import '../shared/ton/buffer.js';
import { registerChains } from '../shared/chains.js';
import { registerUiHandlers } from '../background/index.js';
import { TON_CHAINS, setTonCenterKey } from '../shared/ton/api.js';
import { setTonApiKey } from '../shared/ton/tonapi.js';
import { tonHandlers } from '../background/ton.js';
import { tonScreens, tonShared } from '../ui/ton/index.jsx';
import { ext, local } from '../shared/ext.js';

registerChains(Object.values(TON_CHAINS));
registerUiHandlers(tonHandlers);
globalThis.__CK_TON__ = { screens: tonScreens, ...tonShared };

// optional TON Center and TonAPI keys (Settings > Data)
const keys = (s) => { setTonCenterKey(s?.tonCenterKey); setTonApiKey(s?.tonApiKey); };
local.get('settings', {}).then(keys);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) keys(changes.settings.newValue); });
