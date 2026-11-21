// WalletConnect in the Android app: dapps outside the app (Ethereum and its family, Solana, Tron) connect through
// WalletConnect's relay - from a QR code ("Connect with QR"), a link pasted in Settings > Connected sites, or a link
// that opens the app (wc:, chakra-wc://). The protocol is in src/background/walletconnect.js, its connection screen in
// src/ui/walletconnect/approvals.jsx; the dapp's requests use the screens every dapp uses.
// Loaded by the Android entry after the families it serves (Solana, Tron), before the UI; not part of the extension.
import { registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { registerUiHandlers, registerDappFamily, requestApproval, ensureUnlocked } from '../background/index.js';
import { walletConnectFamily } from '../background/walletconnect.js';
import { registerApprovalViews } from '../ui/screens/approve.jsx';
import { walletConnectApprovalViews } from '../ui/walletconnect/approvals.jsx';
import { registerConnector } from '../ui/connectors.js';
import { parseWcLink } from '../shared/walletconnect/uri.js';
import { bg } from '../shared/ext.js';
import { t } from '../shared/i18n.js';

const wc = walletConnectFamily({ requestApproval, ensureUnlocked });
registerDappFamily(wc);
registerUiHandlers(wc.uiHandlers);
registerApprovalViews(walletConnectApprovalViews);

/** After a code or a link: a toast with how it went. */
function told(r) {
  if (r.connected) globalThis.__CK_toast?.(t('wc.link.connected', { name: r.name }));
  else if (r.error && r.code !== 300) globalThis.__CK_toast?.(t('wc.link.failed', { reason: r.error }), 'warn'); // 300: the user said no
}
const connect = (url) => bg('walletConnectLink', { url }).catch((e) => ({ connected: false, error: e.message }));

// "Connect with QR" (wallet card of these networks, Settings) and the link pasted in Settings
registerConnector({
  families: ['evm', 'solana', 'tron'],
  match: (text) => parseWcLink(text)?.kind === 'pair',
  open: async (text) => {
    const r = await bg('walletConnectLink', { url: text });
    told(r);
  },
});

// Links that open the app: a connection (wc:… on the phone, chakra-wc://wc?uri=…), or a dapp that brings Chakra up
// for a request already on its way through the relay (chakra-wc:// alone: Chakra's redirect in its metadata). Then
// back to the app that asked: Chakra goes behind it once the connection or the request is answered.
const Os = registerPlugin('Os');
const back = () => Os.moveToBack().catch(() => {});
let waiting = 0; // until when a request the dapp opened Chakra for sends the user back
wc.onAnswered(() => { if (Date.now() < waiting) { waiting = 0; back(); } });
async function openedWith(url) {
  const link = parseWcLink(url);
  if (!link) return;
  if (link.kind === 'open') waiting = Date.now() + 5 * 60e3;
  const r = await connect(url);
  if (link.kind !== 'pair') return;
  told(r);
  if (r.connected || r.code === 300) back();
}
CapApp.addListener('appUrlOpen', (e) => { openedWith(e.url); });
Promise.resolve(CapApp.getLaunchUrl?.()).then((r) => { if (r?.url) openedWith(r.url); }).catch(() => {});
// the same links in a page of the in-app browser (DappBrowserPlugin): handled here, the user stays on the page
globalThis.__CK_NATIVE__?.addListener('walletConnectLink', async (e) => {
  const link = parseWcLink(e.url);
  if (link?.kind !== 'pair') return;
  told(await connect(e.url));
});
