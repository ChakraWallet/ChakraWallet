// Main-thread side of the Solidity compiler worker (ui/solcWorker.js): compiler list, loading a version, compiling.
import { compilerList } from '../shared/solidity.js';

const WORKER_URL = 'solc-worker.js'; // next to index.html (Android build, see build.mjs)
let worker = null;
let current = null; // { version, long }
let loading = null;
let seq = 0;
const pending = new Map();
let list = null;

/** Compiler releases (cached for the session). */
export const releases = async () => (list ??= await compilerList().catch((e) => { list = null; throw e; }));

function start() {
  worker?.terminate();
  for (const p of pending.values()) p.reject(new Error('restarted'));
  pending.clear();
  worker = new Worker(WORKER_URL);
  worker.onmessage = (e) => {
    const m = e.data || {};
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { p.onProgress?.(m.loaded, m.total); return; }
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'worker')); pending.clear(); };
}

function call(msg, onProgress) {
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, ...msg }); });
}

/** Loads a compiler version (release from releases()), once. onProgress(loaded, total) while downloading. */
export async function loadCompiler(release, onProgress) {
  if (current?.version === release.version && worker) return current;
  if (loading?.version === release.version) return loading.promise;
  start();
  const promise = call({ type: 'load', file: release.file, sha256: release.sha256, version: release.version }, onProgress)
    .then((m) => { current = { version: release.version, long: release.long, reported: m.version }; return current; })
    .catch((e) => { worker?.terminate(); worker = null; current = null; throw e; })
    .finally(() => { loading = null; });
  loading = { version: release.version, promise };
  return promise;
}

/** Compiles a standard JSON input object with the loaded compiler -> output object. */
export async function compile(input) {
  if (!worker || !current) throw new Error('compiler not loaded');
  const m = await call({ type: 'compile', input: JSON.stringify(input) });
  return JSON.parse(m.output);
}

export const loadedCompiler = () => current;

/** Is this build already downloaded (Cache Storage)? */
export async function isDownloaded(release) {
  try { return !!(await (await caches.open('solc-builds-v1')).match(`https://binaries.soliditylang.org/wasm/${release.file}`)); } catch { return false; }
}
