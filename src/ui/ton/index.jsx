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
    // Settings > Service keys (screens/apikeys.jsx): what each key unlocks, its price, how to get it
    settings: [
      { key: 'tonCenterKey', name: 'TON Center', label: 'settings.toncenter', hint: 'settings.toncenter.hint', unlocks: 'keys.toncenter.unlocks', price: 'free', // 1 request/s without a key, 10/s with one
        url: 'https://t.me/toncenter', site: '@toncenter', steps: ['keys.toncenter.1', 'keys.toncenter.2', 'keys.toncenter.3'] },
      { key: 'tonApiKey', name: 'TonAPI', label: 'settings.tonapi', hint: 'settings.tonapi.hint', unlocks: 'keys.tonapi.unlocks', price: 'freemium',
        url: 'https://tonconsole.com', site: 'tonconsole.com', steps: ['keys.tonapi.1', 'keys.tonapi.2', 'keys.tonapi.3'] },
      { key: 'symbiosisKey', name: 'Symbiosis', label: 'settings.symbiosis', hint: 'settings.symbiosis.hint', unlocks: 'keys.symbiosis.unlocks', price: 'free', // bridges of USD₮ on TON
        url: 'https://explorer.symbiosis.finance/partners', site: 'explorer.symbiosis.finance', steps: ['keys.symbiosis.1', 'keys.symbiosis.2'] },
      { key: 'getgemsKey', name: 'Getgems', label: 'settings.getgems', hint: 'settings.getgems.hint', unlocks: 'keys.getgems.unlocks', price: 'paid', // TON NFTs: floor prices and sales
        url: 'https://getgems.io/public-api', site: 'getgems.io', steps: ['keys.getgems.1', 'keys.getgems.2', 'keys.getgems.3'] },
    ],
  },
};
