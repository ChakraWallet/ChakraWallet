// TON (coin: GRAM) in the Android app: the TON networks, the background handlers (keys, signing), the driver the
// shared screens use for TON (balances, history, sends, swaps, bridges) and TON Connect (dapps of the in-app browser,
// QR codes, links that open the app).
// Loaded by the Android entry before the UI; not part of the browser extension.
import '../shared/ton/buffer.js';
import { registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { registerChains } from '../shared/chains.js';
import { registerUiHandlers, registerDappFamily, requestApproval, ensureUnlocked, emitToOrigin } from '../background/index.js';
import { tonConnectFamily } from '../background/tonconnect.js';
import { registerApprovalViews } from '../ui/screens/approve.jsx';
import { tonApprovalViews } from '../ui/ton/approvals.jsx';
import { registerConnector } from '../ui/connectors.js';
import { parseConnectLink } from '../shared/ton/tonconnectBridge.js';
import { TON_CHAINS, setTonCenterKey } from '../shared/ton/api.js';
import { setTonApiKey } from '../shared/ton/tonapi.js';
import { setSymbiosisKey } from '../shared/ton/bridge.js';
import { tonHandlers } from '../background/ton.js';
import { tonChainDriver } from '../ui/ton/index.jsx';
import { registerDriver } from '../ui/chains/index.js';
import { bg, ext, local } from '../shared/ext.js';
import { t } from '../shared/i18n.js';

registerChains(Object.values(TON_CHAINS));
registerUiHandlers(tonHandlers);
registerDriver(tonChainDriver);

// optional TON Center, TonAPI and Symbiosis keys (Settings > Data)
const keys = (s) => { setTonCenterKey(s?.tonCenterKey); setTonApiKey(s?.tonApiKey); setSymbiosisKey(s?.symbiosisKey); };
local.get('settings', {}).then(keys);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) keys(changes.settings.newValue); });

// ---------------------------------------------------------------- TON Connect
// requests, sessions and signatures (in-app browser and bridge), and their approval screens
const tonConnect = tonConnectFamily({ requestApproval, ensureUnlocked, emitToOrigin });
registerDappFamily(tonConnect);
registerUiHandlers(tonConnect.uiHandlers);
registerApprovalViews(tonApprovalViews);

/** After a TON Connect link: a toast with how it went. */
function told(r) {
  if (r.connected) globalThis.__CK_toast?.(t('tonconnect.link.connected', { name: r.name }));
  else if (r.error && r.code !== 300) globalThis.__CK_toast?.(t('tonconnect.link.failed', { reason: r.error }), 'warn'); // 300: the user said no
}

// "Connect with QR" (wallet card, Settings): a tc:// code shown by a dapp on another screen
registerConnector({
  match: (text) => parseConnectLink(text)?.kind === 'connect',
  open: async (text) => told(await bg('tonConnectLink', { url: text })),
});

// Links that open the app (tc://, chakra-tc://, https://chakrawallet.dev/ton-connect): a connection, or a dapp that
// brings Chakra up for a request already on its way through the bridge. Then back to the app that asked (`ret`):
// 'back' sends Chakra behind it, a link opens it, 'none' stays here.
const Os = registerPlugin('Os');
const returnTo = (ret) => {
  if (ret === 'back') Os.moveToBack().catch(() => {});
  else if (ret && ret !== 'none') Os.openLink({ url: ret }).catch(() => {});
};
let waiting = null; // { ret, until }: where to go once the request the dapp opened Chakra for is answered
tonConnect.onAnswered(() => {
  if (!waiting) return;
  const { ret, until } = waiting;
  waiting = null;
  if (Date.now() < until) returnTo(ret);
});
async function openedWith(url) {
  const link = parseConnectLink(url);
  if (!link) return;
  if (link.kind === 'open') waiting = { ret: link.ret, until: Date.now() + 5 * 60e3 };
  const r = await bg('tonConnectLink', { url }).catch((e) => ({ connected: false, error: e.message }));
  if (link.kind !== 'connect') return;
  told(r);
  if (r.connected || r.code === 300) returnTo(link.ret);
}
CapApp.addListener('appUrlOpen', (e) => { openedWith(e.url); });
Promise.resolve(CapApp.getLaunchUrl?.()).then((r) => { if (r?.url) openedWith(r.url); }).catch(() => {});
