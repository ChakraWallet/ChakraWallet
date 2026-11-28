// Solana in the pages (extension: with inpage.js in every page; Android app: in the in-app browser): Chakra registers
// itself as a wallet of the Wallet Standard (github.com/wallet-standard/wallet-standard), which every Solana dapp's
// wallet adapter discovers - no window.solana and no other wallet's name. Calls take the same channel as
// window.ethereum (content.js in the extension, mobile/inject.js in the app); the background
// (src/background/solanaDapp.js) answers after the user's approval. Bytes travel as base64.
import * as b58 from './shared/solana/base58.js';
import { markSvg } from './shared/mandala.js';

(() => {
  if (window.__chakraSolana) return;
  window.__chakraSolana = true;
  const TO_CONTENT = 'chakra-content';
  const FROM_CONTENT = 'chakra-inpage';
  const CHAINS = ['solana:mainnet', 'solana:devnet'];
  let nextId = 1;
  const callbacks = new Map();
  const listeners = new Set();

  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = `sol_${Date.now()}_${nextId++}`;
    callbacks.set(id, { resolve, reject });
    window.postMessage({ target: TO_CONTENT, type: 'request', id, method, params }, location.origin);
  });

  // ---------------------------------------------------------------- the account(s)
  const FEATURES_OF_ACCOUNT = ['solana:signTransaction', 'solana:signAndSendTransaction', 'solana:signMessage', 'solana:signIn'];
  class Account {
    #address;
    #publicKey;
    constructor(address) { this.#address = address; this.#publicKey = b58.decode(address); Object.freeze(this); }
    get address() { return this.#address; }
    get publicKey() { return this.#publicKey.slice(); }
    get chains() { return CHAINS.slice(); }
    get features() { return FEATURES_OF_ACCOUNT.slice(); }
    get label() { return undefined; }
    get icon() { return undefined; }
  }
  let accounts = [];
  const setAccounts = (list) => {
    const next = (list || []).map((a) => new Account(a));
    const changed = next.length !== accounts.length || next.some((a, i) => a.address !== accounts[i]?.address);
    accounts = next;
    if (changed) for (const fn of [...listeners]) { try { fn({ accounts: accounts.slice() }); } catch (e) { console.error(e); } }
  };
  const own = (account) => {
    const a = accounts.find((x) => x.address === account?.address);
    if (!a) throw new Error('Account not connected');
    return a;
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.target !== FROM_CONTENT) return;
    const d = ev.data;
    if (d.id && callbacks.has(d.id)) {
      const cb = callbacks.get(d.id);
      callbacks.delete(d.id);
      if (d.error) cb.reject(Object.assign(new Error(d.error.message || 'Chakra error'), { code: d.error.code }));
      else cb.resolve(d.result);
    } else if (d.event === 'solana' && d.data) setAccounts(d.data.accounts);
  });

  // ---------------------------------------------------------------- the features
  const connect = async ({ silent = false } = {}) => {
    const r = await call('solana_connect', { silent });
    setAccounts(r.accounts);
    return { accounts: accounts.slice() };
  };
  const disconnect = async () => { await call('solana_disconnect', {}); setAccounts([]); };

  /** One request for all the inputs that go together (same account and chain). */
  const signTransaction = async (...inputs) => {
    if (!inputs.length) return [];
    const account = own(inputs[0].account);
    const r = await call('solana_signTransaction', { chain: inputs[0].chain, transactions: inputs.map((i) => { own(i.account); return b64(i.transaction); }), address: account.address });
    return r.signed.map((s) => ({ signedTransaction: unb64(s) }));
  };
  const signAndSendTransaction = async (...inputs) => {
    if (!inputs.length) return [];
    const account = own(inputs[0].account);
    const r = await call('solana_signAndSendTransaction', { chain: inputs[0].chain, options: inputs[0].options || {}, transactions: inputs.map((i) => { own(i.account); return b64(i.transaction); }), address: account.address });
    return r.signatures.map((s) => ({ signature: b58.decode(s) }));
  };
  const signMessage = async (...inputs) => {
    const out = [];
    for (const i of inputs) {
      own(i.account);
      const r = await call('solana_signMessage', { message: b64(i.message) });
      out.push({ signedMessage: i.message, signature: unb64(r.signature) });
    }
    return out;
  };
  const signIn = async (...inputs) => {
    const out = [];
    for (const input of inputs.length ? inputs : [{}]) {
      const r = await call('solana_signIn', { input: { ...input, address: undefined } });
      setAccounts([r.address]);
      out.push({ account: accounts[0], signedMessage: unb64(r.signedMessage), signature: unb64(r.signature), signatureType: 'ed25519' });
    }
    return out;
  };

  const ICON = `data:image/svg+xml;base64,${btoa(markSvg())}`;
  const TX_VERSIONS = Object.freeze(['legacy', 0]);
  class ChakraWallet {
    // the version of the Wallet Standard interface (the standard fixes it, like the features' versions below), not Chakra's
    get version() { return '1.0.0'; }
    get name() { return 'Chakra'; }
    get icon() { return ICON; }
    get chains() { return CHAINS.slice(); }
    get accounts() { return accounts.slice(); }
    get features() {
      return {
        'standard:connect': { version: '1.0.0', connect },
        'standard:disconnect': { version: '1.0.0', disconnect },
        'standard:events': { version: '1.0.0', on: (event, fn) => { if (event !== 'change') return () => {}; listeners.add(fn); return () => listeners.delete(fn); } },
        'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: TX_VERSIONS, signTransaction },
        'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: TX_VERSIONS, signAndSendTransaction },
        'solana:signMessage': { version: '1.0.0', signMessage },
        'solana:signIn': { version: '1.0.0', signIn },
      };
    }
  }
  const wallet = new ChakraWallet();

  // registration (the standard's protocol): tell apps already listening, and answer the ones that arrive later
  const register = ({ register: reg }) => reg(wallet);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register, bubbles: false, cancelable: false, composed: false }));
  } catch (e) { console.error('Chakra: Wallet Standard registration', e); }
  window.addEventListener('wallet-standard:app-ready', (ev) => { try { register(ev.detail); } catch (e) { console.error(e); } });
})();
