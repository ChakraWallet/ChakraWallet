// The WalletConnect relay client: one WebSocket to the relay, JSON-RPC over it
// (docs/specs/servers/relay/relay-server-rpc.md). The relay only moves sealed messages between the subscribers of a
// topic: Chakra subscribes to the topics of its pairings and sessions, receives (irn_subscription, acknowledged at
// once, or the relay sends it again) and publishes (irn_publish). Messages sent while Chakra was away wait in the
// relay's mailbox for their ttl and arrive when it subscribes again. The connection opens only while there are topics
// to follow or messages to send, reconnects by itself (1 s, 2 s, 4 s… up to a minute) and can be forced to reconnect
// (the app is back on screen: a connection may have died while the phone slept).
import { relayAuth } from './crypto.js';

const rpcId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

/**
 * opts: { url (wss://…), projectId, ua, clientKey() -> Promise<hex> (the client's Ed25519 key, kept by the caller),
 * onMessage({ topic, message, attestation, publishedAt, tag }), WebSocketImpl, timeout (ms of a request) }
 */
export class RelayClient {
  constructor({ url, projectId, ua = 'wc-2/js-chakra/android', clientKey, onMessage, WebSocketImpl = globalThis.WebSocket, timeout = 15000 }) {
    Object.assign(this, { url, projectId, ua, clientKey, onMessage, WS: WebSocketImpl, timeout });
    this.topics = new Map(); // topic -> subscription id (null: not subscribed on this connection yet)
    this.ws = null; this.live = false; this.timer = 0; this.retry = 0; this.idle = 0;
    this.gen = 0; this.opening = false; // a connection being prepared (its key is read first)
    this.pending = new Map(); // request id -> { resolve, reject, timer }
    this.waiters = []; // resolve() when the connection is open
    this.busy = 0; // publishes in progress (the connection stays while they last)
  }

  /**
   * Follows exactly these topics (subscribes the new ones, unsubscribes the others). force: reconnect anyway. Resolves
   * once the new topics are subscribed (connected now) or will be at the next connection.
   */
  setTopics(list, { force = false } = {}) {
    const next = new Set(list);
    for (const [t, id] of this.topics) {
      if (next.has(t)) continue;
      this.topics.delete(t);
      if (this.live && id) this.request('irn_unsubscribe', { topic: t, id }).catch(() => {});
    }
    const added = [...next].filter((t) => !this.topics.has(t));
    for (const t of added) this.topics.set(t, null);
    if (force && this.topics.size) { this.reconnect(); return Promise.resolve(); }
    if (this.live) { this.maybeIdle(); return added.length ? this.subscribe(added).catch(() => {}) : Promise.resolve(); }
    if (this.topics.size && this.down()) this.open();
    return Promise.resolve();
  }

  /** No connection, none being opened and none planned. */
  down() { return !this.ws && !this.timer && !this.opening; }

  /** Publishes a sealed message on a topic (opens the connection if needed). */
  async publish(topic, message, { ttl = 300, tag = 0, prompt = false } = {}) {
    this.busy++;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.connected();
          return await this.request('irn_publish', { topic, message, ttl, tag, ...(prompt ? { prompt } : {}) });
        } catch (e) {
          if (attempt >= 2) throw new Error(`WalletConnect relay: ${e.message}`);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
    } finally { this.busy--; this.maybeIdle(); }
  }

  /** Waits (at most `ms`) for the connection to be open. */
  ready(ms = 5000) { return Promise.race([this.connected(), new Promise((r) => setTimeout(r, ms))]).catch(() => {}); }

  stop() { this.topics.clear(); this.close(); }

  // ---------------------------------------------------------------- connection
  connected() {
    if (this.live) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w.resolve !== resolve); reject(new Error('not connected')); }, this.timeout);
      this.waiters.push({ resolve: () => { clearTimeout(timer); resolve(); }, reject });
      if (this.down()) this.open();
    });
  }

  async open() {
    this.close({ keepWaiters: true });
    if (!this.WS) return;
    const gen = this.gen;
    this.opening = true;
    let auth;
    try { auth = relayAuth(await this.clientKey(), this.url); } catch { if (gen === this.gen) { this.opening = false; this.later(); } return; }
    if (gen !== this.gen) return; // closed or reopened meanwhile
    this.opening = false;
    const q = new URLSearchParams({ auth, projectId: this.projectId, ua: this.ua });
    const ws = new this.WS(`${this.url}/?${q}`);
    this.ws = ws;
    ws.onopen = async () => {
      if (this.ws !== ws) return;
      this.live = true;
      try { await this.subscribe([...this.topics.keys()]); } catch { /* retried at the next connection */ }
      if (this.ws !== ws) return;
      this.retry = 0;
      for (const w of this.waiters.splice(0)) w.resolve();
      this.maybeIdle();
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.received(ev.data); };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.close({ keepWaiters: true });
      if (this.topics.size || this.waiters.length || this.busy) this.later();
    };
  }

  later() { clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = 0; this.open(); }, Math.min(60000, 1000 * 2 ** this.retry++)); }

  reconnect() { this.retry = 0; this.open(); }

  close({ keepWaiters = false } = {}) {
    this.gen++; this.opening = false;
    clearTimeout(this.timer); this.timer = 0;
    clearTimeout(this.idle); this.idle = 0;
    this.live = false;
    for (const t of this.topics.keys()) this.topics.set(t, null);
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('connection closed')); this.pending.delete(id); }
    if (!keepWaiters) for (const w of this.waiters.splice(0)) w.reject(new Error('connection closed'));
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
  }

  /** Nothing to follow and nothing being sent: the connection goes after a while. */
  maybeIdle() {
    clearTimeout(this.idle);
    if (this.topics.size || this.busy || !this.ws) return;
    this.idle = setTimeout(() => { if (!this.topics.size && !this.busy) this.close(); }, 10000);
  }

  async subscribe(topics) {
    const todo = topics.filter((t) => this.topics.has(t) && !this.topics.get(t));
    if (!todo.length) return;
    const ids = todo.length === 1 ? [await this.request('irn_subscribe', { topic: todo[0] })] : await this.request('irn_batchSubscribe', { topics: todo });
    todo.forEach((t, i) => { if (this.topics.has(t)) this.topics.set(t, ids?.[i] || null); });
  }

  // ---------------------------------------------------------------- JSON-RPC
  request(method, params) {
    if (!this.live || !this.ws) return Promise.reject(new Error('not connected'));
    const id = rpcId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no answer`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params })); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  received(raw) {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.method === 'irn_subscription') {
      try { this.ws?.send(JSON.stringify({ id: m.id, jsonrpc: '2.0', result: true })); } catch { /* sent again by the relay */ }
      const d = m.params?.data;
      if (d && typeof d.topic === 'string' && typeof d.message === 'string') {
        Promise.resolve().then(() => this.onMessage({ topic: d.topic, message: d.message, attestation: d.attestation ?? null, publishedAt: d.publishedAt, tag: d.tag })).catch(() => {});
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || 'relay error'));
    else p.resolve(m.result);
  }
}
