// Bitcoin in the interface: the Bitcoin driver plus the pieces of the screens that are Bitcoin's own - receiving with
// a choice of address type, the account's addresses / coins / export page, importing a wallet from another Bitcoin
// app, sending an inscription, Bitcoin balances in the accounts' summary, the UniSat key. Registered by
// src/ui/chainModules.js.
import { btcDriver } from './driver.js';
import { btcBridge } from './bridge.js';
import { BtcFee } from './fee.jsx';
import { setFeeComponent } from './plan.js';
import { BtcReceive } from './receive.jsx';
import { BtcHomeExtra, BtcWallet } from './wallet.jsx';
import { ImportBitcoin } from './import.jsx';
import { BtcNftActions, BtcSendInscription } from './ordinals.jsx';
import { useBtcSummaries } from './hooks.js';

setFeeComponent(BtcFee);

export const btcChainDriver = {
  ...btcDriver,
  bridge: btcBridge,
  ui: {
    ImportAccount: ImportBitcoin, importLabel: 'accounts.add.btc', importSub: 'accounts.add.btc.sub', // Accounts > Add
    typeLabel: 'accounts.type.btc', typeShort: 'accounts.short.btc', addressLabel: 'accounts.address.btc',
    useSummaries: useBtcSummaries, // Bitcoin balances in the accounts' multichain summary
    Receive: BtcReceive, // SegWit or Taproot, a new address on request
    HomeExtra: BtcHomeExtra, // the home's card: what's on its way in, the addresses and coins page
    NftActions: BtcNftActions, // an inscription's page: send it
    screens: { btcWallet: BtcWallet, btcSendInscription: BtcSendInscription },
    // Settings > Service keys (screens/apikeys.jsx): what each key unlocks, its price, how to get it
    settings: [
      { key: 'unisatKey', name: 'UniSat', label: 'settings.unisat', hint: 'settings.unisat.hint', unlocks: 'keys.unisat.unlocks', price: 'free',
        url: 'https://developer.unisat.io/', site: 'developer.unisat.io', steps: ['keys.unisat.1', 'keys.unisat.2', 'keys.unisat.3'] },
    ],
  },
};
