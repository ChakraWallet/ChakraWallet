// TON in the Android app: the TON driver plus the pieces of the accounts screen that are TON's own (importing a wallet
// from another TON app, TON balances in the accounts' summary). Registered by src/mobile/tonPlugin.js.
import { ImportTon } from './import.jsx';
import { useTonSummaries } from './hooks.js';
import { tonDriver } from './driver.js';

export const tonChainDriver = {
  ...tonDriver,
  ui: {
    ImportAccount: ImportTon, importLabel: 'accounts.add.ton', importSub: 'accounts.add.ton.sub', // Accounts > Add
    // how an account imported into TON only is labelled (type, short type, its address)
    typeLabel: 'accounts.type.ton', typeShort: 'accounts.short.ton', addressLabel: 'accounts.address.ton',
    useSummaries: useTonSummaries, // TON balances in the accounts' multichain summary
    settings: [ // Settings > Data: TON Center (1 request/s without a key, 10/s with one) and TonAPI keys
      { key: 'tonCenterKey', label: 'settings.toncenter', hint: 'settings.toncenter.hint' },
      { key: 'tonApiKey', label: 'settings.tonapi', hint: 'settings.tonapi.hint' },
      { key: 'symbiosisKey', label: 'settings.symbiosis', hint: 'settings.symbiosis.hint' }, // bridges of USD₮ on TON
    ],
  },
};
