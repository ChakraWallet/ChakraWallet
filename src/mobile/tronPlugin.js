// Tron dapps in the Android app: window.tron, window.tronLink and tronWeb in the pages of the in-app browser
// (src/mobile/tronInpage.js, TronWeb injected by DappBrowserPlugin from src/mobile/tronwebPage.js) - requests, sessions,
// signatures and their screens. The Tron wallet itself (networks, background handlers, screens) is in
// src/background/chainModules.js and src/ui/chainModules.js, for the extension too. Loaded by the Android entry before
// the UI.
import { registerDappFamily, requestApproval, ensureUnlocked, emitToOrigin } from '../background/index.js';
import { tronDappFamily } from '../background/tronDapp.js';
import { registerApprovalViews } from '../ui/screens/approve.jsx';
import { tronApprovalViews } from '../ui/tron/approvals.jsx';

registerDappFamily(tronDappFamily({ requestApproval, ensureUnlocked, emitToOrigin }));
registerApprovalViews(tronApprovalViews);
