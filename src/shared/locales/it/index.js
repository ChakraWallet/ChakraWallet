// Dictionary parts (one per area of the app). Keys are namespaced: 'common.*', 'send.*', ...
import base from './base.js';
import core from './core.js';
import manage from './manage.js';
import dapp from './dapp.js';
import wallet from './wallet.js';
import transfer from './transfer.js';
import predict from './predict.js';
import contracts from './contracts.js';
import ton from './ton.js';
import toncontracts from './toncontracts.js';
import tonconnect from './tonconnect.js';
import walletconnect from './walletconnect.js';
import solana from './solana.js';
import solcontracts from './solcontracts.js';
import tron from './tron.js';
import bitcoin from './bitcoin.js';
import legal from './legal.js';
import mmcard from './mmcard.js';
import crash from './crash.js';

export default { ...base, ...core, ...manage, ...dapp, ...wallet, ...transfer, ...predict, ...contracts, ...ton, ...toncontracts, ...tonconnect, ...walletconnect, ...solana, ...solcontracts, ...tron, ...bitcoin, ...legal, ...mmcard, ...crash };
