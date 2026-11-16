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
import legal from './legal.js';

export default { ...base, ...core, ...manage, ...dapp, ...wallet, ...transfer, ...predict, ...contracts, ...ton, ...toncontracts, ...legal };
