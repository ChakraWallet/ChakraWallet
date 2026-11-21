// WalletConnect 2, wallet side (Android app, registered by src/mobile/walletconnectPlugin.js): dapps outside the app
// (a QR code on a computer, a link or a copied code on the phone) connect to Chakra through WalletConnect's relay.
// Chakra speaks the open protocol itself (specs: github.com/WalletConnect/walletconnect-specs), with no SDK: nothing
// is sent beyond what the protocol needs (no analytics, no transaction reports).
//
// The flow: the dapp's pairing code gives a topic and its key; on it the dapp proposes a session (its name, address,
// icon and the networks and methods it wants). Chakra shows who asks (with what Verify says of the real site) and the
// account to use; on approval it derives the session's key with the dapp (X25519), settles the session on the new
// topic and answers the proposal. Then the dapp's requests arrive on the session topic and go through the same
// screens and checks as the in-app browser's: Ethereum (signatures, transactions, network switch, tokens), Solana and
// Tron. Every signature is approved on a screen and needs the password or the fingerprint.
// Sessions are bound to one account of the active wallet (the others stay invisible, as for every dapp) and last a
// week from the last request; the user can disconnect them in Settings.
import { TypedDataEncoder, getAddress } from 'ethers';
import * as vault from './vault.js';
import { familyOf } from './families.js';
import { ext, local, DEFAULT_SETTINGS } from '../shared/ext.js';
import { allChains, getChain, isChainEnabled, isEvm, toHex } from '../shared/chains.js';
import { rpc } from '../shared/rpc.js';
import { ENDPOINTS, WALLETCONNECT_PROJECT_ID } from '../shared/endpoints.js';
import { i18nError, tEn } from '../shared/i18n.js';
import { parseWcLink } from '../shared/walletconnect/uri.js';
import { deriveSymKey, hashMessage, newClientKey, newKeyPair, open, seal, topicOf } from '../shared/walletconnect/crypto.js';
import { RelayClient } from '../shared/walletconnect/relay.js';
import { verifier } from '../shared/walletconnect/verify.js';
import { EVM_EVENTS, EVM_METHODS, SOLANA_CHAINS, SOLANA_METHODS, TRON_CHAINS, TRON_METHODS, chainIdOf, planSession, sessionNamespaces } from '../shared/walletconnect/namespaces.js';
import { fromBase64, toBase64 } from '../shared/solana/core.js';
import * as b58 from '../shared/solana/base58.js';
import { parseTransaction } from '../shared/solana/tx.js';
import { keyOf as solKeyOf } from './solana.js';
import { keyOf as tronKeyOf } from './tron.js';
import { readTxs as readSolTxs } from './solanaDapp.js';
import { readTx as readTronTx, rejected } from './tronDapp.js';

const KEY = 'walletConnect'; // { [topic]: session } (see connect())
const PAIRINGS = 'wcPairings'; // { [topic]: { symKey, expiry, created } }: codes scanned, waiting for their proposal
const CLIENT = 'wcClientKey'; // the relay's client key (Ed25519, hex): Chakra's id on the relay
const SEEN = 'wcSeen'; // { "topic:id": time }: requests already handled (the relay may deliver one twice)
export const SITE = 'wc:'; // approvals and getState: "wc:<topic>"
const APP_VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';
const WEEK = 7 * 86400;
const SOL_MAINNET = -501, TRON_NILE = -196;
/** What the dapp sees of Chakra; it opens Chakra with redirect.native when it needs it (a request on the phone). */
export const METADATA = {
  name: 'Chakra', description: 'Chakra, an open-source wallet', url: 'https://chakrawallet.dev',
  icons: ['https://chakrawallet.dev/icon.png'], redirect: { native: 'chakra-wc://' },
};
// relay options of each message: [ttl (s), tag] (docs/specs/clients/sign/rpc-methods.md)
const OPT = {
  proposeOk: [300, 1101], proposeNo: [300, 1120], proposeAuto: [300, 1121],
  settle: [300, 1102], update: [86400, 1104], updateRes: [86400, 1105], extend: [86400, 1106], extendRes: [86400, 1107],
  requestRes: [300, 1109], event: [300, 1110], eventRes: [300, 1111], delete: [86400, 1112], deleteRes: [86400, 1113],
  pingRes: [86400, 1115], pairingDeleteRes: [86400, 1001], pairingPingRes: [30, 1003],
};
// the Ethereum calls answered from the node (a dapp may send them to the wallet)
const READ_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByHash',
  'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount',
  'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas', 'net_version',
]);

const nowSec = () => Math.floor(Date.now() / 1000);
const lc = (a) => String(a || '').toLowerCase();
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const err = (code, message) => Object.assign(new Error(message), { code });
const isAddressLike = (x) => /^0x[0-9a-f]{40}$/i.test(String(x || ''));
const rpcId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);
const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');

/** A dapp's metadata as it is shown: name, address, https icons only, every field bounded. */
function cleanMeta(m) {
  let url = str(m?.url, 300);
  try { url = new URL(url).href; } catch { url = ''; }
  const icons = (Array.isArray(m?.icons) ? m.icons : []).filter((u) => typeof u === 'string' && /^https:\/\/[^\s]{1,500}$/i.test(u)).slice(0, 3);
  return { name: str(m?.name, 80).trim() || hostOf(url) || '?', description: str(m?.description, 300), url, icons };
}
/** What the screens show of the dapp (stored with the pending request: see Site in ui/screens/approve.jsx). */
const remoteOf = (meta, verified) => ({
  name: meta.name, url: meta.url, host: hostOf(meta.url), icon: meta.icons[0] || '',
  validation: verified.validation, origin: verified.origin, isScam: !!verified.isScam,
});

/**
 * The WalletConnect "dapp family" for src/background/index.js (registerDappFamily).
 * kit: { requestApproval(site, kind, params, tab), ensureUnlocked(site, tab) }.
 * opts (tests): { relayUrl, verifyUrl, WebSocketImpl, fetchImpl, proposalWait (ms) }.
 */
export function walletConnectFamily({ requestApproval, ensureUnlocked }, opts = {}) {
  const proposals = new Map(); // "wc:<pairing topic>" -> the proposal waiting for the user (keys stay here, not in the screens)
  const waiters = new Map(); // pairing topic -> { arrived(), done(result) }: the code scanned, until its proposal is answered
  const answered = new Set(); // listeners: a request has been answered (the app may go back to the dapp)
  const mine = new Set(); // ids of the requests Chakra sent (never handled as the dapp's)
  const verify = verifier({ url: opts.verifyUrl || ENDPOINTS.wcVerify, fetchImpl: opts.fetchImpl });

  let keyPromise = null;
  const clientKey = () => (keyPromise ||= (async () => {
    let k = await local.get(CLIENT, null);
    if (!k) { k = newClientKey(); await local.set(CLIENT, k); }
    return k;
  })());
  const relay = new RelayClient({
    url: opts.relayUrl || ENDPOINTS.wcRelay, projectId: WALLETCONNECT_PROJECT_ID, ua: `wc-2/js-chakra-${APP_VERSION}/android`,
    clientKey, WebSocketImpl: opts.WebSocketImpl, onMessage: (m) => onMessage(m).catch((e) => console.warn('WalletConnect', e)),
  });

  // ---------------------------------------------------------------- storage
  const sessions = () => local.get(KEY, {});
  const pairings = () => local.get(PAIRINGS, {});
  const saveSession = (s) => local.update(KEY, {}, (all) => ({ ...all, [s.topic]: s }));
  const dropSession = (topic) => local.update(KEY, {}, (all) => { const n = { ...all }; delete n[topic]; return n; });
  const dropPairing = (topic) => local.update(PAIRINGS, {}, (all) => { const n = { ...all }; delete n[topic]; return n; });
  async function settingsOf() { return { ...DEFAULT_SETTINGS, ...(await local.get('settings', {})) }; }
  /** The session if it is alive and its account is in the active wallet. */
  async function sessionOf(topic) {
    const s = (await sessions())[topic];
    if (!s || s.expiry <= nowSec()) return null;
    const { accounts } = await vault.view();
    return accounts.some((a) => a.address === s.account) ? s : null;
  }
  /** First time this request is seen? (remembered for 3 days, the last 400) */
  async function firstTime(topic, id) {
    const k = `${topic}:${id}`, now = Date.now();
    let fresh = false;
    await local.update(SEEN, {}, (all) => {
      if (all[k]) return all;
      fresh = true;
      const keep = Object.entries(all).filter(([, t]) => now - t < 3 * 864e5).sort((a, b) => b[1] - a[1]).slice(0, 399);
      return Object.fromEntries([[k, now], ...keep]);
    });
    return fresh;
  }

  /** Follows the pairings waiting and the sessions of the active wallet (expired ones go). force: reconnect. */
  async function relisten({ force = false } = {}) {
    const now = nowSec();
    const all = await sessions();
    if (Object.values(all).some((s) => s.expiry <= now)) await local.update(KEY, {}, (x) => Object.fromEntries(Object.entries(x).filter(([, s]) => s.expiry > now)));
    const stale = Object.entries(await pairings()).filter(([, p]) => Date.now() - p.created > 3600e3);
    if (stale.length) await local.update(PAIRINGS, {}, (x) => Object.fromEntries(Object.entries(x).filter(([t]) => !stale.some(([s]) => s === t))));
    const { accounts } = await vault.view();
    const live = Object.values(await sessions()).filter((s) => accounts.some((a) => a.address === s.account)).map((s) => s.topic);
    const waiting = Object.entries(await pairings()).filter(([t, p]) => p.expiry > now || waiters.has(t) || proposals.has(SITE + t)).map(([t]) => t);
    await relay.setTopics([...live, ...waiting], { force });
  }

  // ---------------------------------------------------------------- sending
  async function reply(topic, symKey, id, res, [ttl, tag]) {
    const payload = res.error ? { id, jsonrpc: '2.0', error: res.error } : { id, jsonrpc: '2.0', result: res.result };
    await relay.publish(topic, seal(payload, symKey), { ttl, tag });
  }
  async function send(s, method, params, [ttl, tag]) {
    const id = rpcId();
    mine.add(id);
    await relay.publish(s.topic, seal({ id, jsonrpc: '2.0', method, params }, s.symKey), { ttl, tag });
    return id;
  }
  const emit = (s, name, data, chainId) => send(s, 'wc_sessionEvent', { event: { name, data }, chainId }, OPT.event).catch(() => {});

  // ---------------------------------------------------------------- incoming
  async function onMessage({ topic, message, attestation }) {
    const s = (await sessions())[topic];
    const pr = s ? null : (await pairings())[topic];
    const key = s?.symKey || pr?.symKey;
    if (!key) return;
    const payload = open(message, key);
    if (!payload || typeof payload !== 'object' || typeof payload.method !== 'string') return; // answers to Chakra's own requests: nothing to do
    if (!['number', 'string'].includes(typeof payload.id) || mine.has(payload.id)) return;
    if (!(await firstTime(topic, payload.id))) return;
    const ctx = { topic, payload, attestation, encryptedId: hashMessage(message) };
    if (s) await onSessionMessage(s, ctx);
    else await onPairingMessage(topic, pr, ctx);
  }

  async function onPairingMessage(topic, pr, ctx) {
    const { id, method } = ctx.payload;
    if (method === 'wc_sessionPropose') return onPropose(topic, pr, ctx);
    if (method === 'wc_pairingPing') return reply(topic, pr.symKey, id, { result: true }, OPT.pairingPingRes);
    if (method === 'wc_pairingDelete') { await reply(topic, pr.symKey, id, { result: true }, OPT.pairingDeleteRes).catch(() => {}); await dropPairing(topic); return relisten(); }
    // wc_sessionAuthenticate (one-click sign-in): a dapp sends a session proposal with it, and Chakra answers that
    return undefined;
  }

  async function onSessionMessage(s, { topic, payload }) {
    const { id, method } = payload;
    const r = (res, opt) => reply(topic, s.symKey, id, res, opt);
    switch (method) {
      case 'wc_sessionRequest': return onRequest(s, payload);
      case 'wc_sessionPing': return r({ result: true }, OPT.pingRes);
      case 'wc_sessionDelete':
        await dropSession(topic);
        await r({ result: true }, OPT.deleteRes).catch(() => {});
        return relisten();
      case 'wc_sessionEvent': return r({ result: true }, OPT.eventRes);
      case 'wc_sessionUpdate': return r({ error: { code: 3003, message: 'Unauthorized update request' } }, OPT.updateRes); // only the wallet updates
      case 'wc_sessionExtend': return r({ error: { code: 3004, message: 'Unauthorized extend request' } }, OPT.extendRes);
      default: return undefined;
    }
  }

  // ---------------------------------------------------------------- connecting
  /** The networks and methods Chakra can grant now: its networks switched on, by namespace. */
  async function supported() {
    const st = await settingsOf();
    const on = (id) => isChainEnabled(id, st);
    const out = {
      eip155: {
        chains: allChains(await local.get('customChains', [])).filter((c) => isEvm(c) && on(c.id)).map((c) => `eip155:${c.id}`),
        methods: st.allowEthSign ? [...EVM_METHODS, 'eth_sign'] : EVM_METHODS, events: EVM_EVENTS,
      },
    };
    const of = (map) => Object.keys(map).filter((c) => getChain(map[c]) && on(map[c]));
    if (getChain(SOL_MAINNET)) out.solana = { chains: of(SOLANA_CHAINS), methods: SOLANA_METHODS, events: [] };
    if (getChain(TRON_CHAINS['tron:0x2b6653dc'])) out.tron = { chains: of(TRON_CHAINS), methods: TRON_METHODS, events: [] };
    return out;
  }

  /** An account's address on each namespace of the plan (null: it has none there). */
  async function addressesOf(account, plan) {
    const acc = (await vault.view()).accounts.find((a) => a.address === account);
    if (!acc) return {};
    const out = {};
    if (plan.namespaces.eip155) out.eip155 = !familyOf(acc.type) ? getAddress(acc.address) : null;
    if (plan.namespaces.solana) out.solana = (await solKeyOf(account).catch(() => null))?.address || null;
    if (plan.namespaces.tron) out.tron = (await tronKeyOf(account).catch(() => null))?.address || null;
    return out;
  }

  /**
   * A code scanned or a link: pairs with the dapp and waits for its proposal -> { connected, name?, error?, code? }.
   * The same code twice at once (a link Android delivers twice) shares the first one's outcome.
   */
  const inflight = new Map(); // pairing topic -> the outcome
  async function openLink(url) {
    const link = parseWcLink(url);
    if (!link || link.kind === 'bad') throw i18nError(link?.reason === 'version' ? 'wc.err.v1' : 'wc.err.notLink');
    if (link.kind === 'open') { await relisten({ force: true }); return { connected: false, open: true }; }
    if (inflight.has(link.topic)) return inflight.get(link.topic);
    const p = pair(link);
    inflight.set(link.topic, p);
    try { return await p; } finally { inflight.delete(link.topic); }
  }

  async function pair(link) {
    if (link.expiry && link.expiry <= nowSec()) throw i18nError('wc.err.expired');
    if ((await sessions())[link.topic]) throw i18nError('wc.err.notLink');
    let arrived, done;
    const got = new Promise((r) => { arrived = r; });
    const result = new Promise((r) => { done = r; });
    waiters.set(link.topic, { arrived, done });
    try {
      await local.update(PAIRINGS, {}, (all) => ({ ...all, [link.topic]: { symKey: link.symKey, expiry: link.expiry || nowSec() + 300, created: Date.now() } }));
      await relisten();
      const came = await Promise.race([got.then(() => true), new Promise((r) => setTimeout(() => r(false), opts.proposalWait ?? 30000))]);
      if (!came) {
        await dropPairing(link.topic);
        await relisten();
        throw i18nError('wc.err.noProposal');
      }
      return await result;
    } finally { waiters.delete(link.topic); }
  }

  async function onPropose(pairingTopic, pr, { payload, attestation, encryptedId }) {
    const site = SITE + pairingTopic;
    const w = waiters.get(pairingTopic);
    w?.arrived();
    const { id, params: p = {} } = payload;
    let result;
    try {
      const pub = String(p.proposer?.publicKey || '');
      if (!/^[0-9a-f]{64}$/i.test(pub)) throw err(1006, 'Bad proposal');
      if (p.expiryTimestamp && Number(p.expiryTimestamp) <= nowSec()) throw i18nError('wc.err.expired');
      if (Array.isArray(p.relays) && p.relays.length && !p.relays.some((r) => r?.protocol === 'irn')) throw err(1006, 'Unsupported relay protocol');
      const meta = cleanMeta(p.proposer.metadata);
      const plan = planSession(p, await supported());
      const verified = await verify({ attestation, encryptedId, hash: hashMessage(JSON.stringify(payload)), declared: meta.url });
      const remote = remoteOf(meta, verified);
      const tab = { remote, title: meta.name, favIconUrl: remote.icon };
      await ensureUnlocked(site, tab);
      const { accounts, selected } = await vault.view();
      const candidates = [];
      for (const a of accounts) {
        const addresses = await addressesOf(a.address, plan);
        const { namespaces, lacking } = sessionNamespaces(plan, addresses);
        if (!lacking.length && Object.keys(namespaces).length) candidates.push({ account: a.address, addresses });
      }
      proposals.set(site, { id, pairingTopic, pairSymKey: pr.symKey, peer: { publicKey: pub.toLowerCase(), metadata: meta }, plan, verified, expiry: Number(p.expiryTimestamp) || 0 });
      const r = await requestApproval(site, 'wcConnect', {
        plan: { namespaces: plan.namespaces, required: plan.required, unsupported: plan.unsupported },
        candidates, current: candidates.some((c) => c.account === selected) ? selected : candidates[0]?.account || null,
      }, tab);
      result = { connected: true, name: r.name };
    } catch (e) {
      const no = e?.code === 4001;
      const error = no ? { code: 5000, message: 'User rejected.' } : { code: typeof e?.code === 'number' ? e.code : 5000, message: e?.key ? tEn(e.key, e.vars) : e?.message || 'Rejected' };
      await reply(pairingTopic, pr.symKey, id, { error }, no ? OPT.proposeNo : OPT.proposeAuto).catch(() => {});
      result = { connected: false, code: no ? 300 : error.code, error: no ? null : (e?.message || error.message) };
    } finally {
      proposals.delete(site);
      await dropPairing(pairingTopic);
      await relisten().catch(() => {});
    }
    w?.done(result);
    return result;
  }

  /** The user approved: the session's key and topic, the settlement, the answer to the proposal. */
  async function completeConnect(p, data) {
    const pr = proposals.get(p.origin);
    if (!pr) throw i18nError('errors.requestExpired');
    if (pr.expiry && pr.expiry <= nowSec()) throw i18nError('wc.err.expired');
    const addresses = await addressesOf(data.account, pr.plan);
    const { namespaces, lacking } = sessionNamespaces(pr.plan, addresses);
    if (lacking.length || !Object.keys(namespaces).length) throw i18nError('errors.accountUnavailable');
    const self = newKeyPair();
    const symKey = deriveSymKey(self.privateKey, pr.peer.publicKey);
    const s = {
      topic: topicOf(symKey), symKey, pairingTopic: pr.pairingTopic, self: self.publicKey, peer: pr.peer,
      account: data.account, addresses, namespaces, expiry: nowSec() + WEEK, verified: pr.verified, since: Date.now(),
    };
    await saveSession(s);
    try {
      await relisten();
      await send(s, 'wc_sessionSettle', { relay: { protocol: 'irn' }, namespaces, controller: { publicKey: self.publicKey, metadata: METADATA }, expiry: s.expiry }, OPT.settle);
      await reply(pr.pairingTopic, pr.pairSymKey, pr.id, { result: { relay: { protocol: 'irn' }, responderPublicKey: self.publicKey } }, OPT.proposeOk);
    } catch (e) {
      await dropSession(s.topic);
      await relisten().catch(() => {});
      throw e;
    }
    return { name: pr.peer.metadata.name, topic: s.topic };
  }

  // ---------------------------------------------------------------- requests
  async function onRequest(s, payload) {
    const { id, params } = payload;
    const req = params?.request;
    let res;
    try {
      if (!(await sessionOf(s.topic))) throw err(4100, 'The account of this session is not available');
      if (!req || typeof req.method !== 'string') throw err(-32602, 'Bad request');
      if (req.expiryTimestamp && Number(req.expiryTimestamp) <= nowSec()) throw err(8000, 'Request expired');
      const chain = String(params.chainId || '');
      const ns = chain.split(':')[0];
      const space = s.namespaces[ns];
      if (!space?.chains.includes(chain)) throw err(3005, `Unauthorized chain ${chain}`);
      if (!space.methods.includes(req.method)) throw err(3001, `Unauthorized method ${req.method}`);
      const chainId = chainIdOf(chain);
      if (!isChainEnabled(chainId, await settingsOf())) throw err(4901, 'This network is turned off in Chakra');
      const ctx = { s, site: SITE + s.topic, tab: tabOf(s), chain, chainId };
      const handler = { eip155: evmRequest, solana: solRequest, tron: tronRequest }[ns];
      if (!handler) throw err(5101, `Unsupported namespace ${ns}`);
      res = { result: (await handler(ctx, req.method, req.params)) ?? null };
    } catch (e) {
      res = { error: { code: typeof e?.code === 'number' ? e.code : -32603, message: e?.key ? tEn(e.key, e.vars) : e?.message || 'Error' } };
    }
    const ttl = Math.max(300, Math.min(WEEK, (Number(req?.expiryTimestamp) || 0) - nowSec()));
    await reply(s.topic, s.symKey, id, res, [ttl, OPT.requestRes[1]]);
    for (const fn of answered) fn({ ok: !res.error });
    await keepAlive(s.topic).catch(() => {});
  }

  /** A session in use lives on: a week again when less than half of it is left. */
  async function keepAlive(topic) {
    const s = await sessionOf(topic);
    if (!s || s.expiry - nowSec() > WEEK / 2) return;
    const expiry = nowSec() + WEEK;
    await saveSession({ ...s, expiry });
    await send(s, 'wc_sessionExtend', { expiry }, OPT.extend);
  }

  const tabOf = (s) => { const remote = remoteOf(s.peer.metadata, s.verified); return { remote, title: remote.name, favIconUrl: remote.icon }; };

  // Ethereum and its family: the in-app browser's screens and checks, on the request's network
  async function evmRequest({ s, site, tab, chainId }, method, params = []) {
    const me = s.addresses.eip155;
    const chain = getChain(chainId, await local.get('customChains', []));
    if (!chain || !isEvm(chain)) throw err(4902, 'Unrecognized chain');
    const p = Array.isArray(params) ? params : [];
    const isMe = (a) => { if (a && lc(a) !== lc(me)) throw err(4100, 'The requested account has not been authorized.'); };
    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts': return [me];
      case 'eth_chainId': return toHex(chainId);
      case 'personal_sign': {
        let [a, b] = p;
        if (isAddressLike(a) && !isAddressLike(b)) [a, b] = [b, a]; // some dapps swap the order
        if (typeof a !== 'string') throw err(-32602, 'Bad message');
        isMe(b);
        await ensureUnlocked(site, tab);
        return requestApproval(site, 'sign', [a, lc(me)], tab);
      }
      case 'eth_sign': {
        if (!(await settingsOf()).allowEthSign) throw err(4200, 'eth_sign is disabled for safety (it can be turned on in Settings → Advanced)');
        const [address, hash] = p;
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw err(-32602, 'eth_sign requires a 32-byte hash');
        isMe(address);
        await ensureUnlocked(site, tab);
        return requestApproval(site, 'ethSign', [lc(me), hash], tab);
      }
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4': {
        let [address, raw] = p;
        if (!isAddressLike(address) && isAddressLike(raw)) [address, raw] = [raw, address];
        isMe(address);
        let typed;
        try { typed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw err(-32602, 'Bad typed data'); }
        if (!typed || typeof typed !== 'object') throw err(-32602, 'Bad typed data');
        if (typed.domain?.chainId != null && Number(BigInt(typed.domain.chainId)) !== chainId) throw err(-32602, `Signature chainId (${typed.domain.chainId}) does not match the request's (${chainId})`);
        const t = { ...typed.types }; delete t.EIP712Domain;
        try { TypedDataEncoder.hash(typed.domain || {}, t, typed.message); } catch (e) { throw err(-32602, `Bad typed data: ${e.message}`); }
        await ensureUnlocked(site, tab);
        return requestApproval(site, 'typed', [lc(me), typed], tab);
      }
      case 'eth_sendTransaction': {
        const [tx] = p;
        if (!tx || typeof tx !== 'object') throw err(-32602, 'Missing transaction');
        isMe(tx.from);
        if (tx.chainId != null && Number(BigInt(tx.chainId)) !== chainId) throw err(-32602, 'Transaction chainId does not match the request');
        await ensureUnlocked(site, tab);
        return requestApproval(site, 'tx', [{ ...tx, from: lc(me), chainId: toHex(chainId) }], tab);
      }
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain': {
        let target;
        try { target = Number(BigInt(p[0]?.chainId)); } catch { throw err(-32602, 'Missing chainId'); }
        return switchTo(s, target, method);
      }
      case 'wallet_watchAsset': {
        const a = Array.isArray(params) ? params[0] : params;
        if (a?.type !== 'ERC20' || !a?.options?.address) throw err(-32602, 'Only ERC20 tokens are supported');
        const o = a.options;
        const token = { address: lc(getAddress(o.address)), symbol: String(o.symbol || '').slice(0, 12), decimals: Number(o.decimals ?? 18), name: String(o.symbol || ''), image: typeof o.image === 'string' ? o.image : '' };
        return requestApproval(site, 'watchAsset', { chainId, token }, tab);
      }
      default:
        if (READ_METHODS.has(method)) return rpc(chain, method, p);
        throw err(4200, `Chakra does not support this method: ${method}`);
    }
  }

  /**
   * The dapp moves to another network: one of the session's, at once; one Chakra has (switched on), added to the
   * session first (wc_sessionUpdate). Harmless: nothing is signed, the dapp is told (chainChanged).
   */
  async function switchTo(s, target, method) {
    const caip = `eip155:${target}`;
    if (!s.namespaces.eip155.chains.includes(caip)) {
      if (!(await supported()).eip155.chains.includes(caip)) throw err(method === 'wallet_addEthereumChain' ? 4200 : 4902, 'Unrecognized chain');
      const ns = s.namespaces.eip155;
      const namespaces = { ...s.namespaces, eip155: { ...ns, chains: [...ns.chains, caip], accounts: [...ns.accounts, `${caip}:${s.addresses.eip155}`] } };
      await saveSession({ ...s, namespaces });
      await send(s, 'wc_sessionUpdate', { namespaces }, OPT.update);
    }
    await emit(s, 'chainChanged', target, caip);
    return null;
  }

  // Solana: base64 transactions, base58 messages and signatures (WalletConnect's Solana RPC)
  async function solRequest({ s, site, tab, chainId }, method, p = {}) {
    const me = s.addresses.solana;
    const q = p && typeof p === 'object' ? p : {};
    switch (method) {
      case 'solana_getAccounts':
      case 'solana_requestAccounts': return [{ pubkey: me }];
      case 'solana_signTransaction':
      case 'solana_signAllTransactions':
      case 'solana_signAndSendTransaction': {
        const all = method === 'solana_signAllTransactions';
        const txs = readSolTxs(all ? q.transactions : [q.transaction], me);
        await ensureUnlocked(site, tab);
        const send = method === 'solana_signAndSendTransaction';
        const r = await requestApproval(site, send ? 'solTxSend' : 'solTx', {
          account: s.account, address: me, chainId, txs, send, options: { skipPreflight: !!q.sendOptions?.skipPreflight },
        }, tab);
        if (send) return { signature: r.signatures[0] };
        if (all) return { transactions: r.signed };
        return { signature: signatureOf(r.signed[0], me), transaction: r.signed[0] };
      }
      case 'solana_signMessage': {
        if (q.pubkey && q.pubkey !== me) throw err(4100, 'The requested account has not been authorized.');
        let bytes;
        try { bytes = b58.decode(String(q.message || '')); } catch { throw err(-32602, 'Bad message: base58 expected'); }
        if (!bytes.length || bytes.length > 15000) throw err(-32602, 'Bad message');
        await ensureUnlocked(site, tab);
        const r = await requestApproval(site, 'solSignMessage', { account: s.account, address: me, message: toBase64(bytes) }, tab);
        return { signature: b58.encode(fromBase64(r.signature)) };
      }
      default: throw err(4200, `Chakra does not support this method: ${method}`);
    }
  }

  // Tron: the transaction as TronWeb builds it (WalletConnect's Tron RPC, with or without the older extra wrapper)
  async function tronRequest({ s, site, tab, chainId }, method, p = {}) {
    const me = s.addresses.tron;
    const q = p && typeof p === 'object' ? p : {};
    if (q.address && q.address !== me) throw err(4100, 'The requested account has not been authorized.');
    switch (method) {
      case 'tron_signTransaction': {
        const tx = q.transaction?.transaction && typeof q.transaction.transaction === 'object' ? q.transaction.transaction : q.transaction;
        if (!tx || typeof tx !== 'object') throw err(-32602, 'Missing transaction');
        const { raw, d, forbidden } = readTronTx(tx, me);
        await ensureUnlocked(site, tab);
        if (forbidden) {
          await requestApproval(site, 'tronBlocked', { account: s.account, address: me, contracts: d.contracts.map((c) => c.type) }, tab).catch(() => {});
          throw rejected();
        }
        const r = await requestApproval(site, 'tronTx', { account: s.account, address: me, node: chainId === TRON_NILE ? 'nile' : 'mainnet', raw }, tab);
        return { ...tx, txID: r.txID, signature: [r.signature] };
      }
      case 'tron_signMessage': {
        const message = typeof q.message === 'string' ? q.message : '';
        if (!message || message.length > 20000) throw err(-32602, 'Bad message');
        await ensureUnlocked(site, tab);
        return requestApproval(site, 'tronSignMessage', { account: s.account, address: me, message, hex: false, version: 2 }, tab);
      }
      default: throw err(4200, `Chakra does not support this method: ${method}`);
    }
  }

  // the relay follows the sessions and the active wallet; when the app comes back, it reconnects at once
  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && (changes[KEY] || changes.activeWallet)) relisten().catch(() => {});
  });
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible') relisten({ force: true }).catch(() => {}); });
  relisten().catch(() => {});

  return {
    prefix: 'walletconnect_', // no page calls: WalletConnect's dapps are outside the app
    handle() { throw new Error('WalletConnect has no page calls'); },
    approvals: {
      wcConnect: { auth: () => false, complete: completeConnect },
    },
    /** UI handlers: a WalletConnect code from a QR code, a paste or a link that opened the app. */
    uiHandlers: { walletConnectLink: ({ url }) => openLink(url) },
    /** fn({ ok }) after each answer to a dapp's request. */
    onAnswered: (fn) => answered.add(fn),
    /** getState: the dapps connected with an account of the active wallet (Settings). */
    async state(view) {
      const accounts = new Set(view.accounts.map((a) => a.address));
      const now = nowSec();
      const list = Object.values(await sessions()).filter((s) => accounts.has(s.account) && s.expiry > now);
      return {
        wcSites: Object.fromEntries(list.map((s) => [SITE + s.topic, {
          account: s.account, name: s.peer.metadata.name, host: hostOf(s.peer.metadata.url), icon: s.peer.metadata.icons[0] || '',
          validation: s.verified?.validation || 'UNKNOWN', since: s.since, addresses: Object.values(s.addresses).filter(Boolean),
        }])),
      };
    },
    /** The user disconnects the dapp (Settings): the session goes and the dapp is told. */
    async disconnect(site) {
      if (!String(site).startsWith(SITE)) return;
      const topic = site.slice(SITE.length);
      const s = (await sessions())[topic];
      if (!s) return;
      await dropSession(topic);
      await send(s, 'wc_sessionDelete', { code: 6000, message: 'User disconnected.' }, OPT.delete).catch(() => {});
      await relisten().catch(() => {});
    },
    /** Tests: the relay client. */
    _relay: relay,
  };
}

/** The signature of an address in a signed Solana transaction (base64) -> base58. */
function signatureOf(b64, address) {
  const { signatures, msg } = parseTransaction(fromBase64(b64));
  const i = msg.keys.slice(0, msg.header.signatures).indexOf(address);
  return b58.encode(signatures[i]);
}
