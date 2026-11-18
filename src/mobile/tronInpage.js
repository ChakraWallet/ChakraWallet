// Tron in the pages of the in-app browser (Android): Chakra as a Tron wallet, the way dapps find one today -
//  - window.tron, the standard provider (TIP-1193: request({ method }), events), announced with TIP-6963;
//  - window.tronLink and window.tronWeb, the older objects most dapps (SunSwap, JustLend...) still use: tronWeb is a
//    real TronWeb, loaded only when a site uses Tron (src/mobile/tronwebPage.js, injected by the app), whose signing
//    goes to Chakra. The page never gets a key: every signature is approved on a screen of the app
//    (src/background/tronDapp.js), and a change of the account's permissions is refused there whatever the page does.
// Calls go to the app through inject.js, the same channel as window.ethereum.
import { markSvg } from '../shared/mandala.js';

(() => {
  if (window.__chakraTron) return;
  window.__chakraTron = true;
  const TO_CONTENT = 'chakra-content';
  const FROM_CONTENT = 'chakra-inpage';
  const NODES = { mainnet: 'https://api.trongrid.io', nile: 'https://nile.trongrid.io' };
  const CHAIN_IDS = { mainnet: '0x2b6653dc', nile: '0xcd8690dc' };
  let nextId = 1;
  const callbacks = new Map();
  const listeners = new Map(); // event -> Set(fn)
  let address = null, node = 'mainnet', tw = null;

  const call = (method, params) => new Promise((resolve, reject) => {
    const id = `tron_${Date.now()}_${nextId++}`;
    callbacks.set(id, { resolve, reject });
    window.postMessage({ target: TO_CONTENT, type: 'request', id, method, params }, location.origin);
  });
  const emit = (event, data) => { for (const fn of [...(listeners.get(event) || [])]) { try { fn(data); } catch (e) { console.error(e); } } };
  /** The messages TronLink posts to the page (dapps' adapters listen to them). */
  const tellPage = (action, data = {}) => window.postMessage({ message: { action, data }, isTronLink: true }, location.origin);

  // ---------------------------------------------------------------- TronWeb (loaded on demand)
  let loading = null;
  const loadTronWeb = () => (loading ||= new Promise((resolve) => {
    if (window.__ChakraTronWeb) { resolve(window.__ChakraTronWeb); return; }
    window.addEventListener('chakra-tronweb', () => resolve(window.__ChakraTronWeb), { once: true });
    window.postMessage({ target: TO_CONTENT, type: 'tronweb' }, location.origin);
  }));
  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const refuse = (message) => Object.assign(new Error(message), { code: 4200 });

  async function makeTronWeb() {
    const TronWeb = await loadTronWeb();
    const w = new TronWeb({ fullHost: NODES[node] });
    w.setAddress(address);
    // TronWeb's signing, done by Chakra: transactions by their bytes (raw_data_hex), messages as TronLink signs them
    const sign = async (tx, privateKey, useTronHeader = true, multisig = false) => {
      if (privateKey) throw refuse('Chakra never takes a private key');
      if (multisig) throw refuse('Multi-signature is not supported');
      if (typeof tx === 'string') return (await call('tron_signMessage', { message: tx, version: 1 })).signature; // old signMessage: hex
      if (!tx || typeof tx.raw_data_hex !== 'string') throw refuse('Invalid transaction');
      const r = await call('tron_signTransaction', { raw_data_hex: tx.raw_data_hex, txID: tx.txID });
      return { ...tx, signature: [...(tx.signature || []), r.signature] };
    };
    w.trx.sign = sign;
    w.trx.signTransaction = sign;
    w.trx.signMessageV2 = async (message) => {
      const hex = typeof message !== 'string';
      return (await call('tron_signMessage', { message: hex ? toHex(message) : message, version: 2, hex })).signature;
    };
    w.trx.multiSign = async () => { throw refuse('Multi-signature is not supported'); };
    w.trx._signTypedData = async () => { throw refuse('Typed-data signatures are not supported yet'); };
    w.trx.signTypedData = w.trx._signTypedData;
    return w;
  }

  /** The site's session (address and network) is known: tronWeb ready, the page told. */
  async function ready(session, announce) {
    const changed = session.address !== address || session.node !== node;
    address = session.address; node = session.node || 'mainnet';
    if (!tw || changed) tw = await makeTronWeb();
    tronLink.ready = true; tronLink.tronWeb = tw; provider.tronWeb = tw;
    try { window.tronWeb = tw; } catch { /* read-only on this page */ }
    if (announce || changed) {
      tellPage('setNode', { node: { fullNode: NODES[node], solidityNode: NODES[node], eventServer: NODES[node], chainId: CHAIN_IDS[node] } });
      tellPage('setAccount', { address });
      tellPage('accountsChanged', { address });
      tellPage('connect');
      emit('connect', { chainId: CHAIN_IDS[node] });
      emit('accountsChanged', [address]);
      emit('chainChanged', CHAIN_IDS[node]);
    }
  }
  function gone() {
    if (!address) return;
    address = null; tw = null;
    tronLink.ready = false; tronLink.tronWeb = false; provider.tronWeb = null;
    try { window.tronWeb = undefined; } catch { /* ignore */ }
    tellPage('disconnect');
    tellPage('accountsChanged', { address: false });
    emit('accountsChanged', []);
    emit('disconnect', { code: 4900, message: 'Disconnected' });
  }

  async function connect() {
    const r = await call('tron_requestAccounts', {});
    await ready(r, true);
    return [address];
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.target !== FROM_CONTENT) return;
    const d = ev.data;
    if (d.id && callbacks.has(d.id)) {
      const cb = callbacks.get(d.id);
      callbacks.delete(d.id);
      if (d.error) cb.reject(Object.assign(new Error(d.error.message || 'Chakra error'), { code: d.error.code }));
      else cb.resolve(d.result);
    } else if (d.event === 'tron' && d.data) {
      if (d.data.address) ready(d.data, true).catch(() => {}); else gone();
    }
  });

  // ---------------------------------------------------------------- window.tron (TIP-1193)
  const provider = {
    isChakra: true,
    isTronLink: true, // what dapps look for to talk to a Tron wallet (others do the same)
    tronWeb: null,
    async request({ method, params } = {}) {
      switch (method) {
        case 'eth_requestAccounts': case 'tron_requestAccounts': return connect();
        case 'eth_accounts': case 'tron_accounts': return address ? [address] : [];
        case 'eth_chainId': case 'tron_chainId': return CHAIN_IDS[node];
        case 'wallet_disconnect': case 'tron_disconnect': await call('tron_disconnect', {}); gone(); return null;
        case 'tron_signMessage': case 'personal_sign': {
          if (!address) throw Object.assign(new Error('Not connected'), { code: 4100 });
          const message = Array.isArray(params) ? params[0] : params?.message;
          return (await call('tron_signMessage', { message: String(message), version: 2 })).signature;
        }
        default: throw Object.assign(new Error(`Unsupported method: ${method}`), { code: 4200 });
      }
    },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return provider; },
    removeListener(event, fn) { listeners.get(event)?.delete(fn); return provider; },
  };
  provider.off = provider.removeListener;

  // ---------------------------------------------------------------- window.tronLink (the older interface)
  const tronLink = {
    ready: false, tronWeb: false, sunWeb: false,
    async request({ method, params } = {}) {
      if (method === 'tron_requestAccounts') {
        try { await connect(); return { code: 200, message: 'The site is already in the whitelist' }; } catch (e) { return { code: 4001, message: e?.message || 'User rejected the request.' }; }
      }
      return provider.request({ method, params });
    },
  };

  const define = (name, value) => { if (window[name] === undefined) { try { Object.defineProperty(window, name, { value, configurable: true, writable: true }); } catch { /* ignore */ } } };
  define('tron', provider);
  define('tronLink', tronLink);

  // TIP-6963: announced to the dapps already listening, and again to the ones that ask
  const info = Object.freeze({ uuid: (crypto.randomUUID && crypto.randomUUID()) || `chakra-${Date.now()}`, name: 'Chakra', icon: `data:image/svg+xml;base64,${btoa(markSvg())}`, rdns: 'dev.chakrawallet' });
  const announce = () => window.dispatchEvent(new CustomEvent('TIP6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('TIP6963:requestProvider', announce);
  announce();
  window.dispatchEvent(new Event('tronLink#initialized'));

  // a site connected before: back to it at once (tronWeb loaded only for these sites)
  if (location.protocol === 'https:') call('tron_accounts', {}).then((r) => { if (r?.address) ready(r, true); }).catch(() => {});
})();
