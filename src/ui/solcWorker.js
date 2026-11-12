// Solidity compiler in a Web Worker (Android app only). The chosen soljson build is downloaded once from
// binaries.soliditylang.org, checked against the SHA-256 of the official list (also at every later start, from the
// cache) and kept in Cache Storage. One compiler version per worker: changing version means a new worker.
// Messages in:  { id, type: 'load', file, sha256, version }  { id, type: 'compile', input (JSON string) }
// Messages out: { id, type: 'progress', loaded, total }  { id, type: 'ready', version }  { id, type: 'result', output }
//               { id, type: 'error', message }
const BASE = 'https://binaries.soliditylang.org/wasm/';
const CACHE = 'solc-builds-v1';
let compile = null;
let reset = null;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function download(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body?.getReader) return r.arrayBuffer();
  const reader = r.body.getReader();
  const parts = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (loaded - last > 262144) { last = loaded; onProgress(loaded, total); }
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

async function script(file, sha256, onProgress) {
  const url = BASE + file;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no Cache Storage: download every time */ }
  const hit = cache ? await cache.match(url) : null;
  const buf = hit ? await hit.arrayBuffer() : await download(url, onProgress);
  if (sha256) {
    const h = '0x' + hex(await crypto.subtle.digest('SHA-256', buf));
    if (h.toLowerCase() !== sha256.toLowerCase()) {
      if (cache) await cache.delete(url);
      throw new Error('integrity');
    }
  }
  if (cache && !hit) await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/javascript' } })).catch(() => {});
  return buf;
}

const older = (v, than) => { const a = v.split('.').map(Number), b = than.split('.').map(Number); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

async function load(msg, post) {
  const buf = await script(msg.file, msg.sha256, (loaded, total) => post({ type: 'progress', loaded, total }));
  self.Module = self.Module || {};
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/javascript' }));
  try { importScripts(url); } finally { URL.revokeObjectURL(url); }
  const M = self.Module;
  // soljson starts synchronously (solc-js relies on it); wait only if this build says it is still starting
  if (M.calledRun === false) await new Promise((res) => { const prev = M.onRuntimeInitialized; M.onRuntimeInitialized = () => { prev?.(); res(); }; });
  const version = M.cwrap('solidity_version', 'string', [])();
  compile = older(msg.version, '0.6.0')
    ? ((c) => (input) => c(input, 0))(M.cwrap('solidity_compile', 'string', ['string', 'number']))
    : ((c) => (input) => c(input, 0, 0))(M.cwrap('solidity_compile', 'string', ['string', 'number', 'number']));
  reset = M._solidity_reset ? M.cwrap('solidity_reset', null, []) : null;
  return version;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const post = (m) => self.postMessage({ id: msg.id, ...m });
  try {
    if (msg.type === 'load') post({ type: 'ready', version: await load(msg, post) });
    else if (msg.type === 'compile') {
      if (!compile) throw new Error('compiler not loaded');
      const output = compile(msg.input);
      try { reset?.(); } catch { /* old versions */ }
      post({ type: 'result', output });
    }
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};
