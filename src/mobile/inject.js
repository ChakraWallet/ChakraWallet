// Injected at document start in every page of the in-app browser (Android).
// It plays the role of content.js: bridges the page provider (inpage.js) and the native app.
// The native side identifies the page origin itself (it is never taken from page data).
import '../inpage.js';
import './tonconnectInpage.js'; // window.chakra.tonconnect (TON Connect), through the same channel
import './solanaInpage.js'; // Solana: Chakra as a Wallet Standard wallet, through the same channel

(() => {
  if (window.__chakraBridgeReady) return;
  window.__chakraBridgeReady = true;
  const TO_PAGE = 'chakra-inpage';
  const FROM_PAGE = 'chakra-content';
  const toPage = (m) => window.postMessage({ target: TO_PAGE, ...m }, '*');
  const toNative = (o) => { try { window.chakraBridge.postMessage(JSON.stringify(o)); } catch (e) { console.error('Chakra bridge', e); } };

  // native -> page
  Object.defineProperty(window, '__ewReceive', {
    configurable: false, writable: false,
    value: (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'response') toPage({ id: msg.id, result: msg.result, error: msg.error });
      else if (msg.type === 'event') toPage({ event: msg.event, data: msg.data });
      else if (msg.type === 'config') toPage({ config: { metamaskCompat: msg.metamaskCompat } });
    },
  });

  // page -> native
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.target !== FROM_PAGE) return;
    const d = ev.data;
    if (d.type === 'hello') toPage({ ready: true });
    else if (d.type === 'config') toNative({ type: 'config' });
    else if (d.type === 'dapp') toNative({ type: 'dapp' });
    else if (d.type === 'request') toNative({ type: 'request', id: d.id, method: String(d.method), params: d.params });
  });
  toPage({ ready: true });
})();
