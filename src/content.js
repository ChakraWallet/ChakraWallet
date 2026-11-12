// Content script (isolated world): bridge between the page provider (inpage.js) and the background.
const ext = globalThis.browser ?? globalThis.chrome;
const TO_PAGE = 'chakra-inpage';
const FROM_PAGE = 'chakra-content';

let port = null;
const inflight = new Map(); // id -> message (re-sent if the service worker restarts)

function connect() {
  port = ext.runtime.connect({ name: 'chakra-content' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'response') {
      inflight.delete(msg.id);
      window.postMessage({ target: TO_PAGE, id: msg.id, result: msg.result, error: msg.error }, location.origin);
    } else if (msg.type === 'event') {
      window.postMessage({ target: TO_PAGE, event: msg.event, data: msg.data }, location.origin);
    } else if (msg.type === 'config') {
      window.postMessage({ target: TO_PAGE, config: { metamaskCompat: msg.metamaskCompat } }, location.origin);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // Background restarted (MV3). Reconnect lazily; pending approvals were lost -> report error.
    for (const [id] of inflight) {
      window.postMessage({ target: TO_PAGE, id, error: { code: -32603, message: 'The wallet was restarted, please try again' } }, location.origin);
    }
    inflight.clear();
  });
}

function send(msg) {
  if (!port) connect();
  try { port.postMessage(msg); } catch { connect(); port.postMessage(msg); }
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.target !== FROM_PAGE) return;
  const d = ev.data;
  if (d.type === 'hello') { window.postMessage({ target: TO_PAGE, ready: true }, location.origin); return; }
  if (d.type === 'config') { send({ type: 'config' }); return; }
  if (d.type === 'request') {
    const msg = { type: 'request', id: d.id, method: String(d.method), params: d.params };
    inflight.set(d.id, msg);
    send(msg);
  }
});

// wallet events (accountsChanged, chainChanged) broadcast by the background to every tab
ext.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'event') window.postMessage({ target: TO_PAGE, event: msg.event, data: msg.data }, location.origin);
});

// keep the service worker alive while a page is open and a request is in flight
setInterval(() => { if (port && inflight.size) { try { port.postMessage({ type: 'ping' }); } catch { /* ignore */ } } }, 20000);

// announce readiness (in case the page script loaded first)
window.postMessage({ target: TO_PAGE, ready: true }, location.origin);
