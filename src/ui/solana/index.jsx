// Solana in the interface: the Solana driver plus the pieces of the accounts screen that are Solana's own (importing
// a wallet from another Solana app, Solana balances in the accounts' summary). Registered by src/ui/chainModules.js.
import { ImportSolana } from './import.jsx';
import { useSolSummaries } from './hooks.js';
import { solanaDriver } from './driver.js';
import { solanaSwap } from './swap.js';
import { solanaBridge } from './bridge.js';
import { SolHomeExtra } from './emptyAccounts.jsx';
import { SolVanity } from './vanity.jsx';

export const solanaChainDriver = {
  ...solanaDriver,
  ...solanaSwap,
  bridge: solanaBridge,
  ui: {
    ImportAccount: ImportSolana, importLabel: 'accounts.add.solana', importSub: 'accounts.add.solana.sub', // Accounts > Add
    // how an account imported into Solana only is labelled (type, short type, its address)
    typeLabel: 'accounts.type.solana', typeShort: 'accounts.short.solana', addressLabel: 'accounts.address.solana',
    useSummaries: useSolSummaries, // Solana balances in the accounts' multichain summary
    addOptions: [{ key: 'vanity', icon: 'sparkle', label: 'sol.vanity.label', sub: 'sol.vanity.sub', Component: SolVanity }], // Accounts > Add
    HomeExtra: SolHomeExtra, // the home's row for the empty token accounts (their rent comes back when closed)
    // Settings > Service keys (screens/apikeys.jsx): what each key unlocks, its price, how to get it
    settings: [
      { key: 'heliusKey', name: 'Helius', label: 'settings.helius', hint: 'settings.helius.hint', unlocks: 'keys.helius.unlocks', price: 'free',
        url: 'https://dashboard.helius.dev', site: 'dashboard.helius.dev', steps: ['keys.helius.1', 'keys.helius.2', 'keys.helius.3'] },
    ],
  },
};
