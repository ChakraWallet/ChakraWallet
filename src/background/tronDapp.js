// Tron dapps of the in-app browser (Android app, registered by src/mobile/tronPlugin.js): the wallet side of
// window.tron / window.tronLink / tronWeb (src/mobile/tronInpage.js is the page's side). Requests arrive with the page
// origin, which Android gives (never the page). One session per site, bound to one account of the active wallet and a
// network (mainnet or Nile). Every signature is approved on a screen and needs the password or the fingerprint; a
// transaction is read from its bytes and must be the session account's own. A change of the account's permissions
// (how scams on Tron take accounts over) is never signed: the user is shown what the site tried, and it is refused.
import * as vault from './vault.js';
import { local } from '../shared/ext.js';
import { isChainEnabled } from '../shared/chains.js';
import { i18nError } from '../shared/i18n.js';
import { TRON_MAINNET, TRON_NILE } from '../shared/tron/api.js';
import { decodeRawData } from '../shared/tron/proto.js';
import { keyOf, signWith, signMessageWith, FORBIDDEN } from './tron.js';

const KEY = 'tronSites'; // { [origin]: { account, address, node, since } }
export const NODE_CHAINS = { mainnet: TRON_MAINNET, nile: TRON_NILE };
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return ''; } };
const MAX_TX_HEX = 400_000; // a contract deploy is the largest transaction a dapp asks for

const sessions = () => local.get(KEY, {});
async function sessionOf(origin) {
  const s = (await sessions())[origin];
  if (!s) return null;
  const { accounts } = await vault.view();
  return accounts.some((a) => a.address === s.account) ? s : null;
}
const bad = (message) => Object.assign(new Error(message), { code: -32602 });
export const rejected = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });

/**
 * A transaction from a dapp ({ raw_data_hex, txID? }), read from its bytes -> { raw, d (decoded), forbidden }. The id
 * the dapp shows must be the one of these bytes (it can't make the user approve one thing and sign another). Unless
 * it changes the account's permissions (forbidden: never signed, the caller explains it), it must be the address's own
 * and single-signature. Also used by WalletConnect (src/background/walletconnect.js).
 */
export function readTx(p, address) {
  const raw = String(p?.raw_data_hex || '').toLowerCase();
  if (!raw || raw.length > MAX_TX_HEX || raw.length % 2 || /[^0-9a-f]/.test(raw)) throw bad('Bad transaction');
  let d;
  try { d = decodeRawData(raw); } catch (e) { throw bad(`Unreadable transaction: ${e.message}`); }
  if (p.txID && String(p.txID).toLowerCase() !== d.txID) throw bad('The transaction id does not match its bytes');
  const forbidden = d.contracts.some((c) => FORBIDDEN.has(c.type));
  if (!forbidden) {
    if (d.contracts.some((c) => c.parameter?.owner_address !== address)) throw bad('The transaction is not for the connected account');
    if (d.contracts.some((c) => c.permissionId)) throw bad('Multi-signature transactions are not supported');
  }
  return { raw, d, forbidden };
}

/**
 * The Tron "dapp family" for src/background/index.js (registerDappFamily).
 * kit: { requestApproval(origin, kind, params, tab), ensureUnlocked(origin, tab), emitToOrigin(origin, event, data) }.
 */
export function tronDappFamily({ requestApproval, ensureUnlocked, emitToOrigin }) {
  const tell = (origin, s) => emitToOrigin(origin, 'tron', s ? { address: s.address, node: s.node } : { address: null }).catch(() => {});

  async function connected(origin) {
    const s = await sessionOf(origin);
    if (!s) throw Object.assign(new Error('Not connected: request the accounts first'), { code: 4100 });
    if (!isChainEnabled(NODE_CHAINS[s.node] ?? TRON_MAINNET, await local.get('settings', {}))) throw new Error('This network is turned off in Chakra');
    return s;
  }

  async function handle(origin, method, p = {}, tab) {
    if (!origin.startsWith('https://')) throw Object.assign(new Error('Tron works only on secure (https) sites'), { code: 4100 });
    switch (method) {
      case 'tron_requestAccounts': {
        const s = await sessionOf(origin);
        if (s && (await vault.isUnlocked())) return { address: s.address, node: s.node };
        await ensureUnlocked(origin, tab);
        const again = await sessionOf(origin);
        if (again) return { address: again.address, node: again.node };
        return requestApproval(origin, 'tronConnect', { current: null }, tab);
      }
      case 'tron_accounts': {
        const s = await sessionOf(origin);
        return s && (await vault.isUnlocked()) ? { address: s.address, node: s.node } : { address: null };
      }
      case 'tron_disconnect': {
        await local.update(KEY, {}, (all) => { const n = { ...all }; delete n[origin]; return n; });
        return true;
      }
      case 'tron_signTransaction': {
        const s = await connected(origin);
        const { raw, d, forbidden } = readTx(p, s.address);
        await ensureUnlocked(origin, tab);
        if (forbidden) {
          // never signed: the screen explains what the site tried, and only lets the user close it
          await requestApproval(origin, 'tronBlocked', { account: s.account, address: s.address, contracts: d.contracts.map((c) => c.type) }, tab).catch(() => {});
          throw rejected();
        }
        return requestApproval(origin, 'tronTx', { account: s.account, address: s.address, node: s.node, raw }, tab);
      }
      case 'tron_signMessage': {
        const s = await connected(origin);
        const message = String(p.message ?? '');
        const version = Number(p.version) === 1 ? 1 : 2;
        if (!message || message.length > 20000) throw bad('Bad message');
        const hex = version === 1 || !!p.hex;
        if (hex && !/^(0x)?([0-9a-f]{2})+$/i.test(message)) throw bad('Bad message: hex expected');
        await ensureUnlocked(origin, tab);
        return requestApproval(origin, 'tronSignMessage', { account: s.account, address: s.address, message, hex, version }, tab);
      }
      default: throw Object.assign(new Error(`Unknown Tron call: ${method}`), { code: 4200 });
    }
  }

  // ---------------------------------------------------------------- after the user's OK
  async function completeConnect(p, data) {
    const k = await keyOf(data.account);
    if (!k) throw i18nError('errors.accountUnavailable');
    const node = data.node === 'nile' ? 'nile' : 'mainnet';
    const s = { account: data.account, address: k.address, node };
    await local.update(KEY, {}, (all) => ({ ...all, [p.origin]: { ...s, since: all[p.origin]?.account === data.account ? all[p.origin].since : Date.now() } }));
    tell(p.origin, s);
    return { address: k.address, node };
  }
  async function completeTx(p) {
    const r = await signWith(p.params.account, [p.params.raw]); // checked again there: owner, no permission change
    return { signature: r.signatures[0], txID: r.txIDs[0] };
  }
  async function completeSignMessage(p) {
    const { account, message, hex, version } = p.params;
    return { signature: await signMessageWith(account, { message: hex ? message.replace(/^0x/i, '') : message, hex, version }) };
  }

  return {
    prefix: 'tron_',
    handle,
    approvals: {
      tronConnect: { auth: () => false, complete: completeConnect },
      tronTx: { auth: () => true, complete: completeTx },
      tronSignMessage: { auth: () => true, complete: completeSignMessage },
      tronBlocked: { auth: () => false, complete: () => { throw rejected(); } },
    },
    /** getState: the sites connected with an account of the active wallet (Settings, padlock of the browser). */
    async state(view) {
      const mine = new Set(view.accounts.map((a) => a.address));
      const list = Object.entries(await sessions()).filter(([, s]) => mine.has(s.account));
      return { tronSites: Object.fromEntries(list.map(([site, s]) => [site, { account: s.account, address: s.address, node: s.node, since: s.since, host: hostOf(site) }])) };
    },
    /** The user disconnects the site: the session goes and the page is told. */
    async disconnect(origin) {
      if (!(await sessions())[origin]) return;
      await local.update(KEY, {}, (all) => { const n = { ...all }; delete n[origin]; return n; });
      tell(origin, null);
    },
  };
}
