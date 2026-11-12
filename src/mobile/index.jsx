// Android app entry: emulated extension runtime + background + UI in a single page.
import './shim.js';
import '../background/index.js';
import './contractsTab.js'; // before the UI: the tab bar is built when app.jsx loads
import './tonPlugin.js'; // TON (GRAM): networks, background handlers, screens - before the UI too
import '../ui/index.jsx';
