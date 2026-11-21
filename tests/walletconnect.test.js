// WalletConnect (src/shared/walletconnect/*, src/background/walletconnect.js): the pairing links, the cryptography
// checked against Node's own (an independent X25519, HKDF, ChaCha20-Poly1305, Ed25519 and P-256), the namespaces
// granted, Verify, the relay client (a stand-in WebSocket) and the whole flow of the background with an in-memory relay
// and a dapp written here from the specs: pairing, proposal, approval or refusal, settlement, Ethereum / Solana / Tron
// requests, network switch, duplicates, disconnection from both sides.
import { resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as v from '../src/background/vault.js';
import '../src/background/families.js';
import { registerChains } from '../src/shared/chains.js';
import { SOL_CHAINS } from '../src/shared/solana/api.js';
import { TRON_CHAINS } from '../src/shared/tron/api.js';
import { parseWcLink } from '../src/shared/walletconnect/uri.js';
import * as wc from '../src/shared/walletconnect/crypto.js';
import { planSession, sessionNamespaces, chainIdOf } from '../src/shared/walletconnect/namespaces.js';
import { verifier } from '../src/shared/walletconnect/verify.js';
import { RelayClient } from '../src/shared/walletconnect/relay.js';
import { walletConnectFamily, METADATA } from '../src/background/walletconnect.js';
import { solanaDappFamily } from '../src/background/solanaDapp.js';
import { tronDappFamily } from '../src/background/tronDapp.js';
import { hdSeed, keyOfSeed, toBase64, fromBase64 } from '../src/shared/solana/core.js';
import { buildTransaction, parseTransaction, system } from '../src/shared/solana/tx.js';
import * as b58 from '../src/shared/solana/base58.js';
import { hdKey, recoverSigner, fromHex as tronHex } from '../src/shared/tron/core.js';
import { encodeRawData, decodeRawData } from '../src/shared/tron/proto.js';

registerChains(Object.values(SOL_CHAINS));
registerChains(Object.values(TRON_CHAINS));

const PHRASE = 'test test test test test test test test test test test junk';
const hex = (b) => Buffer.from(b).toString('hex');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) { const x = await fn(); if (x) return x; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await tick(5); }
}
const nowSec = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------ links
test('WalletConnect links', () => {
  const topic = 'ab'.repeat(32), key = 'cd'.repeat(32);
  const uri = `wc:${topic}@2?relay-protocol=irn&symKey=${key}&expiryTimestamp=1705667684&methods=[wc_sessionPropose],[wc_authRequest]`;
  const want = { kind: 'pair', topic, symKey: key, relay: { protocol: 'irn' }, expiry: 1705667684, methods: '[wc_sessionPropose],[wc_authRequest]' };
  assert.deepEqual(parseWcLink(uri), want);
  const upper = parseWcLink(` wc:${topic.toUpperCase()}@2?symKey=${key.toUpperCase()} `);
  assert.deepEqual([upper.topic, upper.symKey], [topic, key], 'hex in lower case');
  assert.deepEqual(parseWcLink(`chakra-wc://wc?uri=${encodeURIComponent(uri)}`), want, 'Chakra\'s own scheme');
  assert.deepEqual(parseWcLink('chakra-wc://'), { kind: 'open' });
  assert.deepEqual(parseWcLink('chakra-wc://wc?requestId=1&sessionTopic=ab'), { kind: 'open' });
  assert.equal(parseWcLink(`wc:${topic}@2?symKey=${key}`).relay.protocol, 'irn', 'irn by default');
  assert.equal(parseWcLink(`wc:${topic}@2?symKey=${key}&relay-protocol=irn&relay-data=0a`).relay.data, '0a');
  assert.deepEqual(parseWcLink('wc:8a5e5bdc-a0e4-4702-ba63-8f1a5655744f@1?bridge=https%3A%2F%2Fbridge.walletconnect.org&key=41791102999c'), { kind: 'bad', reason: 'version' });
  assert.equal(parseWcLink(`wc:${topic}@2?symKey=12`).reason, 'key');
  assert.equal(parseWcLink(`wc:xyz@2?symKey=${key}`).reason, 'topic');
  assert.equal(parseWcLink(`wc:${topic}@2?symKey=${key}&relay-protocol=waku`).reason, 'relay');
  for (const other of ['', 'tc://?v=2', 'https://example.org/wc:abc', 'ethereum:0x12', 'wcx:abc']) assert.equal(parseWcLink(other), null, other);
});

// ------------------------------------------------------------ cryptography, against Node's
const X_PRIV = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_PUB = Buffer.from('302a300506032b656e032100', 'hex');
const nodeShared = (priv, pub) => crypto.diffieHellman({
  privateKey: crypto.createPrivateKey({ key: Buffer.concat([X_PRIV, Buffer.from(priv, 'hex')]), format: 'der', type: 'pkcs8' }),
  publicKey: crypto.createPublicKey({ key: Buffer.concat([X_PUB, Buffer.from(pub, 'hex')]), format: 'der', type: 'spki' }),
});
const nodeSymKey = (priv, pub) => Buffer.from(crypto.hkdfSync('sha256', nodeShared(priv, pub), Buffer.alloc(0), Buffer.alloc(0), 32)).toString('hex');
function nodeSeal(obj, symKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('chacha20-poly1305', Buffer.from(symKey, 'hex'), iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([Buffer.from([0]), iv, ct, c.getAuthTag()]).toString('base64');
}
function nodeOpen(b64, symKey) {
  const b = Buffer.from(b64, 'base64');
  assert.equal(b[0], 0, 'type 0 envelope');
  const d = crypto.createDecipheriv('chacha20-poly1305', Buffer.from(symKey, 'hex'), b.subarray(1, 13), { authTagLength: 16 });
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]).toString());
}

test('keys, topics and envelopes match an independent implementation', () => {
  const a = wc.newKeyPair(), b = wc.newKeyPair();
  assert.match(a.publicKey, /^[0-9a-f]{64}$/);
  const k = wc.deriveSymKey(a.privateKey, b.publicKey);
  assert.equal(k, wc.deriveSymKey(b.privateKey, a.publicKey), 'both sides derive the same key');
  assert.equal(k, nodeSymKey(a.privateKey, b.publicKey), 'X25519 + HKDF-SHA256 as Node computes them');
  assert.equal(wc.topicOf(k), crypto.createHash('sha256').update(Buffer.from(k, 'hex')).digest('hex'));
  assert.equal(wc.hashMessage('ciao ✓'), crypto.createHash('sha256').update('ciao ✓').digest('hex'));

  const msg = { id: 1, jsonrpc: '2.0', method: 'wc_sessionRequest', params: { text: 'ciao ✓' } };
  assert.deepEqual(nodeOpen(wc.seal(msg, k), k), msg, 'sealed here, opened by Node');
  assert.deepEqual(wc.open(nodeSeal(msg, k), k), msg, 'sealed by Node, opened here');
  assert.equal(wc.open(wc.seal(msg, k), b.publicKey), null, 'wrong key');
  const tampered = Buffer.from(wc.seal(msg, k), 'base64'); tampered[20] ^= 1;
  assert.equal(wc.open(tampered.toString('base64'), k), null, 'tampered');
  assert.equal(wc.open('AAAA', k), null);
  const t1 = Buffer.concat([Buffer.from([1]), Buffer.from(a.publicKey, 'hex'), Buffer.from(nodeSeal(msg, k), 'base64').subarray(1)]).toString('base64');
  assert.deepEqual(wc.readEnvelope(t1).senderPublicKey, a.publicKey, 'type 1 envelope: the sender\'s key');
  assert.deepEqual(wc.open(t1, k), msg);
});

test('the relay\'s client authentication: an Ed25519 did:key JWT', () => {
  const key = wc.newClientKey();
  const jwt = wc.relayAuth(key, 'wss://relay.walletconnect.org', 1_700_000_000_000);
  const [h, p, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'EdDSA', typ: 'JWT' });
  const pl = dec(p);
  assert.equal(pl.aud, 'wss://relay.walletconnect.org');
  assert.deepEqual([pl.iat, pl.exp], [1_700_000_000, 1_700_086_400]);
  assert.match(pl.sub, /^[0-9a-f]{64}$/);
  assert.equal(pl.iss, wc.clientDid(key));
  const raw = b58.decode(pl.iss.slice('did:key:z'.length));
  assert.deepEqual([raw[0], raw[1], raw.length], [0xed, 0x01, 34]);
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw.subarray(2))]), format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url')), 'signature checked by Node');
  assert.notEqual(wc.relayAuth(key, 'x').split('.')[1], wc.relayAuth(key, 'x').split('.')[1], 'a new subject every time');
});

// ------------------------------------------------------------ Verify
function verifyServer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const sign = (payload) => {
    const data = `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${data}.${crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const registered = new Map(); // hash -> { origin, isScam }
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.pathname === '/v3/public-key') return { status: 200, json: async () => ({ publicKey: { ...jwk, key_ops: ['verify'], ext: true }, expiresAt: nowSec() + 3600 }) };
    const m = /^\/attestation\/([0-9a-f]+)$/.exec(u.pathname);
    if (m && registered.has(m[1])) return { status: 200, json: async () => registered.get(m[1]) };
    return { status: 404, json: async () => ({}) };
  };
  return { sign, fetchImpl, registered, calls };
}

test('Verify: attestations signed by the server, the older lookup, and what can\'t be told', async () => {
  const srv = verifyServer();
  const verify = verifier({ url: 'https://verify.test', fetchImpl: srv.fetchImpl });
  const exp = nowSec() + 300;
  const jwt = (p) => srv.sign({ exp, id: 'e1', isScam: false, isVerified: true, ...p });
  assert.deepEqual(await verify({ attestation: jwt({ origin: 'https://app.uniswap.org' }), encryptedId: 'e1', declared: 'https://app.uniswap.org/swap' }),
    { origin: 'https://app.uniswap.org', validation: 'VALID', isScam: false });
  assert.deepEqual(await verify({ attestation: jwt({ origin: 'https://evil.example' }), encryptedId: 'e1', declared: 'https://app.uniswap.org' }),
    { origin: 'https://evil.example', validation: 'INVALID', isScam: false }, 'the page that sent it is another site');
  assert.equal((await verify({ attestation: jwt({ origin: 'https://x.org', isScam: true }), encryptedId: 'e1', declared: 'https://x.org' })).isScam, true);
  assert.equal((await verify({ attestation: jwt({ origin: 'https://x.org' }), encryptedId: 'other', declared: 'https://x.org' })).validation, 'UNKNOWN', 'bound to another message');
  assert.equal((await verify({ attestation: jwt({ origin: 'https://x.org', exp: nowSec() - 1 }), encryptedId: 'e1', declared: 'https://x.org' })).validation, 'UNKNOWN', 'expired');
  assert.equal((await verify({ attestation: jwt({ origin: 'https://x.org', isVerified: false }), encryptedId: 'e1', declared: 'https://x.org' })).validation, 'UNKNOWN', 'origin not verified');
  const forged = jwt({ origin: 'https://x.org' }).split('.');
  forged[1] = Buffer.from(JSON.stringify({ exp, id: 'e1', origin: 'https://evil.example', isVerified: true })).toString('base64url');
  assert.equal((await verify({ attestation: forged.join('.'), encryptedId: 'e1', declared: 'https://x.org' })).validation, 'UNKNOWN', 'a forged payload');
  assert.equal(srv.calls.filter((c) => c.endsWith('/v3/public-key')).length, 2, 'the key is kept (fetched again once for the forged one)');
  // dapps that register their attestation on the server: asked by the hash of the message
  srv.registered.set('ab12', { origin: 'https://app.example.org' });
  assert.deepEqual(await verify({ attestation: null, hash: 'ab12', declared: 'https://app.example.org' }), { origin: 'https://app.example.org', validation: 'VALID', isScam: false });
  assert.deepEqual(await verify({ attestation: null, hash: 'ffff', declared: 'https://app.example.org/' }), { origin: 'https://app.example.org', validation: 'UNKNOWN', isScam: false });
  const down = verifier({ url: 'https://verify.test', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await down({ attestation: jwt({ origin: 'https://x.org' }), encryptedId: 'e1', hash: 'ab', declared: 'https://x.org' })).validation, 'UNKNOWN');
});

// ------------------------------------------------------------ namespaces
test('namespaces: what Chakra grants for a proposal', () => {
  const sup = {
    eip155: { chains: ['eip155:1', 'eip155:137', 'eip155:8453'], methods: ['personal_sign', 'eth_sendTransaction'], events: ['chainChanged', 'accountsChanged'] },
    solana: { chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], methods: ['solana_signMessage'], events: [] },
  };
  // AppKit's way: everything optional; unknown chains left out, not refused
  const p1 = planSession({ requiredNamespaces: {}, optionalNamespaces: { eip155: { chains: ['eip155:1', 'eip155:10', 'eip155:137'], methods: ['personal_sign', 'eth_signTransaction'], events: ['chainChanged'] } } }, sup);
  assert.deepEqual(p1.namespaces, { eip155: { chains: ['eip155:1', 'eip155:137'], methods: ['personal_sign', 'eth_sendTransaction'], events: ['chainChanged', 'accountsChanged'] } });
  assert.deepEqual([p1.required, p1.unsupported], [[], ['eip155:10']]);
  // required methods are granted (refused at request time if Chakra lacks them), CAIP-2 keys folded in
  const p2 = planSession({ requiredNamespaces: { eip155: { chains: ['eip155:1'], methods: ['eth_signTransaction'], events: ['message'] }, 'eip155:8453': { methods: ['personal_sign'], events: [] } } }, sup);
  assert.deepEqual(p2.namespaces.eip155.chains, ['eip155:1', 'eip155:8453']);
  assert.ok(p2.namespaces.eip155.methods.includes('eth_signTransaction') && p2.namespaces.eip155.events.includes('message'));
  assert.deepEqual(p2.required, ['eip155']);
  // refused: a required chain Chakra doesn't have, a malformed proposal, nothing in common
  assert.throws(() => planSession({ requiredNamespaces: { eip155: { chains: ['eip155:1', 'eip155:10'], methods: [], events: [] } } }, sup), (e) => e.code === 5100 && e.missing.join() === 'eip155:10');
  assert.throws(() => planSession({ requiredNamespaces: { cosmos: { chains: ['cosmos:cosmoshub-4'], methods: [], events: [] } } }, sup), (e) => e.code === 5100);
  assert.throws(() => planSession({ requiredNamespaces: { eip155: { chains: [], methods: [], events: [] } } }, sup), (e) => e.code === 5100);
  assert.throws(() => planSession({ requiredNamespaces: { eip155: { chains: ['42'], methods: [], events: [] } } }, sup), (e) => e.code === 5100);
  assert.throws(() => planSession({ requiredNamespaces: { eip155: { chains: ['eip155:1', 'cosmos:cosmoshub-4'] } } }, sup), (e) => e.code === 5100);
  assert.throws(() => planSession({ requiredNamespaces: { '**': { chains: ['**:1'] } } }, sup), (e) => e.code === 5104);
  assert.throws(() => planSession({ optionalNamespaces: { polkadot: { chains: ['polkadot:91b171bb158e2d3848fa23a9f1c25182'] } } }, sup), (e) => e.code === 5100);
  // nothing asked: Ethereum's family
  assert.deepEqual(planSession({}, sup).namespaces.eip155.chains, sup.eip155.chains);

  // the session: the account's address on every chain; a required namespace without one can't be granted
  const p3 = planSession({ requiredNamespaces: { eip155: { chains: ['eip155:1'] } }, optionalNamespaces: { solana: { chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] } } }, sup);
  assert.deepEqual(sessionNamespaces(p3, { eip155: '0xAb', solana: 'So1' }).namespaces, {
    eip155: { chains: ['eip155:1'], accounts: ['eip155:1:0xAb'], methods: sup.eip155.methods, events: sup.eip155.events },
    solana: { chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], accounts: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:So1'], methods: ['solana_signMessage'], events: [] },
  });
  assert.deepEqual(Object.keys(sessionNamespaces(p3, { eip155: '0xAb', solana: null }).namespaces), ['eip155'], 'optional: left out');
  assert.deepEqual(sessionNamespaces(p3, { eip155: null, solana: 'So1' }).lacking, ['eip155']);
  assert.deepEqual([chainIdOf('eip155:8453'), chainIdOf('solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ'), chainIdOf('tron:0xcd8690dc'), chainIdOf('eip155:x'), chainIdOf('cosmos:hub')], [8453, -501, -196, null, null]);
});

// ------------------------------------------------------------ an in-memory relay
function memoryRelay() {
  const subs = new Map(); // topic -> Set(socket)
  const mailbox = new Map(); // topic -> [data]
  const published = []; // what Chakra published: { topic, message, ttl, tag }
  const sockets = [];
  const urls = [];
  let n = 0;
  const opts = { autoOpen: true, dropFirstAck: false };
  const deliver = (ws, data) => { const id = ++n; ws.unacked.add(id); setTimeout(() => ws.onmessage?.({ data: JSON.stringify({ id, jsonrpc: '2.0', method: 'irn_subscription', params: { id: 'sub', data } }) }), 0); };
  const flush = (topic) => {
    const list = mailbox.get(topic) || [];
    const ws = [...(subs.get(topic) || [])][0];
    if (!ws || !list.length) return;
    mailbox.delete(topic);
    for (const d of list) deliver(ws, d);
  };
  class FakeWS {
    constructor(url) {
      this.url = url; this.closed = false; this.unacked = new Set();
      urls.push(url); sockets.push(this);
      if (opts.autoOpen) setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0);
    }
    send(text) {
      const m = JSON.parse(text);
      const answer = (result) => setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify({ id: m.id, jsonrpc: '2.0', result }) }), 0);
      if (!m.method) { this.unacked.delete(m.id); return; } // an acknowledgment
      if (m.method === 'irn_subscribe' || m.method === 'irn_batchSubscribe') {
        const topics = m.params.topics || [m.params.topic];
        for (const t of topics) { if (!subs.has(t)) subs.set(t, new Set()); subs.get(t).add(this); }
        answer(m.params.topics ? topics.map((t) => `s-${t.slice(0, 6)}`) : `s-${topics[0].slice(0, 6)}`);
        setTimeout(() => topics.forEach(flush), 1);
      } else if (m.method === 'irn_unsubscribe') { subs.get(m.params.topic)?.delete(this); answer(true); }
      else if (m.method === 'irn_publish') { published.push(m.params); answer(true); }
      else answer(null);
    }
    close() { this.closed = true; for (const s of subs.values()) s.delete(this); }
  }
  return {
    FakeWS, published, sockets, urls, opts,
    live: () => sockets.filter((s) => !s.closed),
    subscribed: (topic) => [...(subs.get(topic) || [])].some((s) => !s.closed),
    /** The dapp publishes: delivered now to a subscriber, else kept in the mailbox. */
    inject(topic, message, attestation = null) {
      const data = { topic, message, attestation, publishedAt: Date.now(), tag: 0 };
      const ws = [...(subs.get(topic) || [])].find((s) => !s.closed);
      if (ws) deliver(ws, data); else mailbox.set(topic, [...(mailbox.get(topic) || []), data]);
    },
    /** Delivers again what Chakra received last on a topic (the relay may do it). */
    redeliver(topic, message) { const ws = [...(subs.get(topic) || [])].find((s) => !s.closed); deliver(ws, { topic, message, attestation: null, publishedAt: Date.now(), tag: 0 }); },
  };
}

test('relay client: authentication, subscriptions, acknowledgments, publishing, reconnection', async () => {
  const r = memoryRelay();
  const got = [];
  const c = new RelayClient({ url: 'wss://relay.test', projectId: 'pid', ua: 'wc-2/js-chakra/android', clientKey: async () => '11'.repeat(32), WebSocketImpl: r.FakeWS, onMessage: (m) => got.push(m), timeout: 2000 });
  await c.setTopics(['aa'.repeat(32)]);
  await c.ready(1000);
  const u = new URL(r.urls[0]);
  assert.equal(`${u.protocol}//${u.host}`, 'wss://relay.test');
  assert.deepEqual([u.searchParams.get('projectId'), u.searchParams.get('ua')], ['pid', 'wc-2/js-chakra/android']);
  assert.equal(u.searchParams.get('auth').split('.').length, 3);
  assert.ok(r.subscribed('aa'.repeat(32)));
  r.inject('aa'.repeat(32), 'SEALED', 'jwt');
  await until(() => got.length, 'the message');
  assert.deepEqual([got[0].topic, got[0].message, got[0].attestation], ['aa'.repeat(32), 'SEALED', 'jwt']);
  await until(() => !r.sockets[0].unacked.size, 'acknowledged');

  // a topic more: subscribed on the same connection; one less: unsubscribed
  await c.setTopics(['aa'.repeat(32), 'bb'.repeat(32)]);
  assert.equal(r.sockets.length, 1);
  assert.ok(r.subscribed('bb'.repeat(32)));
  await c.setTopics(['bb'.repeat(32)]);
  await until(() => !r.subscribed('aa'.repeat(32)), 'unsubscribed');
  assert.equal(await c.publish('cc'.repeat(32), 'OUT', { ttl: 300, tag: 1109 }), true);
  assert.deepEqual(r.published.at(-1), { topic: 'cc'.repeat(32), message: 'OUT', ttl: 300, tag: 1109 });

  // the connection drops: back by itself, subscriptions again (and the mailbox with them)
  r.sockets[0].close(); r.sockets[0].onclose();
  r.inject('bb'.repeat(32), 'WHILE AWAY');
  await until(() => r.live().length === 1 && r.subscribed('bb'.repeat(32)), 'reconnected', 3000);
  await until(() => got.some((m) => m.message === 'WHILE AWAY'), 'the message kept by the relay');
  assert.notEqual(new URL(r.urls[1]).searchParams.get('auth'), new URL(r.urls[0]).searchParams.get('auth'), 'a new JWT');
  // forced (the app is back on screen): a new connection
  await c.setTopics(['bb'.repeat(32)], { force: true });
  await until(() => r.sockets.length === 3 && r.live().length === 1, 'forced reconnection');
  c.stop();
  assert.equal(r.live().length, 0);
});

// ------------------------------------------------------------ the whole flow
/** A dapp, as the specs describe it: pairing, proposal, then requests on the session. */
function dappSide(r, { required = {}, optional = {}, metadata = { name: 'Example', url: 'https://app.example.org', icons: ['https://app.example.org/i.png'] } } = {}) {
  const pairing = { topic: hex(crypto.randomBytes(32)), symKey: hex(crypto.randomBytes(32)) };
  const self = wc.newKeyPair();
  let session = null, id = 100;
  const fromChakra = (topic, since = 0) => r.published.slice(since).filter((x) => x.topic === topic);
  return {
    pairing, self,
    uri: `wc:${pairing.topic}@2?relay-protocol=irn&symKey=${pairing.symKey}&expiryTimestamp=${nowSec() + 300}`,
    propose(extra = {}) {
      const payload = { id: 1, jsonrpc: '2.0', method: 'wc_sessionPropose', params: { requiredNamespaces: required, optionalNamespaces: optional, relays: [{ protocol: 'irn' }], proposer: { publicKey: self.publicKey, metadata }, expiryTimestamp: nowSec() + 300, ...extra } };
      r.inject(pairing.topic, wc.seal(payload, pairing.symKey));
      return payload;
    },
    /** The answer to the proposal on the pairing topic, and (approved) the settlement on the session topic. */
    async answer() {
      const m = await until(() => fromChakra(pairing.topic).at(-1), 'the answer to the proposal');
      const res = wc.open(m.message, pairing.symKey);
      if (res.error) return { res, tag: m.tag };
      const symKey = wc.deriveSymKey(self.privateKey, res.result.responderPublicKey);
      session = { topic: wc.topicOf(symKey), symKey };
      const st = await until(() => fromChakra(session.topic)[0], 'the settlement');
      return { res, tag: m.tag, settle: wc.open(st.message, symKey), settleTag: st.tag };
    },
    get session() { return session; },
    send(method, params, raw) {
      const msg = raw || { id: ++id, jsonrpc: '2.0', method, params };
      const sealed = wc.seal(msg, session.symKey);
      r.inject(session.topic, sealed);
      return { msg, sealed };
    },
    async request(chainId, method, params) {
      const since = r.published.length;
      const { msg } = this.send('wc_sessionRequest', { request: { method, params }, chainId });
      const m = await until(() => fromChakra(session.topic, since).map((x) => ({ ...x, body: wc.open(x.message, session.symKey) })).find((x) => x.body.id === msg.id), `the answer to ${method}`);
      return { ...m.body, tag: m.tag, ttl: m.ttl };
    },
    /** Chakra's own requests on the session (events, updates, delete). */
    sent: (since = 0) => fromChakra(session.topic, since).map((x) => ({ ...wc.open(x.message, session.symKey), tag: x.tag })).filter((x) => x.method),
  };
}

test('WalletConnect: pairing, approval, requests on three families, disconnection', { timeout: 300000 }, async () => {
  await reset();
  await v.createVault('walletpw1', PHRASE, 'Main');
  await v.unlock('walletpw1');
  const hd0 = (await v.view()).accounts[0].address;
  const evm = (await v.view()).accounts[0].address.toLowerCase();
  const sol = keyOfSeed(hdSeed(PHRASE, 0)).address;
  const tron = hdKey(PHRASE, 0).address;
  const r = memoryRelay();
  const srv = verifyServer();
  const asked = [];
  let answer = 'yes', unlocks = 0;
  const kit = {
    async requestApproval(site, kind, params, tab) {
      asked.push({ site, kind, params, tab });
      if (answer === 'no') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (kind === 'wcConnect') return family.approvals.wcConnect.complete({ origin: site, kind, params }, { account: answer === 'yes' ? hd0 : answer });
      if (kind.startsWith('sol')) return solana.approvals[kind].complete({ origin: site, kind, params }, {});
      if (kind.startsWith('tron')) { if (kind === 'tronBlocked') throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); return tronFam.approvals[kind].complete({ origin: site, kind, params }, {}); }
      return `ok:${kind}`; // Ethereum's kinds are completed by background/index.js (tested there)
    },
    ensureUnlocked: async () => { unlocks++; },
  };
  const solana = solanaDappFamily({ ...kit, emitToOrigin: async () => {} });
  const tronFam = tronDappFamily({ ...kit, emitToOrigin: async () => {} });
  const family = walletConnectFamily(kit, { relayUrl: 'wss://relay.test', verifyUrl: 'https://verify.test', WebSocketImpl: r.FakeWS, fetchImpl: srv.fetchImpl, proposalWait: 3000 });
  const answered = [];
  family.onAnswered((x) => answered.push(x));
  const link = (url) => family.uiHandlers.walletConnectLink({ url });

  // codes that can't connect
  await assert.rejects(() => link('wc:abc@1?bridge=x&key=y'), (e) => e.key === 'wc.err.v1');
  await assert.rejects(() => link('https://example.org'), (e) => e.key === 'wc.err.notLink');
  await assert.rejects(() => link(`wc:${'ab'.repeat(32)}@2?symKey=${'cd'.repeat(32)}&relay-protocol=irn&expiryTimestamp=${nowSec() - 5}`), (e) => e.key === 'wc.err.expired');
  const silent = dappSide(r);
  await assert.rejects(() => link(silent.uri), (e) => e.key === 'wc.err.noProposal');
  assert.equal(r.subscribed(silent.pairing.topic), false, 'the pairing is dropped');

  // declined by the user: the dapp gets 5000 with the "rejected" tag
  const d0 = dappSide(r, { optional: { eip155: { chains: ['eip155:1'], methods: ['personal_sign'], events: [] } } });
  d0.propose();
  answer = 'no';
  const no = await link(d0.uri);
  assert.deepEqual([no.connected, no.code], [false, 300]);
  const a0 = await d0.answer();
  assert.deepEqual([a0.res.error.code, a0.tag], [5000, 1120]);
  answer = 'yes';

  // a required network Chakra doesn't have: refused without asking, tag "auto reject"
  const d1 = dappSide(r, { required: { eip155: { chains: ['eip155:99999999'], methods: ['personal_sign'], events: [] } } });
  d1.propose();
  const n1 = asked.length;
  const bad = await link(d1.uri);
  assert.equal(bad.connected, false);
  const a1 = await d1.answer();
  assert.deepEqual([a1.res.error.code, a1.tag], [5100, 1121]);
  assert.equal(asked.length, n1, 'nothing asked');

  // connected: Ethereum (Polygon besides; Optimism's id isn't asked as required), Solana and Tron optional
  const d = dappSide(r, {
    required: { eip155: { chains: ['eip155:1'], methods: ['personal_sign', 'eth_sendTransaction'], events: ['chainChanged', 'accountsChanged'] } },
    optional: {
      eip155: { chains: ['eip155:137', 'eip155:424242'], methods: ['eth_signTypedData_v4', 'wallet_switchEthereumChain'], events: [] },
      solana: { chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], methods: ['solana_signMessage', 'solana_signTransaction'], events: [] },
      tron: { chains: ['tron:0x2b6653dc'], methods: ['tron_signTransaction', 'tron_signMessage'], events: [] },
    },
  });
  const proposal = d.propose();
  const ok = await link(d.uri);
  assert.deepEqual([ok.connected, ok.name], [true, 'Example']);
  const ask = asked.findLast((x) => x.kind === 'wcConnect');
  assert.equal(ask.site, `wc:${d.pairing.topic}`);
  assert.deepEqual(ask.params.plan.unsupported, ['eip155:424242']);
  assert.deepEqual(ask.params.candidates[0], { account: hd0, addresses: { eip155: (await v.view()).accounts[0].address, solana: sol, tron } });
  assert.equal(ask.params.current, hd0);
  assert.deepEqual(ask.tab.remote, { name: 'Example', url: 'https://app.example.org/', host: 'app.example.org', icon: 'https://app.example.org/i.png', validation: 'UNKNOWN', origin: 'https://app.example.org', isScam: false });
  assert.ok(srv.calls.some((c) => c.includes(`/attestation/${wc.hashMessage(JSON.stringify(proposal))}`)), 'Verify asked by the hash of the proposal');
  const a = await d.answer();
  assert.equal(a.tag, 1101);
  assert.deepEqual(a.res.result.relay, { protocol: 'irn' });
  assert.equal(a.settleTag, 1102);
  const st = a.settle.params;
  assert.equal(a.settle.method, 'wc_sessionSettle');
  assert.deepEqual(st.controller, { publicKey: a.res.result.responderPublicKey, metadata: METADATA });
  assert.ok(st.expiry > nowSec() + 6 * 86400);
  const checksum = (await v.view()).accounts[0].address;
  assert.deepEqual(st.namespaces.eip155.accounts, [`eip155:1:${checksum}`, `eip155:137:${checksum}`]);
  assert.deepEqual(st.namespaces.solana.accounts, [`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${sol}`]);
  assert.deepEqual(st.namespaces.tron.accounts, [`tron:0x2b6653dc:${tron}`]);
  assert.ok(st.namespaces.eip155.methods.includes('eth_sendTransaction'));
  assert.ok(r.subscribed(d.session.topic), 'listening to the session');
  assert.equal(r.subscribed(d.pairing.topic), false, 'the pairing has done its job');
  const site = `wc:${d.session.topic}`;
  const state = (await family.state(await v.view())).wcSites[site];
  assert.deepEqual([state.name, state.host, state.account, state.validation], ['Example', 'app.example.org', hd0, 'UNKNOWN']);

  // Ethereum: the same approvals as the in-app browser, on the request's network
  const s1 = await d.request('eip155:1', 'personal_sign', ['0x68656c6c6f', checksum]);
  assert.deepEqual([s1.result, s1.tag], ['ok:sign', 1109]);
  assert.deepEqual(asked.at(-1).params, ['0x68656c6c6f', evm]);
  assert.equal(asked.at(-1).site, site);
  assert.equal(asked.at(-1).tab.remote.name, 'Example');
  const t1 = await d.request('eip155:137', 'eth_sendTransaction', [{ from: checksum, to: '0x000000000000000000000000000000000000dEaD', value: '0x1' }]);
  assert.equal(t1.result, 'ok:tx');
  assert.deepEqual(asked.at(-1).params[0], { from: evm, to: '0x000000000000000000000000000000000000dEaD', value: '0x1', chainId: '0x89' }, 'the network goes with the transaction');
  const typed = { types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Mail: [{ name: 'x', type: 'string' }] }, primaryType: 'Mail', domain: { chainId: 1 }, message: { x: 'hi' } };
  assert.equal((await d.request('eip155:1', 'eth_signTypedData_v4', [checksum, JSON.stringify(typed)])).result, 'ok:typed');
  assert.match((await d.request('eip155:137', 'eth_signTypedData_v4', [checksum, JSON.stringify(typed)])).error.message, /does not match/);
  assert.deepEqual((await d.request('eip155:1', 'eth_accounts', [])).result, [checksum]);
  assert.equal((await d.request('eip155:1', 'eth_chainId', [])).result, '0x1');
  // refused before any screen: another account, a chain or a method outside the session, an expired request
  const n2 = asked.length;
  assert.equal((await d.request('eip155:1', 'personal_sign', ['0x00', '0x000000000000000000000000000000000000dEaD'])).error.code, 4100);
  assert.equal((await d.request('eip155:10', 'personal_sign', ['0x00', checksum])).error.code, 3005);
  assert.equal((await d.request('eip155:1', 'eth_signTransaction', [{}])).error.code, 3001);
  const since = r.published.length;
  const late = d.send('wc_sessionRequest', { request: { method: 'personal_sign', params: ['0x00', checksum], expiryTimestamp: nowSec() - 1 }, chainId: 'eip155:1' });
  const lateAns = await until(() => r.published.slice(since).map((x) => wc.open(x.message, d.session.symKey)).find((x) => x.id === late.msg.id), 'expired');
  assert.equal(lateAns.error.code, 8000);
  assert.equal(asked.length, n2);
  // declined on the screen: the dapp gets 4001
  answer = 'no';
  const rej = await d.request('eip155:1', 'personal_sign', ['0x00', checksum]);
  assert.deepEqual([rej.error.code, rej.error.message], [4001, 'User rejected the request.']);
  answer = 'yes';
  assert.deepEqual(answered.at(-1), { ok: false });

  // the relay delivers a request twice: one screen only
  const n3 = asked.length;
  const twice = d.send('wc_sessionRequest', { request: { method: 'personal_sign', params: ['0x01', checksum] }, chainId: 'eip155:1' });
  await until(() => asked.length === n3 + 1, 'the request');
  r.redeliver(d.session.topic, twice.sealed);
  await tick(50);
  assert.equal(asked.length, n3 + 1);

  // network switch: in the session at once; a network Chakra has is added (wc_sessionUpdate); unknown: 4902
  let mark = r.published.length;
  assert.equal((await d.request('eip155:1', 'wallet_switchEthereumChain', [{ chainId: '0x89' }])).result, null);
  await until(() => d.sent(0).some((x) => x.method === 'wc_sessionEvent'), 'chainChanged');
  const ev = d.sent(0).findLast((x) => x.method === 'wc_sessionEvent');
  assert.deepEqual([ev.params, ev.tag], [{ event: { name: 'chainChanged', data: 137 }, chainId: 'eip155:137' }, 1110]);
  mark = d.sent(0).length;
  assert.equal((await d.request('eip155:1', 'wallet_switchEthereumChain', [{ chainId: '0x2105' }])).result, null);
  const upd = d.sent(0).slice(mark).find((x) => x.method === 'wc_sessionUpdate');
  assert.ok(upd.params.namespaces.eip155.accounts.includes(`eip155:8453:${checksum}`));
  assert.equal(upd.tag, 1104);
  assert.equal((await d.request('eip155:8453', 'personal_sign', ['0x02', checksum])).result, 'ok:sign', 'Base is in the session now');
  assert.equal((await d.request('eip155:1', 'wallet_switchEthereumChain', [{ chainId: '0x5f5e0ff' }])).error.code, 4902);

  // Solana: signed for real by the Solana family's approval; signatures in base58
  const solTx = toBase64(buildTransaction({ payer: sol, recentBlockhash: '11111111111111111111111111111111', instructions: [system.transfer(sol, keyOfSeed(new Uint8Array(32).fill(3)).address, 1000n)] }));
  const sx = await d.request('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana_signTransaction', { transaction: solTx });
  const signed = parseTransaction(fromBase64(sx.result.transaction));
  assert.equal(sx.result.signature, b58.encode(signed.signatures[0]));
  assert.ok(crypto.verify(null, Buffer.from(signed.message), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b58.decode(sol))]), format: 'der', type: 'spki' }), Buffer.from(signed.signatures[0])));
  assert.equal(asked.at(-1).kind, 'solTx');
  const sm = await d.request('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana_signMessage', { message: b58.encode(Buffer.from('hello')), pubkey: sol });
  assert.ok(crypto.verify(null, Buffer.from('hello'), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b58.decode(sol))]), format: 'der', type: 'spki' }), Buffer.from(b58.decode(sm.result.signature))));
  assert.deepEqual((await d.request('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana_getAccounts', {})).result, [{ pubkey: sol }], 'granted though not asked');

  // Tron: the transaction object back with its signature (also in the older wrapper)
  const REF = { ref_block_bytes: '73d8', ref_block_hash: 'b696cdb94aea2633' };
  const raw = encodeRawData({ contract: { type: 'TransferContract', parameter: { owner_address: tron, to_address: hdKey(PHRASE, 1).address, amount: 1 } }, ref: REF, expiration: 1795004291000, timestamp: 1795004231554 });
  const { txID } = decodeRawData(raw);
  for (const wrap of [(x) => x, (x) => ({ transaction: x })]) {
    const tr = await d.request('tron:0x2b6653dc', 'tron_signTransaction', { address: tron, transaction: wrap({ txID, raw_data_hex: raw, visible: false }) });
    assert.deepEqual([tr.result.txID, tr.result.raw_data_hex, tr.result.signature.length], [txID, raw, 1]);
    assert.equal(recoverSigner(tronHex(txID), tr.result.signature[0]), tron);
  }
  const tm = await d.request('tron:0x2b6653dc', 'tron_signMessage', { address: tron, message: 'hello' });
  assert.match(tm.result.signature, /^0x[0-9a-f]{130}$/);
  assert.equal((await d.request('tron:0x2b6653dc', 'tron_signMessage', { address: hdKey(PHRASE, 1).address, message: 'x' })).error.code, 4100);

  // ping, and the dapp can't update the session itself
  assert.equal((await d.request('eip155:1', 'eth_chainId', [])).result, '0x1');
  const pingSince = r.published.length;
  const ping = d.send('wc_sessionPing', {});
  const pong = await until(() => r.published.slice(pingSince).map((x) => ({ b: wc.open(x.message, d.session.symKey), tag: x.tag })).find((x) => x.b.id === ping.msg.id), 'pong');
  assert.deepEqual([pong.b.result, pong.tag], [true, 1115]);

  // the user disconnects it in Chakra: the dapp is told (6000), Chakra stops listening
  mark = d.sent(0).length;
  await family.disconnect(site);
  const del = d.sent(0).slice(mark).find((x) => x.method === 'wc_sessionDelete');
  assert.deepEqual([del.params.code, del.tag], [6000, 1112]);
  assert.equal((await family.state(await v.view())).wcSites[site], undefined);
  await until(() => !r.subscribed(d.session.topic), 'unsubscribed');

  // another dapp disconnects from its side
  const e = dappSide(r, { optional: { eip155: { chains: ['eip155:1'], methods: ['personal_sign'], events: [] } } });
  e.propose();
  assert.equal((await link(e.uri)).connected, true);
  await e.answer();
  assert.ok((await family.state(await v.view())).wcSites[`wc:${e.session.topic}`]);
  e.send('wc_sessionDelete', { code: 6000, message: 'User disconnected.' });
  await until(async () => !(await family.state(await v.view())).wcSites[`wc:${e.session.topic}`], 'the session goes');
  assert.ok(unlocks > 0);
  family._relay.stop();
});
