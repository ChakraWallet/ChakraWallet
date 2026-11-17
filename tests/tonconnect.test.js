// TON Connect (wallet side): signatures checked the way a dapp's server checks them (an independent copy of the
// reference verifier, ton-connect/demo-dapp-with-react-ui), request checks, and the session flow of the background
// with a stand-in for the approval screens (the user always says yes, or no) and for the network.
import { resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Address, Cell, beginCell, contractAddress, loadStateInit, loadMessage } from '@ton/core';
import { signVerify, keyPairFromSeed } from '@ton/crypto';
import * as v from '../src/background/vault.js';
import { tonConnectFamily } from '../src/background/tonconnect.js';
import { hdKeyPair, walletContract, friendly } from '../src/shared/ton/core.js';
import { crc32, dnsWire, tonProof, signDataSignature, parseSendTransaction, parseSignData, parseManifest, sameSite, addressReply, ERR } from '../src/shared/ton/tonconnect.js';
import { deviceInfo, maxMessages, WALLET_INFO, APP_NAME } from '../src/shared/ton/tonconnectInfo.js';

const sha = (b) => createHash('sha256').update(b).digest();
const PHRASE = 'test test test test test test test test test test test junk';

// ------------------------------------------------------------ reference verifiers (what a dapp's server does)
function checkProof({ address, publicKey, walletStateInit, proof, domain }) {
  const init = loadStateInit(Cell.fromBase64(walletStateInit).beginParse());
  const a = Address.parse(address);
  if (!contractAddress(a.workChain, init).equals(a)) return false;
  if (proof.domain.value !== domain || proof.domain.lengthBytes !== Buffer.byteLength(domain)) return false;
  const wc = Buffer.alloc(4); wc.writeInt32BE(a.workChain);
  const ts = Buffer.alloc(8); ts.writeBigUInt64LE(BigInt(proof.timestamp));
  const dl = Buffer.alloc(4); dl.writeUInt32LE(proof.domain.lengthBytes);
  const msg = Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, a.hash, dl, Buffer.from(proof.domain.value), ts, Buffer.from(proof.payload)]);
  const full = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha(msg)]);
  return signVerify(sha(full), Buffer.from(proof.signature, 'base64'), Buffer.from(publicKey, 'hex'));
}

function checkSignData({ signature, address, timestamp, domain, payload }, publicKey) {
  const a = Address.parse(address);
  let hash;
  if (payload.type === 'cell') {
    const enc = domain.split('.').reverse().map((x) => `${x}\0`).join('');
    hash = beginCell().storeUint(0x75569022, 32).storeUint(crc32ref(Buffer.from(payload.schema)), 32).storeUint(timestamp, 64)
      .storeAddress(a).storeStringRefTail(enc).storeRef(Cell.fromBase64(payload.cell)).endCell().hash();
  } else {
    const wc = Buffer.alloc(4); wc.writeInt32BE(a.workChain);
    const d = Buffer.from(domain); const dl = Buffer.alloc(4); dl.writeUInt32BE(d.length);
    const ts = Buffer.alloc(8); ts.writeBigUInt64BE(BigInt(timestamp));
    const data = payload.type === 'text' ? Buffer.from(payload.text, 'utf8') : Buffer.from(payload.bytes, 'base64');
    const pl = Buffer.alloc(4); pl.writeUInt32BE(data.length);
    hash = sha(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect/sign-data/'), wc, a.hash, dl, d, ts, Buffer.from(payload.type === 'text' ? 'txt' : 'bin'), pl, data]));
  }
  return signVerify(hash, Buffer.from(signature, 'base64'), publicKey);
}

// bit-by-bit CRC-32 (IEEE), independent from the table version under test
function crc32ref(buf) {
  let c = 0xffffffff;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------ pure pieces
test('crc32, DNS wire form, device info', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const s = 'message#75569022 payload:^Cell = Message;';
  assert.equal(crc32(Buffer.from(s)), crc32ref(Buffer.from(s)));
  assert.equal(dnsWire('app.ston.fi'), 'fi\0ston\0app\0');
  assert.equal(maxMessages('v5r1'), 255);
  assert.equal(maxMessages('v4r2'), 4);
  const d = deviceInfo(4, '1.2.3');
  assert.equal(d.appName, APP_NAME);
  assert.equal(WALLET_INFO.app_name, APP_NAME, 'app_name = js bridge key = device.appName');
  assert.deepEqual(d.features[1], { name: 'SendTransaction', maxMessages: 4 });
  assert.equal(d.features[0], 'SendTransaction', 'legacy feature for old SDKs');
});

test('ton_proof and signData signatures pass the reference checks', () => {
  const k = hdKeyPair(PHRASE, 0);
  const w = walletContract(k.publicKey);
  const reply = addressReply(w, k.publicKey, '-239');
  const proof = tonProof({ address: w.address, secretKey: k.secretKey, domain: 'app.example.org', timestamp: 1763380000, payload: 'nonce-123' });
  assert.ok(checkProof({ ...reply, proof, domain: 'app.example.org' }));
  assert.ok(!checkProof({ ...reply, proof, domain: 'example.org' }), 'bound to the domain');
  const other = keyPairFromSeed(Buffer.alloc(32, 9));
  assert.ok(!checkProof({ ...reply, publicKey: Buffer.from(other.publicKey).toString('hex'), proof, domain: 'app.example.org' }));
  // a state init that isn't the address is refused by the server
  assert.ok(!checkProof({ ...addressReply(walletContract(k.publicKey, { version: 'v4r2' }), k.publicKey, '-239'), address: reply.address, proof, domain: 'app.example.org' }));

  const ts = 1763380001;
  const cell = beginCell().storeUint(7, 32).endCell().toBoc().toString('base64');
  for (const payload of [
    { type: 'text', text: 'Accetto i termini ✓' },
    { type: 'binary', bytes: Buffer.from([1, 2, 3, 250]).toString('base64') },
    { type: 'cell', schema: 'message#75569022 payload:^Cell = Message;', cell },
  ]) {
    const signature = signDataSignature({ payload, address: w.address, domain: 'ston.fi', timestamp: ts }, k.secretKey);
    const res = { signature, address: w.address.toRawString(), timestamp: ts, domain: 'ston.fi', payload };
    assert.ok(checkSignData(res, k.publicKey), payload.type);
    assert.ok(!checkSignData({ ...res, domain: 'stonfi.org' }, k.publicKey), `${payload.type}: bound to the domain`);
    assert.ok(!checkSignData({ ...res, timestamp: ts + 1 }, k.publicKey), `${payload.type}: bound to the time`);
  }
});

test('sendTransaction checks', () => {
  const k = hdKeyPair(PHRASE, 0);
  const w = walletContract(k.publicKey);
  const session = { network: '-239', address: w.address.toRawString(), version: 'v5r1' };
  const dest = walletContract(keyPairFromSeed(Buffer.alloc(32, 3)).publicKey).address;
  const EQ = dest.toString({ bounceable: true }), UQ = dest.toString({ bounceable: false });
  const now = 1763380000;
  const body = beginCell().storeUint(0, 32).storeStringTail('ciao').endCell().toBoc().toString('base64');
  const req = (o) => [JSON.stringify({ valid_until: now + 60, network: '-239', from: session.address, messages: [{ address: EQ, amount: '1000' }], ...o })];

  const ok = parseSendTransaction(req({ messages: [{ address: EQ, amount: '1000', payload: body }, { address: UQ, amount: '5' }] }), session, now);
  assert.equal(ok.validUntil, now + 60);
  assert.deepEqual(ok.messages.map((m) => [m.value, m.bounce]), [['1000', true], ['5', false]], 'bounce from the address form');
  assert.equal(ok.messages[0].body, body);
  assert.equal(parseSendTransaction(req({ valid_until: (now + 60) * 1000 }), session, now).validUntil, now + 60, 'milliseconds by mistake');
  assert.equal(parseSendTransaction(req({ valid_until: undefined, network: undefined, from: undefined }), session, now).validUntil, null);
  assert.ok(parseSendTransaction(req({ from: friendly(w.address) }), session, now), 'from in user-friendly form');

  const refused = (o, re, s = session) => assert.throws(() => parseSendTransaction(req(o), s, now), (e) => e.tcCode === ERR.BAD_REQUEST && re.test(e.message));
  refused({ valid_until: now }, /expired/);
  refused({ network: '-3' }, /network/);
  refused({ from: dest.toRawString() }, /from/);
  refused({ messages: [{ address: dest.toRawString(), amount: '1' }] }, /user-friendly/);
  refused({ messages: [{ address: EQ, amount: '1.5' }] }, /amount/);
  refused({ messages: [{ address: EQ, amount: '1', extra_currency: { 100: '1' } }] }, /Extra/);
  refused({ messages: [{ address: EQ, amount: '1', payload: 'not a boc' }] }, /payload/);
  refused({ messages: [] }, /No messages/);
  refused({ items: [{ type: 'ton', address: EQ, amount: '1' }] }, /items/);
  refused({ messages: Array.from({ length: 5 }, () => ({ address: EQ, amount: '1' })) }, /at most 4/, { ...session, version: 'v4r2' });
  assert.throws(() => parseSendTransaction(['{bad json'], session, now), (e) => e.tcCode === ERR.BAD_REQUEST);
});

test('signData checks, manifest, same site', () => {
  const session = { network: '-239', address: walletContract(hdKeyPair(PHRASE, 0).publicKey).address.toRawString() };
  assert.equal(parseSignData([JSON.stringify({ type: 'text', text: 'hi' })], session).text, 'hi');
  assert.throws(() => parseSignData([JSON.stringify({ type: 'json', text: 'hi' })], session), /Unsupported/);
  assert.throws(() => parseSignData([JSON.stringify({ type: 'text', text: 'hi', network: '-3' })], session), /network/);
  assert.throws(() => parseSignData([JSON.stringify({ type: 'binary', bytes: '' })], session), /bytes/);
  assert.throws(() => parseSignData([JSON.stringify({ type: 'cell', schema: 'x', cell: 'nope' })], session), /cell/);

  assert.deepEqual(parseManifest({ url: 'https://ston.fi', name: ' STON.fi ', iconUrl: 'https://ston.fi/icon.png' }), { name: 'STON.fi', url: 'https://ston.fi/', iconUrl: 'https://ston.fi/icon.png', host: 'ston.fi' });
  assert.equal(parseManifest({ url: 'https://a.b', name: 'X', iconUrl: 'http://a.b/i.png' }).iconUrl, '', 'icons only over https');
  assert.throws(() => parseManifest({ url: 'nope', name: 'X' }), (e) => e.tcCode === ERR.MANIFEST_CONTENT);
  assert.throws(() => parseManifest({ url: 'https://a.b' }), (e) => e.tcCode === ERR.MANIFEST_CONTENT);
  assert.ok(sameSite('ston.fi', 'app.ston.fi'));
  assert.ok(sameSite('app.ston.fi', 'ston.fi'));
  assert.ok(!sameSite('ston.fi', 'ston.fi.evil.com'));
  assert.ok(!sameSite('ston.fi', 'notston.fi'));
});

// ------------------------------------------------------------ the background flow
test('TON Connect sessions in the background', { timeout: 300000 }, async () => {
  await reset();
  await v.createVault('walletpw1', PHRASE, 'Main');
  await v.unlock('walletpw1');
  const hd0 = (await v.view()).accounts[0].address;
  const k0 = hdKeyPair(PHRASE, 0);
  const myRaw = walletContract(k0.publicKey).address.toRawString();

  // network stand-in: the dapp manifest, and TON Center for the send
  const sentBocs = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u === 'https://app.example.org/tonconnect-manifest.json') return json({ url: 'https://example.org', name: 'Example', iconUrl: 'https://example.org/i.png' });
    if (u === 'https://evil.example/m.json') return json({ url: 'https://ston.fi', name: 'STON.fi' });
    if (u.includes('/api/v3/walletInformation')) return json({ balance: '5000000000', status: 'uninit', seqno: null });
    if (u.includes('/api/v3/message')) { sentBocs.push(JSON.parse(opts.body).boc); return json({ message_hash: 'aGFzaA==' }); }
    return json({}, 404);
  };

  // approval stand-in: says yes (with the first account) unless told otherwise; the family completes the request
  const asked = [], events = [];
  let answer = 'yes';
  const family = tonConnectFamily({
    async requestApproval(origin, kind, params) {
      asked.push({ kind, params });
      if (answer === 'no') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      return family.approvals[kind].complete({ origin, kind, params }, { account: hd0 });
    },
    ensureUnlocked: async () => {},
    emitToOrigin: async (origin, event, data) => { events.push({ origin, event, data }); },
  });
  const O = 'https://app.example.org';
  const call = (method, params, origin = O) => family.handle(origin, method, params);
  const connectReq = (items) => ({ request: { manifestUrl: 'https://app.example.org/tonconnect-manifest.json', items } });

  // refused before anything is asked
  assert.equal((await call('tonconnect_connect', connectReq([{ name: 'ton_addr' }]), 'http://app.example.org')).payload.code, ERR.BAD_REQUEST, 'https only');
  assert.equal((await call('tonconnect_connect', connectReq([{ name: 'ton_proof', payload: 'x' }]))).payload.code, ERR.BAD_REQUEST, 'ton_addr needed');
  assert.equal((await call('tonconnect_connect', { request: { manifestUrl: 'https://nowhere.example/m.json', items: [{ name: 'ton_addr' }] } })).payload.code, ERR.MANIFEST_NOT_FOUND);
  assert.equal((await call('tonconnect_restore', {})).payload.code, ERR.UNKNOWN_APP);
  assert.equal(asked.length, 0);

  // declined
  answer = 'no';
  const no = await call('tonconnect_connect', connectReq([{ name: 'ton_addr' }]));
  assert.equal(no.event, 'connect_error');
  assert.equal(no.payload.code, ERR.DECLINED);
  answer = 'yes';

  // connected (no signature): the account's TON address, the device with the W5 limit
  const ok = await call('tonconnect_connect', connectReq([{ name: 'ton_addr' }]));
  assert.equal(ok.event, 'connect');
  assert.equal(ok.payload.items[0].address, myRaw);
  assert.equal(ok.payload.items[0].network, '-239');
  assert.equal(ok.payload.device.features[1].maxMessages, 255);
  assert.equal(asked.at(-1).kind, 'tonConnect');
  assert.equal(asked.at(-1).params.domain, 'app.example.org', 'the page host, from the origin');
  assert.ok(!family.approvals.tonConnect.auth({ params: asked.at(-1).params }), 'no password without a signature');

  // again without a signature: silent; with ton_proof: asked again, with the password
  const n = asked.length;
  assert.equal((await call('tonconnect_connect', connectReq([{ name: 'ton_addr' }]))).event, 'connect');
  assert.equal(asked.length, n, 'silent reconnection');
  const signed = await call('tonconnect_connect', connectReq([{ name: 'ton_addr' }, { name: 'ton_proof', payload: 'srv-nonce' }]));
  assert.equal(asked.length, n + 1, 'a signature is always asked');
  assert.ok(family.approvals.tonConnect.auth({ params: asked.at(-1).params }), 'sign-in needs the password');
  const proof = signed.payload.items.find((i) => i.name === 'ton_proof').proof;
  assert.ok(checkProof({ ...signed.payload.items[0], proof, domain: 'app.example.org' }), 'proof for the real host');

  // a page whose manifest names another site: the proof still carries the page's own host
  const evil = await family.handle('https://evil.example', 'tonconnect_connect', { request: { manifestUrl: 'https://evil.example/m.json', items: [{ name: 'ton_addr' }, { name: 'ton_proof', payload: 'p' }] } });
  assert.equal(asked.at(-1).params.manifest.host, 'ston.fi');
  assert.equal(evil.payload.items[1].proof.domain.value, 'evil.example');

  // restore, state for the UI
  assert.equal((await call('tonconnect_restore', {})).payload.items[0].address, myRaw);
  const st = await family.state(await v.view());
  assert.equal(st.tonSites[O].display, friendly(walletContract(k0.publicKey).address));
  assert.equal(st.tonSites[O].name, 'Example');

  // requests: ids only grow
  const tx = (id, o = {}) => call('tonconnect_send', { message: { method: 'sendTransaction', id: String(id), params: [JSON.stringify({ valid_until: Math.floor(Date.now() / 1000) + 120, network: '-239', messages: [{ address: walletContract(keyPairFromSeed(Buffer.alloc(32, 3)).publicKey).address.toString({ bounceable: false }), amount: '1000000', payload: beginCell().storeUint(0, 32).storeStringTail('hi').endCell().toBoc().toString('base64') }], ...o })] } });
  const bad = await tx(1, { network: '-3' });
  assert.equal(bad.error.code, ERR.BAD_REQUEST);
  assert.equal((await tx(1)).error.code, ERR.BAD_REQUEST, 'id 1 already used');
  assert.match((await tx(1)).error.message, /already used/);
  answer = 'no';
  assert.equal((await tx(2)).error.code, ERR.DECLINED);
  answer = 'yes';
  const sent = await tx(3);
  assert.equal(typeof sent.result, 'string');
  assert.equal(sent.id, '3');
  assert.deepEqual(sentBocs, [sent.result], 'the BoC broadcast is the answer');
  const ext = loadMessage(Cell.fromBase64(sent.result).beginParse());
  assert.equal(ext.info.type, 'external-in');
  assert.equal(ext.info.dest.toRawString(), myRaw);
  assert.ok(ext.init, 'first send deploys the wallet');
  assert.ok(family.approvals.tonTx.auth({}), 'transactions need the password');

  // expired while waiting on the screen
  await assert.rejects(() => family.approvals.tonTx.complete({ params: { account: hd0, network: '-239', messages: [], validUntil: Math.floor(Date.now() / 1000) - 1 } }), (e) => e.tcCode === ERR.BAD_REQUEST);

  // signData
  const sd = await call('tonconnect_send', { message: { method: 'signData', id: '4', params: [JSON.stringify({ type: 'text', text: 'Login to Example' })] } });
  assert.equal(sd.result.domain, 'app.example.org');
  assert.equal(sd.result.address, myRaw);
  assert.ok(checkSignData(sd.result, k0.publicKey));
  assert.equal((await call('tonconnect_send', { message: { method: 'signMessage', id: '5', params: [] } })).error.code, ERR.NOT_SUPPORTED);

  // the dapp disconnects: no event back; then the session is unknown
  assert.deepEqual(await call('tonconnect_send', { message: { method: 'disconnect', id: '6', params: [] } }), { result: {}, id: '6' });
  assert.equal(events.length, 0);
  assert.equal((await call('tonconnect_restore', {})).payload.code, ERR.UNKNOWN_APP);
  assert.equal((await call('tonconnect_send', { message: { method: 'signData', id: '7', params: [] } })).error.code, ERR.UNKNOWN_APP);

  // a new connection counts ids anew; the user disconnects from Chakra: the page gets the event
  await call('tonconnect_connect', connectReq([{ name: 'ton_addr' }]));
  assert.equal((await call('tonconnect_send', { message: { method: 'signData', id: '1', params: [JSON.stringify({ type: 'text', text: 'x' })] } })).result.domain, 'app.example.org');
  await family.disconnect(O);
  assert.deepEqual(events.map((e) => [e.origin, e.event, e.data.event]), [[O, 'tonconnect', 'disconnect']]);
  assert.equal((await call('tonconnect_restore', {})).payload.code, ERR.UNKNOWN_APP);

  // another wallet active: its sites don't see this wallet's session
  await call('tonconnect_connect', connectReq([{ name: 'ton_addr' }]));
  await v.createWallet({ name: 'Second', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
  const second = (await v.view()).wallets.find((x) => x.name === 'Second');
  await v.switchWallet(second.id);
  assert.equal((await call('tonconnect_restore', {})).payload.code, ERR.UNKNOWN_APP);
  assert.deepEqual((await family.state(await v.view())).tonSites, {});
});

test('ton_proof message layout matches the spec example shape', () => {
  // the message signed ends with the payload as UTF-8 and has the 18-byte prefix
  const k = hdKeyPair(PHRASE, 0);
  const w = walletContract(k.publicKey);
  const p = tonProof({ address: w.address, secretKey: k.secretKey, domain: 'localhost:5173', timestamp: 1, payload: '' });
  assert.equal(p.domain.lengthBytes, 14);
  assert.equal(p.timestamp, 1);
  assert.equal(Buffer.from(p.signature, 'base64').length, 64);
  // and it does not depend on anything else: same input, same signature (Ed25519 is deterministic)
  assert.equal(tonProof({ address: w.address, secretKey: k.secretKey, domain: 'localhost:5173', timestamp: 1, payload: '' }).signature, p.signature);
});
