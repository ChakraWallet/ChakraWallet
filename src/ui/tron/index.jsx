// Tron in the Android app: the Tron driver plus the pieces of the accounts screen that are Tron's own (importing a
// wallet from another Tron app, Tron balances in the accounts' summary). Registered by src/mobile/tronPlugin.js.
import { ImportTron } from './import.jsx';
import { useTronSummaries } from './hooks.js';
import { tronDriver } from './driver.js';
import { tronSwap } from './swap.js';
import { tronBridge } from './bridge.js';
import { TronHomeExtra, TronResources } from './resources.jsx';
import { TronVanity } from './vanity.jsx';

export const tronChainDriver = {
  ...tronDriver,
  ...tronSwap,
  bridge: tronBridge,
  features: { ...tronDriver.features, approvals: true }, // a TRC-20 sold is approved first (Swap: "Continue")
  ui: {
    ImportAccount: ImportTron, importLabel: 'accounts.add.tron', importSub: 'accounts.add.tron.sub', // Accounts > Add
    // how an account imported into Tron only is labelled (type, short type, its address)
    typeLabel: 'accounts.type.tron', typeShort: 'accounts.short.tron', addressLabel: 'accounts.address.tron',
    useSummaries: useTronSummaries, // Tron balances in the accounts' multichain summary
    addOptions: [{ key: 'vanity', icon: 'sparkle', label: 'tron.vanity.label', sub: 'tron.vanity.sub', Component: TronVanity }], // Accounts > Add
    HomeExtra: TronHomeExtra, // the home's card: energy and bandwidth now, opens the Resources page
    screens: { tronResources: TronResources }, // stake, rent, votes, delegations, who controls the account
    // Settings > Service keys (screens/apikeys.jsx): what each key unlocks, its price, how to get it
    settings: [
      { key: 'tronGridKey', name: 'TronGrid', label: 'settings.trongrid', hint: 'settings.trongrid.hint', unlocks: 'keys.trongrid.unlocks', price: 'free',
        url: 'https://www.trongrid.io/dashboard', site: 'trongrid.io', steps: ['keys.trongrid.1', 'keys.trongrid.2', 'keys.trongrid.3'] },
    ],
  },
};
