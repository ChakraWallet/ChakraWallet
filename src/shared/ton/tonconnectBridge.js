// TON Connect over the HTTP bridge (dapps outside the app: QR codes and links). The connect link, the end-to-end
// encryption (NaCl crypto_box: X25519 + XSalsa20-Poly1305, one key pair per session, Chakra's client id = its public
// key) and the bridge client: Server-Sent Events to receive, POST to send. The bridge only relays sealed messages.
// Spec: github.com/ton-blockchain/ton-connect (spec/bridge.md, spec/session.md, spec/deeplinks.md).
import nacl from 'tweetnacl';
import { Buffer } from './buffer.js';

export const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
/** A client id: an X25519 public key, 64 hex characters. */
export const isClientId = (s) => /^[0-9a-f]{64}$/i.test(String(s || ''));

// ------------------------------------------------------------ links
// tc:// (any TON wallet), chakra-tc:// (Chakra only), https://chakrawallet.dev/ton-connect (universal link)
const LINK = /^(?:(?:tc|chakra-tc):|https:\/\/chakrawallet\.dev\/ton-connect(?:[/?#]|$))/i;
const UNSAFE_RET = /^(?:javascript|data|file|content|intent|blob|about|tc|chakra-tc):/i;

/** Where to go after the answer: 'back' (to the app that opened Chakra), 'none', or a link it gave. */
function parseRet(r) {
  if (!r || r === 'back') return 'back';
  if (r === 'none') return 'none';
  return /^[a-z][a-z0-9+.-]*:/i.test(r) && !UNSAFE_RET.test(r) ? r : 'back';
}

/**
 * A TON Connect link -> { kind: 'connect', id (the dapp's client id), request (ConnectRequest), ret }
 * | { kind: 'open', ret } (no request: the dapp just brings the wallet up, e.g. to approve a transaction)
 * | { kind: 'bad', reason } | null (not a TON Connect link).
 */
export function parseConnectLink(text) {
  const s = String(text || '').trim();
  if (!LINK.test(s)) return null;
  const i = s.indexOf('?');
  const q = new URLSearchParams(i >= 0 ? s.slice(i + 1).split('#')[0] : '');
  const ret = parseRet(q.get('ret'));
  if (!q.get('id') && !q.get('r')) return { kind: 'open', ret };
  if (q.get('v') && q.get('v') !== '2') return { kind: 'bad', reason: 'version' };
  const id = q.get('id');
  if (!isClientId(id)) return { kind: 'bad', reason: 'id' };
  let request;
  try { request = JSON.parse(q.get('r')); } catch { return { kind: 'bad', reason: 'request' }; }
  if (!request || typeof request !== 'object') return { kind: 'bad', reason: 'request' };
  return { kind: 'connect', id: id.toLowerCase(), request, ret };
}

// ------------------------------------------------------------ encryption (spec/session.md)
/** A new key pair for a session: { publicKey, secretKey } in hex. */
export function newSessionKeys() {
  const k = nacl.box.keyPair();
  return { publicKey: toHex(k.publicKey), secretKey: toHex(k.secretKey) };
}

/** A message for the other side: base64(nonce (24 bytes) ++ crypto_box(JSON)). */
export function seal(obj, theirId, mySecret) {
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(new TextEncoder().encode(JSON.stringify(obj)), nonce, fromHex(theirId), fromHex(mySecret));
  return Buffer.concat([Buffer.from(nonce), Buffer.from(box)]).toString('base64');
}

/** A message from the other side, or null if it isn't one (wrong key, tampered, not JSON). */
export function unseal(b64, theirId, mySecret) {
  try {
    const b = Buffer.from(String(b64), 'base64');
    if (b.length <= 24) return null;
    const out = nacl.box.open(Uint8Array.from(b.subarray(24)), Uint8Array.from(b.subarray(0, 24)), fromHex(theirId), fromHex(mySecret));
    return out ? JSON.parse(new TextDecoder().decode(out)) : null;
  } catch { return null; }
}

// ------------------------------------------------------------ bridge client
/**
 * One SSE connection for all of Chakra's client ids. Reconnects by itself (1 s, 2 s, 4 s… up to a minute) from the
 * last event seen, so messages sent while the app was away (the bridge keeps them for their ttl) still arrive.
 * opts: { url, onMessage({ from, message }), onLastId(id), EventSourceImpl, fetchImpl }
 */
export class BridgeClient {
  constructor({ url, onMessage, onLastId, EventSourceImpl = globalThis.EventSource, fetchImpl = (...a) => fetch(...a) }) {
    Object.assign(this, { url, onMessage, onLastId, ES: EventSourceImpl, fetch: fetchImpl });
    this.ids = []; this.last = null; this.es = null; this.timer = 0; this.retry = 0;
    this.opened = null; // resolves when the current connection is open
  }

  /**
   * Listens for these client ids; lastId: the last event already handled (null: none yet). The same ids keep the
   * connection that is there, unless `force` (the app is back: the connection may have died while it was away).
   */
  listen(ids, lastId, { force = false } = {}) {
    const next = [...new Set(ids)].sort();
    const same = next.join() === this.ids.join();
    this.ids = next;
    if (lastId != null && !this.last) this.last = String(lastId);
    if (same && !force && (this.es || this.timer)) return;
    this.retry = 0;
    this.open();
  }

  stop() { this.ids = []; this.close(); }

  /** Waits (at most `ms`) for the connection to be open: before a dapp can answer, Chakra must be listening. */
  ready(ms = 4000) { return Promise.race([this.opened || Promise.resolve(), new Promise((r) => setTimeout(r, ms))]); }

  open() {
    this.close();
    if (!this.ids.length || !this.ES) return;
    const q = new URLSearchParams({ client_id: this.ids.join(',') });
    if (this.last) q.set('last_event_id', this.last);
    const es = new this.ES(`${this.url}/events?${q}`);
    this.es = es;
    let opened;
    this.opened = new Promise((r) => { opened = r; });
    es.onopen = () => { this.retry = 0; opened(); };
    es.onmessage = (ev) => {
      if (ev.lastEventId) { this.last = String(ev.lastEventId); this.onLastId?.(this.last); }
      let d;
      try { d = JSON.parse(ev.data); } catch { return; } // heartbeats and the like
      if (d && typeof d.from === 'string' && typeof d.message === 'string') this.onMessage(d);
    };
    es.onerror = () => {
      if (this.es !== es) return;
      this.close();
      this.timer = setTimeout(() => this.open(), Math.min(60000, 1000 * 2 ** this.retry++));
    };
  }

  close() {
    clearTimeout(this.timer); this.timer = 0;
    if (!this.es) return;
    this.es.onopen = this.es.onmessage = this.es.onerror = null;
    this.es.close();
    this.es = null;
  }

  /** Posts a sealed message from one of Chakra's client ids to a dapp (the bridge keeps it `ttl` seconds). */
  async send(from, to, sealed, { ttl = 300 } = {}) {
    const q = new URLSearchParams({ client_id: from, to, ttl: String(ttl) });
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetch(`${this.url}/message?${q}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: sealed, signal: AbortSignal.timeout(15000) });
        if (res.ok || res.status < 500 || attempt >= 2) break;
      } catch (e) { if (attempt >= 2) throw new Error(`TON Connect bridge: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    if (!res.ok) throw new Error(`TON Connect bridge: HTTP ${res.status}`);
  }
}
