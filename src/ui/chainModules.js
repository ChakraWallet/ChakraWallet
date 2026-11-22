// Networks of other families in the interface, for both platforms: their networks, the driver the wallet screens use
// for them, the approval screens of Solana's dapps, their part of the balance check with the app closed (Android app
// only) and their optional service keys. Loaded by src/ui/index.jsx before the app; their background side is
// src/background/chainModules.js. (TON Connect and Tron dapps: Android app only, src/mobile/tonPlugin.js, tronPlugin.js.)
import '../shared/ton/buffer.js'; // before the TON libraries: they use Node's Buffer
import { registerChains } from '../shared/chains.js';
import { ext, local } from '../shared/ext.js';
import { registerDriver } from './chains/index.js';
import { registerWatchExtra } from './hooks.js';
import { registerApprovalViews } from './screens/approve.jsx';
import { TON_CHAINS, setTonCenterKey } from '../shared/ton/api.js';
import { setTonApiKey } from '../shared/ton/tonapi.js';
import { setSymbiosisKey } from '../shared/ton/bridge.js';
import { tonChainDriver } from './ton/index.jsx';
import { tonWatch } from './ton/hooks.js';
import { SOL_CHAINS, setHeliusKey } from '../shared/solana/api.js';
import { solanaChainDriver } from './solana/index.jsx';
import { solanaApprovalViews } from './solana/approvals.jsx';
import { solWatch } from './solana/hooks.js';
import { TRON_CHAINS, setTronGridKey } from '../shared/tron/api.js';
import { tronChainDriver } from './tron/index.jsx';
import { tronWatch } from './tron/hooks.js';
import { BTC_CHAINS } from '../shared/btc/networks.js';
import { setUnisatKey, forgetUnisat } from '../shared/btc/unisat.js';
import { btcChainDriver } from './btc/index.jsx';
import { btcWatch } from './btc/hooks.js';

// in this order in the lists of networks: TON, Solana, Tron, Bitcoin (after Ethereum)
registerChains(Object.values(TON_CHAINS));
registerDriver(tonChainDriver);
registerWatchExtra(tonWatch); // Android: TON's balances in the check with the app closed (WatchWorker.java)

registerChains(Object.values(SOL_CHAINS));
registerDriver(solanaChainDriver);
registerApprovalViews(solanaApprovalViews); // the Solana dapps' requests
registerWatchExtra(solWatch);

registerChains(Object.values(TRON_CHAINS));
registerDriver(tronChainDriver);
registerWatchExtra(tronWatch);

registerChains(Object.values(BTC_CHAINS));
registerDriver(btcChainDriver);
registerWatchExtra(btcWatch);

// optional service keys (Settings > Service keys): TON Center, TonAPI and Symbiosis (TON), Helius (Solana), TronGrid
// (Tron), UniSat (Ordinals, Runes and BRC-20 on Bitcoin mainnet)
const keys = (s) => {
  setTonCenterKey(s?.tonCenterKey); setTonApiKey(s?.tonApiKey); setSymbiosisKey(s?.symbiosisKey);
  setHeliusKey(s?.heliusKey); setTronGridKey(s?.tronGridKey);
  setUnisatKey(s?.unisatKey); forgetUnisat();
};
local.get('settings', {}).then(keys);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) keys(changes.settings.newValue); });
