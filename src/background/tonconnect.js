// TON Connect 2, wallet side (Android app, registered by src/mobile/tonPlugin.js), over two transports:
// - the in-app browser: the page finds window.chakra.tonconnect (src/mobile/tonconnectInpage.js); its calls arrive
//   with the page origin, which Android gives (never the page);
// - the HTTP bridge, for dapps outside the app (a QR code on a computer, a link on the phone): the session starts
//   from a tc:// link, then requests and answers travel sealed through the bridge (src/shared/ton/tonconnectBridge.js).
//   Here Chakra can't know which site is asking: only the manifest the dapp declares (the screens say so).
// One session per site, bound to one account of the active wallet; a silent reconnection only for the in-app browser
// and only when nothing has to be signed. Every signature (ton_proof, transactions, signData) is approved on a screen
// and needs the password or the fingerprint. Spec: github.com/ton-blockchain/ton-connect (spec/*.md).
import { Address } from '@ton/core';
import * as vault from './vault.js';
import { ext, local } from '../shared/ext.js';
import { isChainEnabled } from '../shared/chains.js';
import { ENDPOINTS } from '../shared/endpoints.js';
import { i18nError, tEn } from '../shared/i18n.js';
import { TON_CHAINS } from '../shared/ton/api.js';
import { walletContract } from '../shared/ton/core.js';
import { deviceInfo, maxMessages } from '../shared/ton/tonconnectInfo.js';
import { ERR, NETWORKS, TcError, addressReply, tonProof, parseManifest, parseSendTransaction, parseSignData, signDataSignature } from '../shared/ton/tonconnect.js';
import { BridgeClient, newSessionKeys, parseConnectLink, seal, unseal } from '../shared/ton/tonconnectBridge.js';
import { keyOf, signAndBroadcast } from './ton.js';

// Sessions: { [site]: { account, network, address, publicKey, stateInit, version, manifest, domain, since, remote? } }
// site = the page origin (in-app browser) or "tc:<dapp client id>" (bridge); remote = { dappId, keys } (bridge only).
const KEY = 'tonConnect';
const IDS = 'tonConnectIds'; // { [site]: last request id } (apart: it changes at every request, the UI needn't redraw)
const LAST = 'tonConnectLastEvent'; // the last bridge event handled
const REMOTE = 'tc:';
const APP_VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';

const nowSec = () => Math.floor(Date.now() / 1000);
let lastEvent = 0;
/** Event ids only grow (spec/rpc.md), also across restarts. */
const nextEventId = () => (lastEvent = Math.max(Date.now(), lastEvent + 1));
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return ''; } };
const isRemote = (site) => site.startsWith(REMOTE);
const device = (version) => deviceInfo(maxMessages(version), APP_VERSION);
const connectError = (code, message) => ({ event: 'connect_error', id: nextEventId(), payload: { code, message } });
const connected = (items, version) => ({ event: 'connect', id: nextEventId(), payload: { items, device: device(version) } });
const replyOf = (s) => ({ name: 'ton_addr', address: s.address, network: s.network, publicKey: s.publicKey, walletStateInit: s.stateInit });
/** An error as the dapp gets it: the spec's code, the message in English. */
const asTc = (e) => ({
  code: e?.tcCode ?? (e?.code === 4001 ? ERR.DECLINED : ERR.UNKNOWN), // 4001: the user rejected (or closed) the request
  message: e?.key ? tEn(e.key, e.vars) : e?.message || 'Unknown error',
});

const allSessions = () => local.get(KEY, {});
/** The site's session, if its account is in the active wallet (the others stay invisible, as for EVM sites). */
async function sessionOf(site) {
  const s = (await allSessions())[site];
  if (!s) return null;
  const { accounts } = await vault.view();
  return accounts.some((a) => a.address === s.account) ? s : null;
}
async function dropSession(site) {
  const without = (all) => { const n = { ...all }; delete n[site]; return n; };
  await local.update(KEY, {}, without);
  await local.update(IDS, {}, without);
}

async function loadManifest(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new TcError(ERR.MANIFEST_NOT_FOUND, 'Bad manifest URL'); }
  if (u.protocol !== 'https:') throw new TcError(ERR.MANIFEST_NOT_FOUND, 'The manifest must be served over https');
  let res;
  try { res = await fetch(u.href, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); } catch { throw new TcError(ERR.MANIFEST_NOT_FOUND, 'Manifest not reachable'); }
  if (!res.ok) throw new TcError(ERR.MANIFEST_NOT_FOUND, `Manifest not found (HTTP ${res.status})`);
  let json;
  try { json = await res.json(); } catch { throw new TcError(ERR.MANIFEST_CONTENT, 'The manifest is not valid JSON'); }
  return parseManifest(json);
}

const walletOf = (k, network) => walletContract(k.publicKey, { version: k.version, testnet: network === NETWORKS.testnet });
async function keyFor(account) {
  const k = await keyOf(account);
  if (!k) throw i18nError('errors.accountUnavailable');
  return k;
}

/**
 * The TON Connect "dapp family" for src/background/index.js (registerDappFamily).
 * kit: { requestApproval(site, kind, params, tab), ensureUnlocked(site, tab), emitToOrigin(origin, event, data) }.
 * opts (tests): { bridgeUrl, EventSourceImpl, fetchImpl }.
 */
export function tonConnectFamily({ requestApproval, ensureUnlocked, emitToOrigin }, opts = {}) {
  const pendingKeys = new Map(); // bridge site -> its session keys, while the user decides
  const answered = new Set(); // listeners: a bridge request has been answered (the app may go back to the dapp)

  // ---------------------------------------------------------------- the bridge
  const bridge = new BridgeClient({
    url: opts.bridgeUrl || ENDPOINTS.tonconnectBridge,
    EventSourceImpl: opts.EventSourceImpl, fetchImpl: opts.fetchImpl,
    onLastId: (id) => { local.set(LAST, id).catch(() => {}); },
    onMessage: (m) => { onBridgeMessage(m).catch((e) => console.warn('TON Connect bridge', e)); },
  });

  /** Listens for the bridge sessions of the active wallet (after any change; force: reconnect even if nothing changed). */
  async function relisten({ force = false } = {}) {
    const { accounts } = await vault.view();
    const mine = new Set(accounts.map((a) => a.address));
    const ids = Object.values(await allSessions()).filter((s) => s.remote && mine.has(s.account)).map((s) => s.remote.keys.publicKey);
    if (!ids.length) { bridge.stop(); return; }
    bridge.listen(ids, await local.get(LAST, null), { force });
  }

  async function onBridgeMessage({ from, message }) {
    const site = REMOTE + from;
    const s = await sessionOf(site);
    if (!s?.remote) return;
    const req = unseal(message, from, s.remote.keys.secretKey);
    if (!req || typeof req.method !== 'string') return;
    const res = await send(site, { message: req }, null);
    await bridge.send(s.remote.keys.publicKey, from, seal(res, from, s.remote.keys.secretKey));
    if (req.method === 'disconnect') await relisten();
    else for (const fn of answered) fn({ method: req.method, ok: !res.error });
  }

  /**
   * A tc:// link (QR code or a link that opened the app): connects the dapp through the bridge. Chakra listens
   * before it answers, so the first request can't be missed. -> { connected, name?, error?, ret }.
   */
  async function openLink(url) {
    const link = parseConnectLink(url);
    if (!link || link.kind === 'bad') throw i18nError('tonconnect.err.notLink');
    if (link.kind === 'open') { await relisten({ force: true }); return { connected: false, ret: link.ret }; }
    const site = REMOTE + link.id;
    const keys = newSessionKeys();
    pendingKeys.set(site, keys);
    let event;
    try { event = await connect(site, { request: link.request }, null, { remote: true }); } finally { pendingKeys.delete(site); }
    if (event.event === 'connect') { await relisten(); await bridge.ready(); }
    await bridge.send(keys.publicKey, link.id, seal(event, link.id, keys.secretKey));
    const s = event.event === 'connect' ? await sessionOf(site) : null;
    return { connected: event.event === 'connect', name: s?.manifest?.name || '', error: event.event === 'connect' ? null : event.payload.message, code: event.payload?.code, ret: link.ret };
  }

  // ---------------------------------------------------------------- connect / restore
  async function connect(site, { request } = {}, tab, { remote = false } = {}) {
    try {
      if (!remote && !site.startsWith('https://')) throw new TcError(ERR.BAD_REQUEST, 'TON Connect works only on secure (https) sites');
      const items = Array.isArray(request?.items) ? request.items : [];
      const addr = items.find((i) => i?.name === 'ton_addr');
      if (!addr) throw new TcError(ERR.BAD_REQUEST, 'ton_addr is required');
      const proof = items.find((i) => i?.name === 'ton_proof');
      if (proof && (typeof proof.payload !== 'string' || proof.payload.length > 512)) throw new TcError(ERR.BAD_REQUEST, 'Bad ton_proof payload');
      const network = addr.network == null ? NETWORKS.mainnet : String(addr.network);
      if (!TON_CHAINS[network]) throw new TcError(ERR.BAD_REQUEST, `Unknown network ${network}`);
      if (!isChainEnabled(Number(network), await local.get('settings', {}))) throw new TcError(ERR.BAD_REQUEST, 'This network is turned off in Chakra');
      const manifest = await loadManifest(request.manifestUrl);
      await ensureUnlocked(site, tab);
      const s = await sessionOf(site);
      // in the in-app browser, already connected and nothing to sign: the same session, silently (a signature always asks)
      if (!remote && s && !proof && s.network === network) return connected([replyOf(s)], s.version);
      // what signatures are bound to: the page's host, or (bridge) the host the dapp declares
      const domain = remote ? manifest.host : hostOf(site);
      return await requestApproval(site, 'tonConnect', { manifest, network, domain, remote, current: s?.account || null, proof: proof ? { payload: proof.payload } : null }, tab);
    } catch (e) {
      const { code, message } = asTc(e);
      return connectError(code, message);
    }
  }

  async function restore(site) {
    const s = await sessionOf(site);
    return s ? connected([replyOf(s)], s.version) : connectError(ERR.UNKNOWN_APP, 'Unknown app');
  }

  // ---------------------------------------------------------------- requests
  async function send(site, { message } = {}, tab) {
    const id = String(message?.id ?? '');
    try {
      const s = await sessionOf(site);
      if (!s) throw new TcError(ERR.UNKNOWN_APP, 'Unknown app: connect first');
      // ids only grow within a session (spec/rpc.md): a request seen before (or replayed by the bridge) is refused
      if (!/^\d{1,30}$/.test(id)) throw new TcError(ERR.BAD_REQUEST, 'Bad request id');
      let fresh = false;
      await local.update(IDS, {}, (all) => {
        const last = all[site];
        fresh = last == null || BigInt(id) > BigInt(last);
        return fresh ? { ...all, [site]: id } : all;
      });
      if (!fresh) throw new TcError(ERR.BAD_REQUEST, 'Request id already used');
      const base = { account: s.account, network: s.network, address: s.address, manifest: s.manifest, remote: !!s.remote };
      switch (message.method) {
        case 'disconnect':
          await dropSession(site);
          return { result: {}, id };
        case 'sendTransaction': {
          const tx = parseSendTransaction(message.params, s, nowSec());
          await ensureUnlocked(site, tab);
          const boc = await requestApproval(site, 'tonTx', { ...base, version: s.version, publicKey: s.publicKey, ...tx }, tab);
          return { result: boc, id };
        }
        case 'signData': {
          const payload = parseSignData(message.params, s);
          await ensureUnlocked(site, tab);
          return { result: await requestApproval(site, 'tonSignData', { ...base, domain: s.domain || hostOf(site), payload }, tab), id };
        }
        default: throw new TcError(ERR.NOT_SUPPORTED, `Method not supported: ${message?.method}`);
      }
    } catch (e) {
      return { error: asTc(e), id };
    }
  }

  // ---------------------------------------------------------------- approvals (after the user's OK)
  async function completeConnect(p, data) {
    const { network, proof, manifest, domain, remote } = p.params;
    const keys = remote ? pendingKeys.get(p.origin) : null;
    if (remote && !keys) throw i18nError('errors.requestExpired');
    const k = await keyFor(data.account);
    const w = walletOf(k, network);
    const reply = addressReply(w, k.publicKey, network);
    const items = [reply];
    if (proof) items.push({ name: 'ton_proof', proof: tonProof({ address: w.address, secretKey: k.secretKey, domain, timestamp: nowSec(), payload: proof.payload }) });
    await local.update(KEY, {}, (all) => ({
      ...all,
      [p.origin]: {
        account: data.account, network, address: reply.address, publicKey: reply.publicKey, stateInit: reply.walletStateInit, version: k.version,
        manifest, domain, since: Date.now(), ...(remote ? { remote: { dappId: p.origin.slice(REMOTE.length), keys } } : {}),
      },
    }));
    await local.update(IDS, {}, (all) => { const n = { ...all }; delete n[p.origin]; return n; }); // a new session counts its ids anew
    return connected(items, k.version);
  }

  async function completeTx(p) {
    const { account, network, messages, validUntil } = p.params;
    if (validUntil && nowSec() >= validUntil) throw i18nError('tonconnect.err.expired', null, { tcCode: ERR.BAD_REQUEST });
    const sent = await signAndBroadcast({ from: account, chainId: Number(network), messages, validUntil: validUntil || undefined });
    return sent.boc;
  }

  async function completeSignData(p) {
    const { account, network, payload, domain } = p.params;
    const k = await keyFor(account);
    const w = walletOf(k, network);
    const timestamp = nowSec();
    const signature = signDataSignature({ payload, address: w.address, domain, timestamp }, k.secretKey);
    return { signature, address: w.address.toRawString(), timestamp, domain, payload };
  }

  // the bridge follows the sessions and the active wallet; when the app comes back, it reconnects at once
  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && (changes[KEY] || changes.activeWallet)) relisten().catch(() => {});
  });
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible') relisten({ force: true }).catch(() => {}); });
  relisten().catch(() => {});

  return {
    prefix: 'tonconnect_',
    handle(origin, method, params, tab) {
      if (isRemote(origin)) throw new Error('Bad origin'); // a page can't speak for a bridge session
      if (method === 'tonconnect_connect') return connect(origin, params, tab);
      if (method === 'tonconnect_restore') return restore(origin);
      if (method === 'tonconnect_send') return send(origin, params, tab);
      throw new Error(`Unknown TON Connect call: ${method}`);
    },
    approvals: {
      tonConnect: { auth: (p) => !!p.params.proof, complete: completeConnect }, // signing in (ton_proof) needs the password
      tonTx: { auth: () => true, complete: completeTx },
      tonSignData: { auth: () => true, complete: completeSignData },
    },
    /** UI handlers: a TON Connect link from a QR code or from a link that opened the app. */
    uiHandlers: { tonConnectLink: ({ url }) => openLink(url) },
    /** fn({ method, ok }) after each answer to a bridge request. */
    onAnswered: (fn) => answered.add(fn),
    /** getState: the sites connected with an account of the active wallet (Settings, padlock of the browser). */
    async state(view) {
      const mine = new Set(view.accounts.map((a) => a.address));
      const list = Object.entries(await allSessions()).filter(([, s]) => mine.has(s.account));
      return {
        tonSites: Object.fromEntries(list.map(([site, s]) => [site, {
          account: s.account, network: s.network, name: s.manifest?.name || '', since: s.since, remote: !!s.remote,
          host: s.remote ? s.manifest?.host || '' : hostOf(site),
          display: Address.parseRaw(s.address).toString({ urlSafe: true, bounceable: false, testOnly: s.network === NETWORKS.testnet }),
        }])),
      };
    },
    /** The user disconnects the site (padlock, Settings): the session goes and the dapp is told. */
    async disconnect(site) {
      const s = await sessionOf(site);
      if (!s) return;
      await dropSession(site);
      const event = { event: 'disconnect', id: nextEventId(), payload: {} };
      if (s.remote) {
        await bridge.send(s.remote.keys.publicKey, s.remote.dappId, seal(event, s.remote.dappId, s.remote.keys.secretKey)).catch(() => {});
        await relisten();
      } else await emitToOrigin(site, 'tonconnect', event);
    },
    /** Tests: the bridge client. */
    _bridge: bridge,
  };
}
