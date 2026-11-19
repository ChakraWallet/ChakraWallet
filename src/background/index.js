// Chakra background: key vault, dapp provider (EIP-1193), approvals, signing.
import { Transaction, getAddress, TypedDataEncoder } from 'ethers';
import { ext, local, session, DEFAULT_SETTINGS } from '../shared/ext.js';
import { getChain, chainFromEip3085, toHex, BUILTIN_CHAINS, isChainEnabled } from '../shared/chains.js';
import { rpc } from '../shared/rpc.js';
import { setAlchemy } from '../shared/alchemy.js';
import { sendRaw } from '../shared/mev.js';
import { replacementFloor, meetsFloor, replacementCall } from '../shared/tx.js';
import * as vault from './vault.js';
import { setLang, i18nError, tEn } from '../shared/i18n.js';
import { C as PM, CHAIN_ID as PM_CHAIN, ORDER_DOMAIN_NAME, AUTH_DOMAIN_NAME, DW_DOMAIN_NAME, iface as PMI } from '../shared/polytrade.js';

// ============================================================ helpers
const providerError = (code, message) => Object.assign(new Error(message), { code });
const E = {
  rejected: () => providerError(4001, 'User rejected the request.'),
  unauthorized: () => providerError(4100, 'The requested account has not been authorized. Connect the wallet first.'),
  unsupported: (m) => providerError(4200, `Chakra does not support this method: ${m}`),
  unknownChain: () => providerError(4902, 'Unrecognized chain. Add it first with wallet_addEthereumChain.'),
  invalid: (m) => providerError(-32602, m),
};

const lc = (a) => String(a || '').toLowerCase();

async function settings() {
  const s = { ...DEFAULT_SETTINGS, ...(await local.get('settings', {})) };
  setAlchemy(s); // the Alchemy key and its networks, for the transactions sent from here
  return s;
}
async function customChains() { return local.get('customChains', []); }
/**
 * The EVM network for sites and EVM operations. The app may show a non-EVM network (TON, Android app): sites keep
 * the last EVM network chosen (evmChainId), they never see the chainId of another family (TON...).
 */
async function currentChain() {
  const custom = await customChains();
  const c = getChain(await local.get('chainId', 1), custom);
  if (c && !c.kind) return c; // EVM networks have no kind of their own
  return getChain(await local.get('evmChainId', 1), custom) || BUILTIN_CHAINS[0];
}

// ============================================================ language (errors shown in the UI are localised here)
settings().then((s) => setLang(s.language));
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) setLang(changes.settings.newValue?.language || 'system');
});

// ============================================================ auto-lock
// The wallet locks N minutes after the last activity: unlock, signatures and sends, and the taps in the app (the UI
// reports them at most every 20 s, see app.jsx). The deadline is also kept as a wall-clock time: on Android the
// timer can run late while the phone sleeps, so when the app comes back and at every touch an expired deadline locks
// at once (and is never extended).
let lockAt = 0; // ms since the epoch, 0 = no deadline
async function touchAutoLock() {
  const min = Number((await settings()).autoLockMin);
  if (min > 0) { lockAt = Date.now() + min * 60000; ext.alarms.create('autolock', { delayInMinutes: min }); }
  else { lockAt = 0; ext.alarms.clear('autolock'); }
}
async function autoLock() { lockAt = 0; await vault.lock(); broadcastAccounts(); }
/** Locks if the deadline has passed while the timer was late; true when it locked. */
async function lockIfExpired() {
  if (!lockAt || Date.now() < lockAt || !(await vault.isUnlocked())) return false;
  await autoLock();
  return true;
}
ext.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'autolock') await autoLock();
});

// ============================================================ dapp connections (ports)
const ports = new Set();

ext.runtime.onConnect.addListener((port) => {
  if (port.name === 'chakra-ui') {
    port.onMessage.addListener(() => {}); // keep-alive pings
    return;
  }
  if (port.name !== 'chakra-content') return;
  const url = port.sender?.url || port.sender?.tab?.url || '';
  let origin = port.sender?.origin;
  try { origin = origin || new URL(url).origin; } catch { origin = 'unknown'; }
  port._origin = origin;
  port._tab = port.sender?.tab;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'ping') return;
    if (msg?.type === 'config') {
      const s = await settings();
      safePost(port, { type: 'config', metamaskCompat: s.metamaskCompat });
      return;
    }
    if (msg?.type !== 'request') return;
    try {
      const family = dappFamilies.find((f) => String(msg.method).startsWith(f.prefix));
      const result = family ? await family.handle(origin, msg.method, msg.params, port._tab) : await handleDappRequest(origin, msg.method, msg.params, port._tab);
      safePost(port, { type: 'response', id: msg.id, result });
    } catch (e) {
      // localised errors (vault, RPC) reach the site in English
      const message = e.key ? tEn(e.key, e.vars) : e.message;
      safePost(port, { type: 'response', id: msg.id, error: { code: e.code ?? -32603, message, data: e.data } });
    }
  });
});

function safePost(port, msg) { try { port.postMessage(msg); } catch { /* port closed */ } }

// Dapp protocols of other families, added by platform modules (TON Connect in the Android app:
// src/background/tonconnect.js). Each one: { prefix (of its request methods), handle(origin, method, params, tab),
// approvals: { kind: { auth(p) -> needs the password, complete(p, data) } }, state(view) -> extra getState fields,
// disconnect(origin) (the user disconnects the site) }.
const dappFamilies = [];
export function registerDappFamily(f) { dappFamilies.push(f); }
const familyApproval = (kind) => dappFamilies.find((f) => f.approvals?.[kind])?.approvals[kind];

async function permittedAccounts(origin) {
  if (!(await vault.isUnlocked())) return [];
  // only accounts of the active wallet: other wallets stay invisible to sites
  const perms = await local.get('permissions', {});
  const list = perms[origin]?.accounts || [];
  const { accounts, selected } = await vault.view();
  const existing = list.filter((a) => accounts.some((x) => lc(x.address) === lc(a)));
  const sorted = existing.sort((a, b) => (lc(a) === lc(selected) ? -1 : lc(b) === lc(selected) ? 1 : 0));
  return sorted.map(lc);
}

// Events are delivered to every open tab (not only to live ports, which die with the MV3 service worker).
async function sendToTabs(fn) {
  let tabs = [];
  try { tabs = await ext.tabs.query({}); } catch { return; }
  for (const t of tabs) {
    if (!t.url || !/^https?:/.test(t.url)) continue;
    const msg = await fn(new URL(t.url).origin);
    if (msg) ext.tabs.sendMessage(t.id, msg).catch(() => {});
  }
}
async function broadcastAccounts() {
  await sendToTabs(async (origin) => ({ type: 'event', event: 'accountsChanged', data: await permittedAccounts(origin) }));
}
async function broadcastChain() {
  const c = await currentChain();
  await sendToTabs(async () => ({ type: 'event', event: 'chainChanged', data: toHex(c.id) }));
}
export async function emitToOrigin(origin, event, data) {
  await sendToTabs(async (o) => (o === origin ? { type: 'event', event, data } : null));
}

// ============================================================ approvals
const pending = new Map(); // id -> {id, origin, kind, params, resolve, reject, created}
let approvalWindowId = null;

export async function requestApproval(origin, kind, params, tab) {
  const id = crypto.randomUUID();
  const p = new Promise((resolve, reject) => {
    pending.set(id, { id, origin, kind, params, resolve, reject, created: Date.now(), favicon: tab?.favIconUrl || '', title: tab?.title || '' });
  });
  await openApprovalWindow();
  return p;
}

async function openApprovalWindow() {
  if (approvalWindowId !== null) {
    try { await ext.windows.update(approvalWindowId, { focused: true }); notifyUi(); return; } catch { approvalWindowId = null; }
  }
  let left, top;
  try {
    const w = await ext.windows.getLastFocused();
    left = Math.max(0, (w.left || 0) + (w.width || 1200) - 400);
    top = (w.top || 0) + 60;
  } catch { /* ignore */ }
  const win = await ext.windows.create({
    url: ext.runtime.getURL('popup.html#approve'), type: 'popup', width: 390, height: 680, focused: true,
    ...(left !== undefined ? { left, top } : {}),
  });
  approvalWindowId = win.id;
}

ext.windows.onRemoved.addListener((wid) => {
  if (wid !== approvalWindowId) return;
  approvalWindowId = null;
  for (const p of pending.values()) p.reject(E.rejected());
  pending.clear();
});

function notifyUi() { ext.runtime.sendMessage({ type: 'pendingChanged' }).catch(() => {}); }

function listPending() {
  return [...pending.values()].map(({ resolve, reject, ...rest }) => rest);
}

// Requests that sign something or move funds: approved only with the wallet password
// (on Android the password may come from the fingerprint-protected Keystore).
const AUTH_KINDS = new Set(['sign', 'ethSign', 'typed', 'tx']);

async function resolveApproval(id, approved, data = {}) {
  const p = pending.get(id);
  if (!p) throw i18nError('errors.requestExpired');
  // checked before consuming the request, so a wrong password can be retried
  if (approved && (AUTH_KINDS.has(p.kind) || familyApproval(p.kind)?.auth(p))) await vault.verifyPassword(data.password);
  pending.delete(id);
  let failed = false;
  try {
    if (!approved) { p.reject(E.rejected()); return; }
    p.resolve(await completeApproval(p, data));
  } catch (e) {
    failed = true;
    p.reject(e);
    throw e;
  } finally {
    notifyUi();
    // keep the window open on failure so the user can read the error
    if (!failed && !pending.size && approvalWindowId !== null) {
      ext.windows.remove(approvalWindowId).catch(() => {});
      approvalWindowId = null;
    }
  }
}

async function completeApproval(p, data) {
  switch (p.kind) {
    case 'connect': {
      const active = new Set((await vault.activeAccounts()).map((a) => lc(a.address)));
      const chosen = (data.accounts || []).filter((a) => active.has(lc(a))).map((a) => getAddress(a));
      if (!chosen.length) throw E.rejected();
      // replaces this wallet's accounts for the site, keeps the ones granted from other wallets
      await local.update('permissions', {}, (perms) => {
        const others = (perms[p.origin]?.accounts || []).filter((a) => !active.has(lc(a)));
        return { ...perms, [p.origin]: { accounts: [...others, ...chosen], since: Date.now() } };
      });
      const accs = await permittedAccounts(p.origin);
      await emitToOrigin(p.origin, 'accountsChanged', accs);
      return accs;
    }
    case 'unlock': return true;
    case 'sign': {
      const [message, address] = p.params;
      const signer = await vault.getSigner(address);
      const bytes = /^0x[0-9a-f]*$/i.test(message) ? hexToBytes(message) : message;
      return signer.signMessage(bytes);
    }
    case 'ethSign': {
      if (!(await settings()).allowEthSign) throw E.unsupported('eth_sign');
      if (!data.acknowledged) throw E.rejected();
      const [address, hash] = p.params;
      const signer = await vault.getSigner(address);
      return signer.signingKey.sign(hash).serialized;
    }
    case 'typed': {
      const [address, typed] = p.params;
      const signer = await vault.getSigner(address);
      const { domain, types, message } = typed;
      const t = { ...types }; delete t.EIP712Domain;
      return signer.signTypedData(domain, t, message);
    }
    case 'tx': {
      const [req] = p.params;
      return signAndSend(req.from, data.tx, { origin: p.origin, title: data.title });
    }
    case 'switchChain': {
      if (p.params.enable) await enableChain(p.params.chainId); // switched off in Settings: the user agreed to turn it back on
      await setChain(p.params.chainId);
      return null;
    }
    case 'addChain': {
      const c = p.params.chain;
      await local.update('customChains', [], (list) => [...list.filter((x) => x.id !== c.id), c]);
      await setChain(c.id);
      return null;
    }
    case 'watchAsset': {
      const { chainId, token } = p.params;
      await local.update('customTokens', {}, (all) => {
        const list = (all[chainId] || []).filter((t) => t.address !== token.address);
        return { ...all, [chainId]: [...list, token] };
      });
      return true;
    }
    default: {
      const f = familyApproval(p.kind);
      if (f) return f.complete(p, data);
      throw new Error('Unknown request type');
    }
  }
}

function hexToBytes(hex) {
  const h = hex.slice(2);
  return new Uint8Array(h.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || []);
}

async function enableChain(chainId) {
  await local.update('settings', {}, (s) => ({ ...s, disabledChains: (s.disabledChains || []).filter((x) => x !== Number(chainId)) }));
}

async function setChain(chainId) {
  const c = getChain(chainId, await customChains());
  if (!c) throw E.unknownChain();
  await local.set('chainId', c.id);
  if (c.kind) return; // a network of another family: shown in the app; sites stay on their EVM network
  await local.set('evmChainId', c.id);
  await broadcastChain();
}

// ============================================================ signing & sending
// A transaction sent through the private channel (MEV protection) is not in the public nodes' pending count: the
// next one, sent before it is mined, would reuse its nonce. The last nonce sent privately is remembered for a while.
const privateNonces = new Map(); // `${chainId}:${from}` -> { n, t }
const PRIVATE_NONCE_MS = 5 * 60e3;

async function signAndSend(from, txIn, meta = {}) {
  const signer = await vault.getSigner(from);
  const chain = getChain(txIn.chainId, await customChains());
  if (!chain) throw E.unknownChain();
  const nk = `${chain.id}:${lc(from)}`, last = privateNonces.get(nk);
  let nonce = Number(BigInt(await rpc(chain, 'eth_getTransactionCount', [from, 'pending'])));
  if (last && Date.now() - last.t < PRIVATE_NONCE_MS && last.n >= nonce) nonce = last.n + 1;
  const tx = Transaction.from({
    type: txIn.type,
    chainId: chain.id,
    to: txIn.to || null,
    value: BigInt(txIn.value || 0),
    data: txIn.data || '0x',
    nonce: txIn.nonce !== undefined && Number(BigInt(txIn.nonce)) > nonce ? Number(BigInt(txIn.nonce)) : nonce,
    gasLimit: BigInt(txIn.gas),
    ...(txIn.type === 2
      ? { maxFeePerGas: BigInt(txIn.maxFeePerGas), maxPriorityFeePerGas: BigInt(txIn.maxPriorityFeePerGas) }
      : { gasPrice: BigInt(txIn.gasPrice) }),
  });
  const signed = await signer.signTransaction(tx);
  const sent = await sendRaw(chain, signed, { protect: (await settings()).mevProtect !== false }); // MEV protection (Ethereum)
  const { hash } = sent;
  if (sent.protected) privateNonces.set(nk, { n: tx.nonce, t: Date.now() });
  await logSent(chain, from, { hash, tx, origin: meta.origin || 'Chakra', title: meta.title || '', private: sent.protected });
  return hash;
}

// ------------------------------------------------------------ transactions still waiting: speed up, cancel
// What a transaction needs to be sent again with the same nonce (speed up / cancel, src/shared/tx.js), kept by hash
// until it is mined or replaced (at most PENDING_DAYS), apart from the txlog that every history reads: calldata can
// be large.
const PENDING_KEY = 'txpending', PENDING_MAX = 40, PENDING_MS = 14 * 864e5, PENDING_DATA_MAX = 256 * 1024;

/** A transaction just sent from here: in the txlog (history, origin, title) and, while it waits, in txpending. */
async function logSent(chain, from, { hash, tx, origin, title, private: priv, replaces = null, mode = null }) {
  const me = lc(from), to = tx.to ? lc(tx.to) : '';
  const replaceable = (tx.type === 0 || tx.type === 2) && (tx.data || '').length <= PENDING_DATA_MAX;
  await local.update('txlog', {}, (log) => {
    const key = `${chain.id}:${me}`;
    const entry = {
      hash, time: Date.now(), from: me, to, value: toHex(tx.value || 0n), data: (tx.data || '0x').slice(0, 10),
      origin, title, status: 'pending', nonce: tx.nonce, private: !!priv, replaceable, ...(replaces ? { replaces, mode } : {}),
    };
    return { ...log, [key]: [entry, ...(log[key] || [])].slice(0, 200) };
  });
  if (!replaceable) return;
  const fees = tx.type === 2 ? { maxFeePerGas: toHex(tx.maxFeePerGas), maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas) } : { gasPrice: toHex(tx.gasPrice) };
  const entry = {
    hash: lc(hash), chainId: chain.id, from: me, nonce: tx.nonce, type: tx.type, to: to || null, value: toHex(tx.value || 0n),
    data: tx.data || '0x', gas: toHex(tx.gasLimit), ...fees, private: !!priv, time: Date.now(),
  };
  // the account's transactions mined so far: the ones kept below that nonce are done (mined or replaced)
  const done = await rpc(chain, 'eth_getTransactionCount', [from, 'latest']).then((n) => Number(BigInt(n)), () => null);
  await local.update(PENDING_KEY, {}, (all) => {
    const now = Date.now();
    const keep = Object.values(all).filter((x) => x.hash !== entry.hash && now - x.time < PENDING_MS
      && !(done != null && x.chainId === entry.chainId && x.from === me && x.nonce < done));
    return Object.fromEntries([entry, ...keep.sort((a, b) => b.time - a.time)].slice(0, PENDING_MAX).map((x) => [x.hash, x]));
  });
}

/**
 * Sends again a transaction still waiting, with the same nonce and higher fees: the same one (mode 'speedUp') or 0 to
 * the account itself with no data ('cancel'). The transaction is rebuilt from what was kept when it was sent: from the
 * screen come only the fees (and, to cancel, the gas of a transfer to oneself). Through the same channel as the
 * original: a cancellation sent to Flashbots Protect, as it asks (same nonce, to oneself, no data), never goes on-chain.
 */
async function replaceTransaction(from, { hash, mode, fees, gas }) {
  if (mode !== 'speedUp' && mode !== 'cancel') throw E.invalid('mode');
  const all = await local.get(PENDING_KEY, {});
  const p = all[lc(hash)];
  if (!p || p.from !== lc(from)) throw i18nError('replace.err.unknown');
  const chain = getChain(p.chainId, await customChains());
  if (!chain) throw E.unknownChain();
  const done = Number(BigInt(await rpc(chain, 'eth_getTransactionCount', [from, 'latest'])));
  if (done > p.nonce) throw i18nError('replace.err.done');
  const sent = Object.values(all).filter((x) => x.chainId === p.chainId && x.from === p.from && x.nonce === p.nonce && x.type === p.type);
  const pick = p.type === 2 ? { maxFeePerGas: fees?.maxFeePerGas, maxPriorityFeePerGas: fees?.maxPriorityFeePerGas } : { gasPrice: fees?.gasPrice };
  if (!meetsFloor(pick, replacementFloor(sent))) throw i18nError('replace.err.lowFee');
  const call = replacementCall(p, mode);
  const gasLimit = mode === 'cancel' ? BigInt(gas || 21000) : BigInt(p.gas);
  if (gasLimit < 21000n || gasLimit > 2_000_000n) throw E.invalid('gas');
  const signer = await vault.getSigner(from);
  const tx = Transaction.from({
    type: p.type, chainId: chain.id, to: call.to, value: BigInt(call.value), data: call.data, nonce: p.nonce, gasLimit,
    ...(p.type === 2 ? { maxFeePerGas: BigInt(pick.maxFeePerGas), maxPriorityFeePerGas: BigInt(pick.maxPriorityFeePerGas) } : { gasPrice: BigInt(pick.gasPrice) }),
  });
  const signed = await signer.signTransaction(tx);
  const r = await sendRaw(chain, signed, { protect: !!p.private });
  const nk = `${chain.id}:${lc(from)}`, last = privateNonces.get(nk);
  // a private cancellation frees the nonce: the next transaction takes it again
  if (r.protected && mode === 'cancel') { if (last && last.n === p.nonce) privateNonces.delete(nk); }
  else if (r.protected) privateNonces.set(nk, { n: Math.max(last?.n ?? -1, p.nonce), t: Date.now() });
  const orig = ((await local.get('txlog', {}))[nk] || []).find((l) => lc(l.hash) === lc(hash));
  await logSent(chain, from, {
    hash: r.hash, tx, origin: orig?.origin || 'Chakra', title: orig?.title || '', private: r.protected,
    replaces: lc(hash), mode,
  });
  return r.hash;
}

// ============================================================ dapp request handler
const READ_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice', 'eth_getBalance',
  'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getBlockTransactionCountByHash', 'eth_getBlockTransactionCountByNumber',
  'eth_getCode', 'eth_getLogs', 'eth_getProof', 'eth_getStorageAt', 'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex', 'eth_getTransactionByHash', 'eth_getTransactionCount',
  'eth_getTransactionReceipt', 'eth_getUncleByBlockHashAndIndex', 'eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash', 'eth_getUncleCountByBlockNumber', 'eth_maxPriorityFeePerGas',
  'eth_protocolVersion', 'eth_syncing', 'net_listening', 'net_peerCount', 'eth_getBlockReceipts',
  'eth_newFilter', 'eth_newBlockFilter', 'eth_getFilterChanges', 'eth_getFilterLogs', 'eth_uninstallFilter',
  'web3_sha3',
]);

export async function ensureUnlocked(origin, tab) {
  if (await vault.isUnlocked()) return;
  await requestApproval(origin, 'unlock', {}, tab);
}

async function requireAccount(origin, address) {
  const accs = await permittedAccounts(origin);
  if (!accs.length) throw E.unauthorized();
  if (address && !accs.includes(lc(address))) throw E.unauthorized();
  return address ? lc(address) : accs[0];
}

async function handleDappRequest(origin, method, params = [], tab) {
  if (!Array.isArray(params) && params !== undefined && typeof params !== 'object') throw E.invalid('Invalid params');
  const chain = await currentChain();
  switch (method) {
    case 'eth_chainId': return toHex(chain.id);
    case 'net_version': return String(chain.id);
    case 'web3_clientVersion': return `Chakra/${__VERSION__}`;
    case 'eth_accounts': return permittedAccounts(origin);
    case 'eth_coinbase': return (await permittedAccounts(origin))[0] || null;
    case 'metamask_getProviderState':
    case 'chakra_init': {
      const accounts = await permittedAccounts(origin);
      return { chainId: toHex(chain.id), networkVersion: String(chain.id), accounts, isUnlocked: await vault.isUnlocked() };
    }
    case 'eth_requestAccounts':
    case 'wallet_requestPermissions': {
      await ensureUnlocked(origin, tab);
      let accs = await permittedAccounts(origin);
      if (!accs.length || method === 'wallet_requestPermissions') {
        accs = await requestApproval(origin, 'connect', {}, tab);
      }
      await touchAutoLock();
      if (method === 'wallet_requestPermissions') return permissionsFor(origin, accs);
      return accs;
    }
    case 'wallet_getPermissions': return permissionsFor(origin, await permittedAccounts(origin));
    case 'wallet_revokePermissions': {
      await local.update('permissions', {}, (p) => { const n = { ...p }; delete n[origin]; return n; });
      await emitToOrigin(origin, 'accountsChanged', []);
      return null;
    }
    case 'personal_sign': {
      let [a, b] = params;
      // Some dapps swap the order (address, message)
      if (/^0x[0-9a-f]{40}$/i.test(a) && !/^0x[0-9a-f]{40}$/i.test(b)) [a, b] = [b, a];
      await ensureUnlocked(origin, tab);
      const address = await requireAccount(origin, b);
      return requestApproval(origin, 'sign', [a, address], tab);
    }
    case 'eth_sign': {
      if (!(await settings()).allowEthSign) {
        throw E.unsupported('eth_sign (disabled for safety: it can be turned on in Settings → Advanced)');
      }
      const [address, hash] = params || [];
      // MetaMask semantics: sign a raw 32-byte hash, without the "Ethereum Signed Message" prefix
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw E.invalid('eth_sign requires a 32-byte hash (0x + 64 hex characters)');
      await ensureUnlocked(origin, tab);
      const addr = await requireAccount(origin, address);
      return requestApproval(origin, 'ethSign', [addr, hash], tab);
    }
    case 'eth_signTypedData_v4':
    case 'eth_signTypedData_v3': {
      const [address, raw] = params;
      await ensureUnlocked(origin, tab);
      const addr = await requireAccount(origin, address);
      const typed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (typed?.domain?.chainId !== undefined && Number(BigInt(typed.domain.chainId)) !== chain.id) {
        throw E.invalid(`Signature chainId (${typed.domain.chainId}) does not match the active chain (${chain.id})`);
      }
      // validate
      const t = { ...typed.types }; delete t.EIP712Domain;
      TypedDataEncoder.hash(typed.domain || {}, t, typed.message);
      return requestApproval(origin, 'typed', [addr, typed], tab);
    }
    case 'eth_signTypedData': throw E.unsupported('eth_signTypedData v1');
    case 'eth_sendTransaction': {
      const [tx] = params;
      if (!tx) throw E.invalid('Missing transaction');
      await ensureUnlocked(origin, tab);
      const from = await requireAccount(origin, tx.from);
      if (tx.chainId && Number(BigInt(tx.chainId)) !== chain.id) throw E.invalid('Transaction chainId does not match the active chain');
      await touchAutoLock();
      return requestApproval(origin, 'tx', [{ ...tx, from }], tab);
    }
    case 'wallet_switchEthereumChain': {
      const id = Number(BigInt(params?.[0]?.chainId));
      if (id === chain.id) return null;
      const target = getChain(id, await customChains());
      if (!target) throw E.unknownChain();
      if (!isChainEnabled(id, await settings())) return requestApproval(origin, 'switchChain', { chainId: id, from: chain.id, enable: true }, tab);
      // Switching is harmless: do it immediately if the site is connected, otherwise ask.
      if ((await permittedAccounts(origin)).length) { await setChain(id); return null; }
      return requestApproval(origin, 'switchChain', { chainId: id, from: chain.id }, tab);
    }
    case 'wallet_addEthereumChain': {
      const p = params?.[0];
      if (!p?.chainId) throw E.invalid('Missing chainId');
      const id = Number(BigInt(p.chainId));
      const existing = getChain(id, await customChains());
      if (existing) {
        if (id === chain.id) return null;
        return requestApproval(origin, 'switchChain', { chainId: id, from: chain.id, enable: !isChainEnabled(id, await settings()) }, tab);
      }
      const c = chainFromEip3085(p);
      if (!c.rpc.length) throw E.invalid('At least one https rpcUrl is required');
      // verify RPC really serves this chain
      const remote = Number(BigInt(await rpc(c, 'eth_chainId', [])));
      if (remote !== id) throw E.invalid(`The given RPC returns chainId ${remote}, not ${id}`);
      return requestApproval(origin, 'addChain', { chain: c }, tab);
    }
    case 'wallet_watchAsset': {
      const p = Array.isArray(params) ? params[0] : params;
      if (p?.type !== 'ERC20' || !p?.options?.address) throw E.invalid('Only ERC20 tokens are supported');
      const o = p.options;
      const token = { address: lc(getAddress(o.address)), symbol: String(o.symbol || '').slice(0, 12), decimals: Number(o.decimals ?? 18), name: String(o.symbol || ''), image: o.image || '' };
      return requestApproval(origin, 'watchAsset', { chainId: chain.id, token }, tab);
    }
    case 'wallet_getCapabilities':
    case 'wallet_sendCalls':
    case 'wallet_getCallsStatus':
    case 'eth_subscribe':
    case 'eth_unsubscribe':
    case 'eth_getEncryptionPublicKey':
    case 'eth_decrypt':
      throw E.unsupported(method);
    default:
      if (READ_METHODS.has(method)) return rpc(chain, method, params || []);
      throw E.unsupported(method);
  }
}

function permissionsFor(origin, accounts) {
  if (!accounts.length) return [];
  return [{
    invoker: origin, parentCapability: 'eth_accounts', date: Date.now(),
    caveats: [{ type: 'restrictReturnedAccounts', value: accounts }],
  }];
}

async function fullReset() {
  for (const p of pending.values()) p.reject(E.rejected());
  pending.clear();
  await ext.storage.local.clear();
  await session.clear();
  await broadcastAccounts();
}

// ============================================================ UI messages
// ============================================================ Polymarket Deposit Wallet checks
const PM_POLYGON = BUILTIN_CHAINS.find((c) => c.id === PM_CHAIN);
/** The Deposit Wallet's owner() is the user's address (read on-chain). */
async function ownsDepositWallet(from, wallet) {
  try {
    const r = await rpc(PM_POLYGON, 'eth_call', [{ to: wallet, data: PMI.dw.encodeFunctionData('owner') }, 'latest']);
    return lc(PMI.dw.decodeFunctionResult('owner', r)[0]) === lc(from);
  } catch { return false; }
}
/**
 * A call the user's Deposit Wallet may run: only Polymarket's contracts, no POL sent; approvals only to them;
 * pUSD transfers and pUSD -> USDC / USDC.e conversions only to the user's own address.
 */
function safeWalletCall(c, from) {
  const known = [PM.pusd, PM.offramp, PM.ctf, PM.positionManager, PM.collateralAdapter, PM.negRiskCollateralAdapter, PM.router, PM.negRiskAdapter, PM.exchange, PM.negRiskExchange, PM.exchangeV3].map(lc);
  const target = lc(c?.target), data = String(c?.data || '');
  if (!known.includes(target) || BigInt(c?.value || 0) !== 0n) return false;
  const sel = data.slice(0, 10);
  try {
    if (sel === PMI.erc20.getFunction('approve').selector) return known.includes(lc(PMI.erc20.decodeFunctionData('approve', data)[0]));
    if (sel === PMI.erc1155.getFunction('setApprovalForAll').selector) return known.includes(lc(PMI.erc1155.decodeFunctionData('setApprovalForAll', data)[0]));
    if (sel === PMI.erc20.getFunction('transfer').selector) return lc(PMI.erc20.decodeFunctionData('transfer', data)[0]) === lc(from);
    if (sel === PMI.ramp.getFunction('unwrap').selector) return target === lc(PM.offramp) && lc(PMI.ramp.decodeFunctionData('unwrap', data)[1]) === lc(from);
    if (sel === PMI.ctfRedeem.getFunction('redeemPositions').selector) return [PM.collateralAdapter, PM.negRiskCollateralAdapter].map(lc).includes(target);
    if (sel === PMI.router.getFunction('redeem').selector) return target === lc(PM.router);
  } catch { return false; }
  return false;
}

/** Extra UI handlers from platform modules (e.g. TON in the Android app: src/mobile/tonPlugin.js). */
export function registerUiHandlers(extra) { Object.assign(uiHandlers, extra); }

const uiHandlers = {
  async getState() {
    const [initialized, unlocked, v, chainId, custom, s, perms] = await Promise.all([
      vault.isInitialized(), vault.isUnlocked(), vault.view(),
      local.get('chainId', 1), customChains(), settings(), local.get('permissions', {}),
    ]);
    // sites connected with at least one account of the active wallet
    const mine = new Set(v.accounts.map((a) => lc(a.address)));
    const permissions = Object.fromEntries(Object.entries(perms)
      .map(([o, p]) => [o, { ...p, accounts: (p.accounts || []).filter((a) => mine.has(lc(a))) }])
      .filter(([, p]) => p.accounts.length));
    const extra = await Promise.all(dappFamilies.filter((f) => f.state).map((f) => f.state(v)));
    return { initialized, unlocked, ...v, chainId, customChains: custom, settings: s, permissions, ...Object.assign({}, ...extra), pending: pending.size };
  },
  generateMnemonic: () => vault.generateMnemonic(),
  async createVault({ password, mnemonic, name, generated }) { const a = await vault.createVault(password, mnemonic, name, { generated }); await touchAutoLock(); return a; },
  async restoreBackup({ password, backup, backupPassword }) { const n = await vault.restoreVault(password, backup, backupPassword); await touchAutoLock(); await broadcastAccounts(); return n; },
  exportBackup: ({ password, backupPassword }) => vault.exportBackup(password, backupPassword),
  async importBackup({ backup, backupPassword }) { const r = await vault.importBackup(backup, backupPassword); if (r.added) await broadcastAccounts(); return r; },
  async createWallet({ name, mnemonic, privateKey, generated }) { const w = await vault.createWallet({ name, mnemonic, privateKey, generated }); await broadcastAccounts(); return w; },
  async switchWallet({ id }) { await vault.switchWallet(id); await broadcastAccounts(); return true; },
  renameWallet: ({ id, name }) => vault.renameWallet(id, name).then(() => true),
  async removeWallet({ id, password }) {
    const r = await vault.removeWallet(id, password);
    if (r.empty) await fullReset(); // last wallet: nothing left, back to onboarding
    else await broadcastAccounts();
    return r;
  },
  async unlock({ password }) { await vault.unlock(password); await touchAutoLock(); await broadcastAccounts(); return true; },
  async lock() { await vault.lock(); await broadcastAccounts(); return true; },
  async addAccount({ name, mode, privateKey }) {
    const acc = mode === 'import' ? await vault.importPrivateKey(privateKey, name)
      : mode === 'random' ? await vault.createRandomAccount(name)
        : mode === 'vanity' ? await vault.importPrivateKey(privateKey, name, 'generated') // key found on this device (vanity search)
        : await vault.addHdAccount(name);
    await vault.selectAccount(acc.address);
    await broadcastAccounts();
    return acc;
  },
  async removeAccount({ address, password }) {
    await vault.removeAccount(address, password);
    await broadcastAccounts();
    return true;
  },
  async renameAccount({ address, name }) {
    await local.update('accounts', [], (a) => a.map((x) => (lc(x.address) === lc(address) ? { ...x, name: name.slice(0, 32) } : x)));
    return true;
  },
  async selectAccount({ address }) { await vault.selectAccount(address); await broadcastAccounts(); return true; },
  async setChain({ chainId }) { await setChain(chainId); return true; },
  async addCustomChain({ chain }) {
    const remote = Number(BigInt(await rpc(chain, 'eth_chainId', [])));
    if (remote !== chain.id) throw i18nError('errors.rpcWrongChain', { remote, expected: chain.id });
    await local.update('customChains', [], (l) => [...l.filter((x) => x.id !== chain.id), chain]);
    return true;
  },
  async removeCustomChain({ chainId }) {
    await local.update('customChains', [], (l) => l.filter((x) => x.id !== chainId));
    if ((await local.get('chainId', 1)) === chainId) await setChain(1);
    return true;
  },
  exportPrivateKey: ({ address, password }) => vault.exportPrivateKey(address, password),
  checkPassword: ({ password }) => vault.verifyPassword(password).then(() => true),
  revealMnemonic: ({ password }) => vault.revealMnemonic(password),
  changePassword: ({ oldPassword, newPassword }) => vault.changePassword(oldPassword, newPassword).then(() => true),
  async saveSettings({ settings: s }) {
    await local.update('settings', {}, (old) => ({ ...old, ...s }));
    // the active network was switched off: back to Ethereum
    if (s.disabledChains && !isChainEnabled(await local.get('chainId', 1), await settings())) await setChain(1);
    await touchAutoLock();
    return true;
  },
  async disconnectSite({ origin }) {
    // disconnects only the active wallet's accounts from the site
    const active = new Set((await vault.activeAccounts()).map((a) => lc(a.address)));
    await local.update('permissions', {}, (p) => {
      const n = { ...p };
      const rest = (n[origin]?.accounts || []).filter((a) => !active.has(lc(a)));
      if (rest.length) n[origin] = { ...n[origin], accounts: rest }; else delete n[origin];
      return n;
    });
    await emitToOrigin(origin, 'accountsChanged', []);
    for (const f of dappFamilies) await f.disconnect?.(origin);
    return true;
  },
  // Polymarket (Predictions tab): only its own EIP-712 payloads are signed here — never arbitrary typed data:
  // the API key request, exchange orders (from the address / Safe, or wrapped for the user's Deposit Wallet) and
  // Deposit Wallet batches limited to Polymarket's contracts, with any money leaving only towards the user.
  async polySign({ from, typed, password }) {
    await vault.verifyPassword(password);
    const d = typed?.domain || {}, m = typed?.message || {};
    const exchanges = [PM.exchange, PM.negRiskExchange, PM.exchangeV3].map(lc);
    let ok = false;
    if (Number(d.chainId) === PM_CHAIN) {
      if (d.name === AUTH_DOMAIN_NAME) ok = !!typed.types?.ClobAuth && lc(m.address) === lc(from);
      else if (d.name === ORDER_DOMAIN_NAME && exchanges.includes(lc(d.verifyingContract))) {
        if (typed.types?.TypedDataSign) { // Deposit Wallet order: maker = signer = the wallet, owned by `from`
          const w = lc(m.verifyingContract);
          ok = m.name === DW_DOMAIN_NAME && lc(m.contents?.maker) === w && lc(m.contents?.signer) === w
            && Number(m.contents?.signatureType) === 3 && await ownsDepositWallet(from, w);
        } else ok = !!typed.types?.Order && lc(m.signer) === lc(from);
      } else if (d.name === DW_DOMAIN_NAME && typed.types?.Batch) {
        const w = lc(d.verifyingContract);
        ok = lc(m.wallet) === w && Array.isArray(m.calls) && m.calls.length > 0 && m.calls.every((c) => safeWalletCall(c, from)) && await ownsDepositWallet(from, w);
      }
    }
    if (!ok) throw new Error('Unsupported signature request');
    const signer = await vault.getSigner(from);
    await touchAutoLock();
    return signer.signTypedData(d, typed.types, m);
  },
  // Polymarket relayer key (Deposit Wallet operations without gas): kept encrypted in the vault, per address
  async polyRelayerSet({ address, key, password }) {
    await vault.verifyPassword(password);
    await vault.setExtraSecret(`polyRelayer:${lc(address)}`, key ? String(key).trim() : null);
    return true;
  },
  async polyRelayerGet({ address, password }) { await vault.verifyPassword(password); return vault.getExtraSecret(`polyRelayer:${lc(address)}`); },
  async polyRelayerHas({ address }) { return !!(await vault.getExtraSecret(`polyRelayer:${lc(address)}`).catch(() => null)); },
  async sendTransaction({ from, tx, title, password }) {
    await vault.verifyPassword(password);
    await touchAutoLock();
    return signAndSend(from, tx, { title });
  },
  /** Speeds up or cancels a transaction still waiting (history): mode 'speedUp' | 'cancel', the fees chosen. */
  async replaceTransaction({ from, hash, mode, fees, gas, password }) {
    await vault.verifyPassword(password);
    await touchAutoLock();
    return replaceTransaction(from, { hash, mode, fees, gas });
  },
  listPending: () => listPending(),
  resolveApproval: ({ id, approved, data }) => resolveApproval(id, approved, data).then(() => true),
  async resetWallet({ password }) {
    await vault.verifyPassword(password);
    await fullReset();
    return true;
  },
  /** Activity in the app: restarts the auto-lock timer (unless the time was already up). */
  async touch() {
    if (await lockIfExpired()) return false;
    if (await vault.isUnlocked()) await touchAutoLock();
    return true;
  },
  /** The app is visible again: lock at once if the time is up; being visible isn't activity. */
  checkLock: () => lockIfExpired(),
};

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // only accept messages from our own extension pages (not content scripts)
  if (sender.id !== ext.runtime.id || (sender.tab && !String(sender.url || '').startsWith(ext.runtime.getURL('')))) return false;
  const h = uiHandlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e), code: e?.code, key: e?.key }));
  return true;
});

// first install: open onboarding in a tab
ext.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install' && !(await vault.isInitialized())) {
    ext.tabs.create({ url: ext.runtime.getURL('popup.html#onboarding') });
  }
});
