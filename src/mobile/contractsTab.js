// Contracts tab, Android app only: registered here (before the UI is loaded) so its code - editor, Solidity tools,
// contract loading - stays out of the browser extension bundle. app.jsx adds the tab when it finds it.
import { Contracts } from '../ui/screens/contracts/index.jsx';

globalThis.__CK_CONTRACTS__ = Contracts;
