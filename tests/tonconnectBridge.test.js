// TON Connect over the bridge: links, the encryption (checked against tweetnacl used directly, as a dapp does), the
// bridge client (with stand-ins for EventSource and fetch) and the whole flow of the background - a dapp connects
// from a link, asks a signature through the bridge, is disconnected - with an in-memory bridge.
import { resetStorage as reset } from './helpers/chrome.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import * as v from '../src/background/vault.js';
import { tonConnectFamily } from '../src/background/tonconnect.js';
import { parseConnectLink, seal, unseal, newSessionKeys, BridgeClient, isClientId } from '../src/shared/ton/tonconnectBridge.js';
import { ERR } from '../src/shared/ton/tonconnect.js';
import { hdKeyPair, walletContract } from '../src/shared/ton/core.js';

const PHRASE = 'test test test test test test test test test test test junk';
const hex = (b) => Buffer.from(b).toString('hex');
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) { const x = await fn(); if (x) return x; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 10)); }
}

/** The dapp's side, with tweetnacl as the TON Connect SDK uses it. */
function dappSide() {
  const k = nacl.box.keyPair();
  return {
    id: hex(k.publicKey),
    seal: (obj, walletId) => { const n = nacl.randomBytes(24); return Buffer.concat([Buffer.from(n), Buffer.from(nacl.box(Buffer.from(JSON.stringify(obj)), n, Buffer.from(walletId, 'hex'), k.secretKey))]).toString('base64'); },
    open: (b64, walletId) => { const b = Buffer.from(b64, 'base64'); const o = nacl.box.open(b.subarray(24), b.subarray(0, 24), Buffer.from(walletId, 'hex'), k.secretKey); return o && JSON.parse(Buffer.from(o).toString()); },
  };
}
const linkFor = (id, request, extra = '') => `tc://?v=2&id=${id}&r=${encodeURIComponent(JSON.stringify(request))}${extra}`;

// ------------------------------------------------------------ links and encryption
test('TON Connect links', () => {
  const id = 'ab'.repeat(32);
  const req = { manifestUrl: 'https://x.org/m.json', items: [{ name: 'ton_addr' }] };
  for (const pre of ['tc://?', 'tc:?', 'chakra-tc://?', 'https://chakrawallet.dev/ton-connect?', 'https://chakrawallet.dev/ton-connect/?']) {
    const l = parseConnectLink(`${pre}v=2&id=${id}&r=${encodeURIComponent(JSON.stringify(req))}&ret=none`);
    assert.deepEqual(l, { kind: 'connect', id, request: req, ret: 'none' }, pre);
  }
  assert.equal(parseConnectLink(linkFor(id.toUpperCase(), req)).id, id, 'ids in lower case');
  assert.equal(parseConnectLink(linkFor(id, req)).ret, 'back', 'back by default');
  assert.equal(parseConnectLink(linkFor(id, req, `&ret=${encodeURIComponent('tg://resolve?domain=app')}`)).ret, 'tg://resolve?domain=app');
  for (const bad of ['javascript:alert(1)', 'intent://x#Intent;end', 'file:///etc/passwd', 'chakra-tc://?x', 'nonsense']) {
    assert.equal(parseConnectLink(linkFor(id, req, `&ret=${encodeURIComponent(bad)}`)).ret, 'back', bad);
  }
  assert.deepEqual(parseConnectLink('https://chakrawallet.dev/ton-connect?ret=back'), { kind: 'open', ret: 'back' });
  assert.deepEqual(parseConnectLink('chakra-tc://'), { kind: 'open', ret: 'back' });
  assert.equal(parseConnectLink(`tc://?v=2&id=xyz&r=${encodeURIComponent('{}')}`).kind, 'bad');
  assert.equal(parseConnectLink(`tc://?v=2&id=${id}&r=%7Bnope`).kind, 'bad');
  assert.equal(parseConnectLink(`tc://?v=3&id=${id}&r=%7B%7D`).reason, 'version');
  for (const other of ['https://chakrawallet.dev/', 'https://chakrawallet.dev/ton-connectx?id=1', 'https://evil.dev/ton-connect?id=1', 'ton://transfer/UQ…', 'wc:abc@2', '']) {
    assert.equal(parseConnectLink(other), null, other);
  }
});

test('sealed messages: compatible with tweetnacl, refused with the wrong key', () => {
  const dapp = dappSide();
  const me = newSessionKeys();
  assert.ok(isClientId(me.publicKey));
  const msg = { method: 'signData', params: ['{"type":"text","text":"ciao ✓"}'], id: '3' };
  assert.deepEqual(unseal(dapp.seal(msg, me.publicKey), dapp.id, me.secretKey), msg, 'from the dapp');
  assert.deepEqual(dapp.open(seal({ event: 'connect', id: 1 }, dapp.id, me.secretKey), me.publicKey), { event: 'connect', id: 1 }, 'to the dapp');
  const other = newSessionKeys();
  assert.equal(unseal(dapp.seal(msg, me.publicKey), dapp.id, other.secretKey), null);
  assert.equal(unseal('bm90IGEgYm94', dapp.id, me.secretKey), null);
  assert.equal(unseal('', dapp.id, me.secretKey), null);
});

// ------------------------------------------------------------ an in-memory bridge
function memoryBridge() {
  const sources = [];
  const posted = [];
  const opts = { autoOpen: true };
  class FakeES {
    constructor(url) {
      this.url = url; this.closed = false;
      this.ids = new URL(url).searchParams.get('client_id').split(',');
      this.last = new URL(url).searchParams.get('last_event_id');
      sources.push(this);
      if (opts.autoOpen) setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0);
    }
    close() { this.closed = true; }
    emit(data, lastEventId) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId }); }
  }
  let fail = 0;
  const fetchImpl = async (url, opts) => {
    if (fail > 0) { fail--; return { ok: false, status: 502 }; }
    const u = new URL(url);
    posted.push({ path: u.pathname, from: u.searchParams.get('client_id'), to: u.searchParams.get('to'), ttl: u.searchParams.get('ttl'), body: opts.body });
    return { ok: true, status: 200 };
  };
  return { FakeES, fetchImpl, sources, posted, opts, live: () => sources.filter((s) => !s.closed), failNext: (n) => { fail = n; } };
}

test('bridge client: listen, messages, reconnection, sending', async () => {
  const b = memoryBridge();
  const got = [], lasts = [];
  const c = new BridgeClient({ url: 'https://bridge.test/bridge', EventSourceImpl: b.FakeES, fetchImpl: b.fetchImpl, onMessage: (m) => got.push(m), onLastId: (id) => lasts.push(id) });
  c.listen(['bb'.repeat(32), 'aa'.repeat(32)], '41');
  assert.equal(b.sources.length, 1);
  assert.deepEqual(b.sources[0].ids, ['aa'.repeat(32), 'bb'.repeat(32)]);
  assert.equal(b.sources[0].last, '41');
  assert.match(b.sources[0].url, /^https:\/\/bridge\.test\/bridge\/events\?/);
  b.sources[0].emit('heartbeat');
  b.sources[0].emit({ from: 'cc'.repeat(32), message: 'AAAA' }, '42');
  b.sources[0].emit({ nope: 1 }, '43');
  assert.deepEqual(got, [{ from: 'cc'.repeat(32), message: 'AAAA' }]);
  assert.deepEqual(lasts, ['42', '43']);
  await c.ready(1000);

  c.listen(['aa'.repeat(32), 'bb'.repeat(32)], '1');
  assert.equal(b.sources.length, 1, 'same ids: the same connection');
  c.listen(['aa'.repeat(32), 'bb'.repeat(32)], null, { force: true });
  assert.equal(b.sources.length, 2, 'forced: a new connection');
  assert.equal(b.sources[1].last, '43', 'from the last event seen');
  assert.ok(b.sources[0].closed);

  // the bridge can't be reached: 1 s, 2 s, 4 s… between attempts; once a connection opens, from 1 s again
  b.opts.autoOpen = false;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    b.sources[1].onerror();
    assert.ok(b.sources[1].closed);
    mock.timers.tick(999);
    assert.equal(b.sources.length, 2);
    mock.timers.tick(1);
    assert.equal(b.sources.length, 3, 'reconnected after 1 s');
    b.sources[2].onerror();
    mock.timers.tick(1999);
    assert.equal(b.sources.length, 3);
    mock.timers.tick(1);
    assert.equal(b.sources.length, 4, 'then after 2 s');
    b.sources[3].onopen();
    b.sources[3].onerror();
    mock.timers.tick(1000);
    assert.equal(b.sources.length, 5, 'after a good connection, 1 s again');
  } finally { mock.timers.reset(); b.opts.autoOpen = true; }

  await c.send('aa'.repeat(32), 'cc'.repeat(32), 'SEALED');
  assert.deepEqual(b.posted.at(-1), { path: '/bridge/message', from: 'aa'.repeat(32), to: 'cc'.repeat(32), ttl: '300', body: 'SEALED' });
  b.failNext(1);
  await c.send('aa'.repeat(32), 'cc'.repeat(32), 'AGAIN');
  assert.equal(b.posted.at(-1).body, 'AGAIN', 'a 5xx is retried');
  c.stop();
  assert.equal(b.live().length, 0);
});

// ------------------------------------------------------------ the whole flow
test('TON Connect through the bridge: link, approval, requests, disconnection', { timeout: 120000 }, async () => {
  await reset();
  await v.createVault('walletpw1', PHRASE, 'Main');
  await v.unlock('walletpw1');
  const hd0 = (await v.view()).accounts[0].address;
  const myRaw = walletContract(hdKeyPair(PHRASE, 0).publicKey).address.toRawString();
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://app.example.org/tonconnect-manifest.json') return { ok: true, status: 200, json: async () => ({ url: 'https://example.org', name: 'Example', iconUrl: '' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const b = memoryBridge();
  const asked = [];
  let answer = 'yes';
  const family = tonConnectFamily({
    async requestApproval(site, kind, params) {
      asked.push({ site, kind, params });
      if (answer === 'no') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      return family.approvals[kind].complete({ origin: site, kind, params }, { account: hd0 });
    },
    ensureUnlocked: async () => {},
    emitToOrigin: async () => { throw new Error('no page events for bridge sessions'); },
  }, { bridgeUrl: 'https://bridge.test/bridge', EventSourceImpl: b.FakeES, fetchImpl: b.fetchImpl });
  const answered = [];
  family.onAnswered((x) => answered.push(x));
  const request = { manifestUrl: 'https://app.example.org/tonconnect-manifest.json', items: [{ name: 'ton_addr' }, { name: 'ton_proof', payload: 'nonce' }] };

  // declined: the dapp is told (connect_error 300), nothing is stored
  const d1 = dappSide();
  answer = 'no';
  const no = await family.uiHandlers.tonConnectLink({ url: linkFor(d1.id, request, '&ret=none') });
  assert.deepEqual([no.connected, no.code, no.ret], [false, ERR.DECLINED, 'none']);
  const refused = b.posted.at(-1);
  assert.equal(refused.to, d1.id);
  assert.equal(d1.open(refused.body, refused.from).event, 'connect_error');
  assert.equal(b.live().length, 0, 'nothing to listen to');
  answer = 'yes';

  // connected: the screen knows it's the bridge and the declared site; Chakra listens before it answers
  const dapp = dappSide();
  const ok = await family.uiHandlers.tonConnectLink({ url: linkFor(dapp.id, request) });
  assert.deepEqual([ok.connected, ok.name, ok.ret], [true, 'Example', 'back']);
  const p = asked.at(-1).params;
  assert.equal(asked.at(-1).site, `tc:${dapp.id}`);
  assert.equal(p.remote, true);
  assert.equal(p.domain, 'example.org', 'signatures bound to the declared host');
  const hello = b.posted.at(-1);
  const walletId = hello.from;
  assert.ok(isClientId(walletId) && walletId !== refused.from, 'a new key pair per session');
  const ev = dapp.open(hello.body, walletId);
  assert.equal(ev.event, 'connect');
  assert.equal(ev.payload.items[0].address, myRaw);
  assert.equal(ev.payload.items[1].proof.domain.value, 'example.org');
  const es = b.live();
  assert.equal(es.length, 1);
  assert.deepEqual(es[0].ids, [walletId], 'listening to the session');

  // a request through the bridge: same checks and screens, the answer sealed back; the app may go back to the dapp
  const n = b.posted.length;
  es[0].emit({ from: dapp.id, message: dapp.seal({ method: 'signData', params: [JSON.stringify({ type: 'text', text: 'hi' })], id: '1' }, walletId) }, '77');
  const res = await until(() => b.posted.length > n && b.posted.at(-1), 'the answer');
  assert.equal(res.to, dapp.id);
  const r1 = dapp.open(res.body, walletId);
  assert.equal(r1.id, '1');
  assert.equal(r1.result.domain, 'example.org');
  assert.equal(asked.at(-1).params.remote, true);
  assert.deepEqual(answered, [{ method: 'signData', ok: true }]);
  await until(async () => (await chrome.storage.local.get('tonConnectLastEvent')).tonConnectLastEvent === '77', 'last event stored');

  // replayed by the bridge: refused; not sealed for this session: ignored
  es[0].emit({ from: dapp.id, message: dapp.seal({ method: 'signData', params: [JSON.stringify({ type: 'text', text: 'hi' })], id: '1' }, walletId) }, '78');
  const again = await until(() => b.posted.length > n + 1 && b.posted.at(-1), 'the refusal');
  assert.match(dapp.open(again.body, walletId).error.message, /already used/);
  const before = b.posted.length;
  es[0].emit({ from: dapp.id, message: dappSide().seal({ method: 'disconnect', params: [], id: '9' }, walletId) }, '79');
  es[0].emit({ from: 'ee'.repeat(32), message: 'AAAA' }, '80');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b.posted.length, before, 'nothing answered');

  // in the state for the UI: the declared host, through the bridge
  const st = (await family.state(await v.view())).tonSites[`tc:${dapp.id}`];
  assert.deepEqual([st.remote, st.host, st.name], [true, 'example.org', 'Example']);
  // a page can't speak for a bridge session
  assert.throws(() => family.handle(`tc:${dapp.id}`, 'tonconnect_restore', {}), /Bad origin/);

  // the user disconnects it in Chakra: the dapp is told through the bridge, Chakra stops listening
  await family.disconnect(`tc:${dapp.id}`);
  const bye = b.posted.at(-1);
  assert.equal(dapp.open(bye.body, walletId).event, 'disconnect');
  assert.equal(b.live().length, 0);
  assert.equal((await family.state(await v.view())).tonSites[`tc:${dapp.id}`], undefined);

  // a link without a request only brings the app up (and tells where to go after)
  assert.deepEqual(await family.uiHandlers.tonConnectLink({ url: 'https://chakrawallet.dev/ton-connect?ret=back' }), { connected: false, ret: 'back' });
  await assert.rejects(() => family.uiHandlers.tonConnectLink({ url: 'https://example.org/' }), /TON Connect/);
  await tick();
});
