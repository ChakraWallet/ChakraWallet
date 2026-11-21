// Solana dapps of the in-app browser (Android app, registered by src/mobile/solanaPlugin.js): the wallet side of the
// Wallet Standard (src/mobile/solanaInpage.js is the page's side). Requests arrive with the page origin, which Android
// gives (never the page). One session per site, bound to one account of the active wallet; a silent reconnection
// only when nothing has to be signed. Every signature (transactions, messages, sign-in) is approved on a screen and
// needs the password or the fingerprint.
import * as vault from './vault.js';
import { local } from '../shared/ext.js';
import { isChainEnabled } from '../shared/chains.js';
import { i18nError } from '../shared/i18n.js';
import { SOL_MAINNET, SOL_DEVNET, sendRaw, SOL_CHAINS } from '../shared/solana/api.js';
import { parseTransaction } from '../shared/solana/tx.js';
import { fromBase64, toBase64, utf8 } from '../shared/solana/core.js';
import * as b58 from '../shared/solana/base58.js';
import { keyOf, signWith, signMessageWith } from './solana.js';
import { signInText } from '../shared/solana/siws.js';

const KEY = 'solanaSites'; // { [origin]: { account, address, since } }
export const CHAINS = { 'solana:mainnet': SOL_MAINNET, 'solana:devnet': SOL_DEVNET };
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return ''; } };
const MAX_TXS = 20; // transactions in one request (signAllTransactions)

const sessions = () => local.get(KEY, {});
async function sessionOf(origin) {
  const s = (await sessions())[origin];
  if (!s) return null;
  const { accounts } = await vault.view();
  return accounts.some((a) => a.address === s.account) ? s : null;
}
const chainOf = (name) => {
  const id = CHAINS[name || 'solana:mainnet'];
  if (!id) throw Object.assign(new Error(`Unsupported chain ${name}`), { code: 4100 });
  return id;
};

/**
 * Transactions from a dapp (base64): read (so a broken one is refused here), at most MAX_TXS, each one to be signed by
 * the session's address. Also used by WalletConnect (src/background/walletconnect.js).
 */
export function readTxs(list, address) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_TXS) throw Object.assign(new Error('Bad transactions'), { code: -32602 });
  return list.map((x) => {
    let tx;
    try { tx = parseTransaction(fromBase64(String(x))); } catch (e) { throw Object.assign(new Error(`Unreadable transaction: ${e.message}`), { code: -32602 }); }
    if (!tx.msg.keys.slice(0, tx.msg.header.signatures).includes(address)) throw Object.assign(new Error('The transaction is not for the connected account'), { code: -32602 });
    return String(x);
  });
}

/**
 * The Solana "dapp family" for src/background/index.js (registerDappFamily).
 * kit: { requestApproval(origin, kind, params, tab), ensureUnlocked(origin, tab), emitToOrigin(origin, event, data) }.
 */
export function solanaDappFamily({ requestApproval, ensureUnlocked, emitToOrigin }) {
  const tell = (origin, accounts) => emitToOrigin(origin, 'solana', { accounts }).catch(() => {});

  async function connected(origin) {
    const s = await sessionOf(origin);
    if (!s) throw Object.assign(new Error('Not connected: call connect first'), { code: 4100 });
    return s;
  }
  async function checkChain(name) {
    const id = chainOf(name);
    if (!isChainEnabled(id, await local.get('settings', {}))) throw new Error('This network is turned off in Chakra');
    return id;
  }

  async function handle(origin, method, p = {}, tab) {
    if (!origin.startsWith('https://')) throw Object.assign(new Error('Solana works only on secure (https) sites'), { code: 4100 });
    switch (method) {
      case 'solana_connect': {
        const s = await sessionOf(origin);
        if (s && (await vault.isUnlocked())) return { accounts: [s.address] };
        if (p.silent) return { accounts: [] }; // the page only asks whether it is still connected
        await ensureUnlocked(origin, tab);
        const again = await sessionOf(origin);
        if (again) return { accounts: [again.address] };
        return requestApproval(origin, 'solConnect', { current: null }, tab);
      }
      case 'solana_disconnect': {
        await local.update(KEY, {}, (all) => { const n = { ...all }; delete n[origin]; return n; });
        return true;
      }
      case 'solana_accounts': {
        const s = await sessionOf(origin);
        return { accounts: s && (await vault.isUnlocked()) ? [s.address] : [] };
      }
      case 'solana_signTransaction':
      case 'solana_signAndSendTransaction': {
        const s = await connected(origin);
        const chainId = await checkChain(p.chain);
        const txs = readTxs(p.transactions, s.address);
        await ensureUnlocked(origin, tab);
        const send = method === 'solana_signAndSendTransaction';
        return requestApproval(origin, send ? 'solTxSend' : 'solTx', { account: s.account, address: s.address, chainId, txs, send, options: p.options || {} }, tab);
      }
      case 'solana_signMessage': {
        const s = await connected(origin);
        if (typeof p.message !== 'string' || p.message.length > 20000) throw Object.assign(new Error('Bad message'), { code: -32602 });
        await ensureUnlocked(origin, tab);
        return requestApproval(origin, 'solSignMessage', { account: s.account, address: s.address, message: p.message }, tab);
      }
      case 'solana_signIn': {
        await ensureUnlocked(origin, tab);
        const input = p.input && typeof p.input === 'object' ? p.input : {};
        const host = hostOf(origin);
        // the domain is the page's: a request naming another site is refused (phishing)
        if (input.domain && input.domain !== host) throw Object.assign(new Error(`Sign-in domain ${input.domain} does not match the site ${host}`), { code: -32602 });
        const s = await sessionOf(origin);
        return requestApproval(origin, 'solSignIn', { current: s?.account || null, input: { ...input, domain: host } }, tab);
      }
      default: throw Object.assign(new Error(`Unknown Solana call: ${method}`), { code: 4200 });
    }
  }

  // ---------------------------------------------------------------- after the user's OK
  async function remember(origin, account) {
    const k = await keyOf(account);
    if (!k) throw i18nError('errors.accountUnavailable');
    await local.update(KEY, {}, (all) => ({ ...all, [origin]: { account, address: k.address, since: all[origin]?.account === account ? all[origin].since : Date.now() } }));
    return k.address;
  }
  async function completeConnect(p, data) {
    const address = await remember(p.origin, data.account);
    tell(p.origin, [address]);
    return { accounts: [address] };
  }
  async function completeTx(p) {
    const { account, txs, send, chainId, options } = p.params;
    const signed = await signWith(account, txs);
    if (!send) return { signed: signed.txs };
    const chain = SOL_CHAINS[chainId];
    const out = [];
    for (const tx of signed.txs) out.push(await sendRaw(chain, fromBase64(tx), { skipPreflight: !!options?.skipPreflight }));
    return { signatures: out };
  }
  async function completeSignMessage(p) {
    const sig = await signMessageWith(p.params.account, p.params.message);
    return { signature: toBase64(b58.decode(sig)) };
  }
  async function completeSignIn(p, data) {
    const address = await remember(p.origin, data.account);
    const text = signInText({ ...p.params.input, address });
    const bytes = utf8(text);
    const sig = await signMessageWith(data.account, toBase64(bytes));
    tell(p.origin, [address]);
    return { address, signedMessage: toBase64(bytes), signature: toBase64(b58.decode(sig)) };
  }

  return {
    prefix: 'solana_',
    handle,
    approvals: {
      solConnect: { auth: () => false, complete: completeConnect },
      solTx: { auth: () => true, complete: completeTx }, // sign only: the site sends it
      solTxSend: { auth: () => true, complete: completeTx }, // sign and send
      solSignMessage: { auth: () => true, complete: completeSignMessage },
      solSignIn: { auth: () => true, complete: completeSignIn },
    },
    /** getState: the sites connected with an account of the active wallet (Settings, padlock of the browser). */
    async state(view) {
      const mine = new Set(view.accounts.map((a) => a.address));
      const list = Object.entries(await sessions()).filter(([, s]) => mine.has(s.account));
      return { solSites: Object.fromEntries(list.map(([site, s]) => [site, { account: s.account, address: s.address, since: s.since, host: hostOf(site) }])) };
    },
    /** The user disconnects the site: the session goes and the page is told. */
    async disconnect(origin) {
      if (!(await sessions())[origin]) return;
      await local.update(KEY, {}, (all) => { const n = { ...all }; delete n[origin]; return n; });
      tell(origin, []);
    },
  };
}
