// TON Connect in the pages of the in-app browser (Android): window.chakra.tonconnect, the "JS bridge" of the spec
// (github.com/ton-blockchain/ton-connect, spec/bridge.md). The TON Connect SDK of the dapps finds it through its
// walletInfo, also without the wallets registry, and isWalletBrowser tells them the page is open inside Chakra.
// Calls go to the app through inject.js, the same channel as window.ethereum; the background
// (src/background/tonconnect.js) answers with TON Connect events and responses. No TON libraries here.
import { APP_NAME, PROTOCOL_VERSION, WALLET_INFO, deviceInfo } from '../shared/ton/tonconnectInfo.js';

(() => {
  if (window[APP_NAME]?.tonconnect) return;
  const TO_CONTENT = 'chakra-content';
  const FROM_CONTENT = 'chakra-inpage';
  let nextId = 1;
  const callbacks = new Map();
  const listeners = new Set();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.target !== FROM_CONTENT) return;
    const d = ev.data;
    if (d.id && callbacks.has(d.id)) {
      const cb = callbacks.get(d.id);
      callbacks.delete(d.id);
      if (d.error) cb.reject(new Error(d.error.message || 'Chakra error'));
      else cb.resolve(d.result);
    } else if (d.event === 'tonconnect' && d.data) {
      for (const fn of [...listeners]) { try { fn(d.data); } catch (e) { console.error(e); } }
    }
  });

  const call = (method, params) => new Promise((resolve, reject) => {
    const id = `tc_${Date.now()}_${nextId++}`;
    callbacks.set(id, { resolve, reject });
    window.postMessage({ target: TO_CONTENT, type: 'request', id, method, params }, location.origin);
  });
  // the app didn't answer at all (should not happen): an "unknown error" in the spec's shape
  const connectFailed = (e) => ({ event: 'connect_error', id: Date.now(), payload: { code: 0, message: e?.message || 'Chakra is not available' } });

  const tonconnect = Object.freeze({
    // the real limit of messages comes with the connection, for the account chosen (W5: 255, older wallets: 4)
    deviceInfo: deviceInfo(255, __VERSION__),
    walletInfo: WALLET_INFO,
    protocolVersion: PROTOCOL_VERSION,
    isWalletBrowser: true,
    connect: (protocolVersion, message) => call('tonconnect_connect', { protocolVersion, request: message }).catch(connectFailed),
    restoreConnection: () => call('tonconnect_restore', {}).catch(connectFailed),
    send: (message) => call('tonconnect_send', { message }).catch((e) => ({ error: { code: 0, message: e?.message || 'Chakra is not available' }, id: message?.id })),
    listen: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  });
  try {
    Object.defineProperty(window, APP_NAME, { value: Object.freeze({ tonconnect }), configurable: false, writable: false, enumerable: true });
  } catch { /* the page took the name first: no TON Connect here */ }
})();
