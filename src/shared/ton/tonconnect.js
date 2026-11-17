// TON Connect 2, wallet side: the pieces without storage or UI - replies to ton_addr and ton_proof, signData
// signatures, checks of sendTransaction / signData requests, the dapp manifest. Used by src/background/tonconnect.js.
// Spec: github.com/ton-blockchain/ton-connect (spec/connect.md, spec/rpc.md). The byte layouts are the ones the
// reference verifier checks (ton-connect/demo-dapp-with-react-ui, src/server/services/*-service.ts).
import { Buffer } from './buffer.js';
import { Address, Cell, beginCell, loadStateInit, storeStateInit } from '@ton/core';
import { sign } from '@ton/crypto';
import { sha256 } from '@noble/hashes/sha256';
import { SIGN_DATA_TYPES, maxMessages } from './tonconnectInfo.js';

export const ERR = { UNKNOWN: 0, BAD_REQUEST: 1, MANIFEST_NOT_FOUND: 2, MANIFEST_CONTENT: 3, UNKNOWN_APP: 100, DECLINED: 300, NOT_SUPPORTED: 400 };
export const NETWORKS = { mainnet: '-239', testnet: '-3' };

/** An error the dapp receives with one of the spec's codes (ERR). */
export class TcError extends Error {
  constructor(code, message) { super(message); this.tcCode = code; }
}
const bad = (message) => new TcError(ERR.BAD_REQUEST, message);
const h = (data) => Buffer.from(sha256(data));

// ------------------------------------------------------------ connect
/** ton_addr reply for a wallet contract (spec/connect.md, TonAddressItemReply). */
export function addressReply(contract, publicKey, network) {
  return {
    name: 'ton_addr', address: contract.address.toRawString(), network: String(network),
    publicKey: Buffer.from(publicKey).toString('hex'),
    walletStateInit: beginCell().store(storeStateInit(contract.init)).endCell().toBoc().toString('base64'),
  };
}

/**
 * ton_proof (spec/connect.md): message = "ton-proof-item-v2/" ++ workchain (int32 BE) ++ address hash ++
 * domain length (uint32 LE) ++ domain ++ timestamp (uint64 LE) ++ payload;
 * signature = Ed25519(sha256(0xffff ++ "ton-connect" ++ sha256(message))).
 * `domain` is the host of the page that asked (never what the dapp declares), so a copy of a site can't get a proof
 * that the real site's server would accept.
 */
export function tonProof({ address, secretKey, domain, timestamp, payload }) {
  const dom = Buffer.from(domain, 'utf8');
  const wc = Buffer.alloc(4); wc.writeInt32BE(address.workChain);
  const dl = Buffer.alloc(4); dl.writeUInt32LE(dom.length);
  const ts = Buffer.alloc(8); ts.writeBigUInt64LE(BigInt(timestamp));
  const message = Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, address.hash, dl, dom, ts, Buffer.from(payload, 'utf8')]);
  const full = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), h(message)]);
  return { timestamp, domain: { lengthBytes: dom.length, value: domain }, signature: sign(h(full), Buffer.from(secretKey)).toString('base64'), payload };
}

/** The dapp's tonconnect-manifest.json -> { name, url, iconUrl, host }; TcError 3 if it isn't usable. */
export function parseManifest(json) {
  const bad3 = (m) => new TcError(ERR.MANIFEST_CONTENT, m);
  if (!json || typeof json !== 'object') throw bad3('The manifest is not an object');
  if (typeof json.name !== 'string' || !json.name.trim()) throw bad3('The manifest has no name');
  let url;
  try { url = new URL(String(json.url)); } catch { throw bad3('The manifest has no valid url'); }
  if (!/^https?:$/.test(url.protocol)) throw bad3('The manifest url is not a web address');
  const icon = typeof json.iconUrl === 'string' && /^https:\/\//.test(json.iconUrl) ? json.iconUrl : '';
  return { name: json.name.trim().slice(0, 64), url: url.href, iconUrl: icon, host: url.host };
}

/** Same site or one of its subdomains (the manifest often names the main domain, the app runs on app.<domain>). */
export function sameSite(a, b) {
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  return !!x && !!y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

// ------------------------------------------------------------ requests
/** params of an RPC request: [JSON string] (the spec), or an already parsed object. */
function paramsObject(params) {
  const raw = Array.isArray(params) ? params[0] : params;
  let p = raw;
  if (typeof raw === 'string') { try { p = JSON.parse(raw); } catch { throw bad('params are not valid JSON'); } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('params missing');
  return p;
}

/** network and from of a request must be the session's (spec/rpc.md): never another network, never another sender. */
function checkNetworkFrom(p, session) {
  if (p.network != null && String(p.network) !== session.network) throw bad(`Wrong network: the wallet is connected to ${session.network}`);
  if (p.from != null) {
    let a;
    try { a = Address.parse(String(p.from)); } catch { throw bad('from is not an address'); }
    if (!a.equals(Address.parse(session.address))) throw bad('from is not the connected account');
  }
}

/**
 * sendTransaction params -> { messages: [{ to, value, bounce, body?, init? }], validUntil } as tonSend takes them.
 * session: { network, address (raw), version }; now: unix seconds. Throws TcError (code 1) for what isn't allowed:
 * expired, other network or sender, too many messages, raw addresses (the bounce flag comes from the user-friendly
 * form), extra currencies and structured items (not declared in the features).
 */
export function parseSendTransaction(params, session, now) {
  const p = paramsObject(params);
  if (p.items != null) throw bad('Structured items are not supported: send messages');
  let validUntil = null;
  if (p.valid_until != null) {
    validUntil = Number(p.valid_until);
    if (!Number.isFinite(validUntil)) throw bad('valid_until is not a number');
    if (validUntil > 1e11) validUntil = Math.floor(validUntil / 1000); // milliseconds by mistake
    if (validUntil <= now) throw bad('The request has expired');
  }
  checkNetworkFrom(p, session);
  const list = p.messages;
  if (!Array.isArray(list) || !list.length) throw bad('No messages');
  const max = maxMessages(session.version);
  if (list.length > max) throw bad(`Too many messages: this wallet sends at most ${max}`);
  const messages = list.map((m, i) => {
    const where = `messages[${i}]`;
    if (typeof m?.address !== 'string' || !Address.isFriendly(m.address)) throw bad(`${where}.address must be in user-friendly format`);
    let f;
    try { f = Address.parseFriendly(m.address); } catch { throw bad(`${where}.address is not valid`); }
    if (!/^\d{1,40}$/.test(String(m.amount ?? ''))) throw bad(`${where}.amount must be a decimal string of nanocoins`);
    if (m.extra_currency && Object.keys(m.extra_currency).length) throw bad('Extra currencies are not supported');
    if (m.payload != null) { try { Cell.fromBase64(String(m.payload)); } catch { throw bad(`${where}.payload is not a valid BoC`); } }
    if (m.stateInit != null) { try { loadStateInit(Cell.fromBase64(String(m.stateInit)).beginParse()); } catch { throw bad(`${where}.stateInit is not valid`); } }
    return {
      to: m.address, value: String(BigInt(m.amount)), bounce: f.isBounceable,
      ...(m.payload != null ? { body: String(m.payload) } : {}), ...(m.stateInit != null ? { init: String(m.stateInit) } : {}),
    };
  });
  return { messages, validUntil };
}

/** signData params -> the payload ({ type, text | bytes | schema + cell, network?, from? }), checked. */
export function parseSignData(params, session) {
  const p = paramsObject(params);
  if (!SIGN_DATA_TYPES.includes(p.type)) throw bad(`Unsupported sign data type: ${p.type}`);
  checkNetworkFrom(p, session);
  if (p.type === 'text') {
    if (typeof p.text !== 'string' || !p.text.length) throw bad('text missing');
    if (p.text.length > 10000) throw bad('text too long');
  } else if (p.type === 'binary') {
    if (typeof p.bytes !== 'string' || !Buffer.from(p.bytes, 'base64').length) throw bad('bytes missing');
    if (p.bytes.length > 100000) throw bad('bytes too long');
  } else {
    if (typeof p.schema !== 'string' || !p.schema.trim()) throw bad('schema missing');
    try { Cell.fromBase64(String(p.cell)); } catch { throw bad('cell is not a valid BoC'); }
  }
  return p;
}

// ------------------------------------------------------------ signData signatures
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** CRC-32 (IEEE, as the `crc-32` package): the schema hash of a cell signature. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Domain in DNS wire form (TEP-81), labels reversed, each ending with \0: "app.ston.fi" -> "fi\0ston\0app\0". */
export const dnsWire = (domain) => String(domain).split('.').reverse().map((x) => `${x}\0`).join('');

/**
 * What gets signed for signData (spec/rpc.md):
 * - text / binary: sha256(0xffff ++ "ton-connect/sign-data/" ++ workchain (int32 BE) ++ address hash ++
 *   domain length (uint32 BE) ++ domain ++ timestamp (uint64 BE) ++ "txt" | "bin" ++ length (uint32 BE) ++ data)
 * - cell: hash of the cell 0x75569022 ++ crc32(schema) ++ timestamp ++ address ++ ^domain (DNS form) ++ ^payload
 */
export function signDataHash({ payload, address, domain, timestamp }) {
  if (payload.type === 'cell') {
    return beginCell()
      .storeUint(0x75569022, 32).storeUint(crc32(Buffer.from(payload.schema, 'utf8')), 32).storeUint(timestamp, 64)
      .storeAddress(address).storeStringRefTail(dnsWire(domain)).storeRef(Cell.fromBase64(payload.cell))
      .endCell().hash();
  }
  const dom = Buffer.from(domain, 'utf8');
  const data = payload.type === 'text' ? Buffer.from(payload.text, 'utf8') : Buffer.from(payload.bytes, 'base64');
  const wc = Buffer.alloc(4); wc.writeInt32BE(address.workChain);
  const dl = Buffer.alloc(4); dl.writeUInt32BE(dom.length);
  const ts = Buffer.alloc(8); ts.writeBigUInt64BE(BigInt(timestamp));
  const pl = Buffer.alloc(4); pl.writeUInt32BE(data.length);
  return h(Buffer.concat([
    Buffer.from([0xff, 0xff]), Buffer.from('ton-connect/sign-data/'), wc, address.hash, dl, dom, ts,
    Buffer.from(payload.type === 'text' ? 'txt' : 'bin'), pl, data,
  ]));
}

/** base64 Ed25519 signature of a signData request. */
export const signDataSignature = (args, secretKey) => sign(Buffer.from(signDataHash(args)), Buffer.from(secretKey)).toString('base64');
