// Injected in the page (MAIN world): EIP-1193 provider exposed as window.ethereum (MetaMask compatible)
// and announced via EIP-6963 (multi-wallet discovery).
import { markSvg } from './shared/mandala.js';

(() => {
  if (window.chakraWallet) return;
  const TO_CONTENT = 'chakra-content';
  const FROM_CONTENT = 'chakra-inpage';
  const ICON = 'data:image/svg+xml;base64,' + btoa(markSvg()); // the app's mandala (src/shared/mandala.js)

  let nextId = 1;
  const callbacks = new Map();
  // Handshake with the content script (the two scripts may load in any order)
  let ready = false;
  const queue = [];
  // The page looks for a wallet (EIP-6963 discovery) or talks to the provider: it is a dapp.
  // Used by the Android in-app browser to open dapps in their desktop version; ignored by the extension.
  let dappSignaled = false;
  function dappSeen() { if (!dappSignaled) { dappSignaled = true; post({ target: TO_CONTENT, type: 'dapp' }); } }
  const post = (msg) => { if (ready) window.postMessage(msg, location.origin); else queue.push(msg); };

  class EventEmitter {
    constructor() { this._ev = new Map(); }
    on(e, fn) { if (!this._ev.has(e)) this._ev.set(e, new Set()); this._ev.get(e).add(fn); return this; }
    addListener(e, fn) { return this.on(e, fn); }
    once(e, fn) { const w = (...a) => { this.removeListener(e, w); fn(...a); }; return this.on(e, w); }
    removeListener(e, fn) { this._ev.get(e)?.delete(fn); return this; }
    off(e, fn) { return this.removeListener(e, fn); }
    removeAllListeners(e) { if (e) this._ev.delete(e); else this._ev.clear(); return this; }
    listenerCount(e) { return this._ev.get(e)?.size || 0; }
    emit(e, ...args) {
      for (const fn of [...(this._ev.get(e) || [])]) { try { fn(...args); } catch (err) { console.error(err); } }
      return true;
    }
  }

  function rpcError(err) {
    const e = new Error(err?.message || 'Unknown error');
    e.code = err?.code ?? -32603;
    if (err?.data !== undefined) e.data = err.data;
    return e;
  }

  class ChakraProvider extends EventEmitter {
    constructor() {
      super();
      this.isMetaMask = true; // drop-in replacement: dapps that look for MetaMask will use Chakra
      this.isChakra = true;
      this.chainId = null;
      this.networkVersion = null;
      this.selectedAddress = null;
      this._connected = false;
      this._unlocked = false;
      this._metamask = {
        isUnlocked: async () => this._unlocked || (await this.request({ method: 'chakra_init' })).isUnlocked,
        requestBatch: async (reqs) => Promise.all(reqs.map((r) => this.request(r))),
      };
      this.request = this.request.bind(this);
      this.send = this.send.bind(this);
      this.sendAsync = this.sendAsync.bind(this);
      this.enable = this.enable.bind(this);
    }

    request(args) {
      if (!args || typeof args !== 'object' || typeof args.method !== 'string') {
        return Promise.reject(rpcError({ code: -32600, message: 'request() richiede { method, params }' }));
      }
      const { method, params } = args;
      return new Promise((resolve, reject) => {
        const id = `ew_${Date.now()}_${nextId++}`;
        callbacks.set(id, { resolve, reject, method });
        dappSeen();
        post({ target: TO_CONTENT, type: 'request', id, method, params: params ?? [] });
      });
    }

    isConnected() { return true; }
    enable() { return this.request({ method: 'eth_requestAccounts' }); }

    // legacy web3 0.x style
    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') return this.request({ method: methodOrPayload, params: paramsOrCallback });
      if (typeof paramsOrCallback === 'function') return this.sendAsync(methodOrPayload, paramsOrCallback);
      const p = methodOrPayload;
      const sync = { eth_accounts: () => (this.selectedAddress ? [this.selectedAddress] : []), eth_coinbase: () => this.selectedAddress, net_version: () => this.networkVersion, eth_chainId: () => this.chainId };
      if (sync[p?.method]) return { id: p.id, jsonrpc: '2.0', result: sync[p.method]() };
      throw new Error(`Metodo sincrono non supportato: ${p?.method}`);
    }

    sendAsync(payload, cb) {
      if (Array.isArray(payload)) {
        Promise.all(payload.map((p) => this.request(p).then((result) => ({ id: p.id, jsonrpc: '2.0', result }), (error) => ({ id: p.id, jsonrpc: '2.0', error }))))
          .then((r) => cb(null, r));
        return;
      }
      this.request(payload).then(
        (result) => cb(null, { id: payload.id, jsonrpc: '2.0', result }),
        (error) => cb(error, { id: payload.id, jsonrpc: '2.0', error }),
      );
    }

    _setAccounts(accounts) {
      const prev = this.selectedAddress;
      this.selectedAddress = accounts[0] || null;
      if (prev !== this.selectedAddress || accounts.length === 0) this.emit('accountsChanged', accounts);
    }

    _setChain(chainId) {
      if (chainId === this.chainId) return;
      const first = this.chainId === null;
      this.chainId = chainId;
      this.networkVersion = String(parseInt(chainId, 16));
      if (!first) { this.emit('chainChanged', chainId); this.emit('networkChanged', this.networkVersion); }
    }
  }

  const provider = new ChakraProvider();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.target !== FROM_CONTENT) return;
    const d = ev.data;
    if (d.ready) {
      if (!ready) { ready = true; queue.splice(0).forEach((m) => window.postMessage(m, location.origin)); }
      return;
    }
    if (d.id && callbacks.has(d.id)) {
      const cb = callbacks.get(d.id);
      callbacks.delete(d.id);
      if (d.error) return cb.reject(rpcError(d.error));
      if (cb.method === 'eth_requestAccounts' || cb.method === 'eth_accounts') provider._setAccounts(d.result || []);
      if (cb.method === 'eth_chainId' && d.result) provider._setChain(d.result);
      return cb.resolve(d.result);
    }
    if (d.event === 'accountsChanged') provider._setAccounts(d.data || []);
    else if (d.event === 'chainChanged') provider._setChain(d.data);
    else if (d.config) announceMetaMaskAlias(d.config.metamaskCompat);
  });

  // initial state
  provider.request({ method: 'chakra_init' }).then((s) => {
    provider._setChain(s.chainId);
    provider._unlocked = s.isUnlocked;
    provider.selectedAddress = s.accounts[0] || null;
    provider._connected = true;
    provider.emit('connect', { chainId: s.chainId });
  }).catch(() => {});

  // ---- window.ethereum
  const proxied = new Proxy(provider, { deleteProperty: () => true }); // some dapps try to delete props
  try {
    Object.defineProperty(window, 'ethereum', { configurable: true, enumerable: true, get: () => proxied, set: () => {} });
  } catch {
    window.ethereum = proxied;
  }
  Object.defineProperty(window, 'chakraWallet', { value: proxied, configurable: false, writable: false });
  window.dispatchEvent(new Event('ethereum#initialized'));

  // ---- EIP-6963
  const uuid = crypto.randomUUID();
  const details = [Object.freeze({ info: Object.freeze({ uuid, name: 'Chakra', icon: ICON, rdns: 'dev.chakrawallet' }), provider: proxied })];
  const announce = () => details.forEach((d) => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: d })));
  window.addEventListener('eip6963:requestProvider', () => { dappSeen(); announce(); });
  announce();

  // In "MetaMask mode" Chakra also answers when the site's wallet list shows "MetaMask".
  let aliasDone = false;
  function announceMetaMaskAlias(enabled) {
    if (!enabled || aliasDone) return;
    aliasDone = true;
    details.push(Object.freeze({ info: Object.freeze({ uuid: crypto.randomUUID(), name: 'MetaMask', icon: ICON, rdns: 'io.metamask' }), provider: proxied }));
    announce();
  }
  post({ target: TO_CONTENT, type: 'config' });
  window.postMessage({ target: TO_CONTENT, type: 'hello' }, location.origin);
})();
