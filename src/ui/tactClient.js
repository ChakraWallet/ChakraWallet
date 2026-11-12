// Main-thread side of the Tact compiler worker (ui/tactWorker.js, Android app): started on the first compilation,
// kept for the next ones.
const WORKER_URL = 'tact-worker.js'; // next to index.html (Android build, see build.mjs)
let worker = null;
let seq = 0;
const pending = new Map();

function start() {
  worker = new Worker(WORKER_URL);
  worker.onmessage = (e) => {
    const m = e.data || {};
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'worker'));
    pending.clear();
    worker?.terminate(); worker = null;
  };
}

/** Compiles a Tact project: files { path: text }, main (entry file) -> { ok, errors, contracts }. */
export function compileTact(files, main) {
  if (!worker) start();
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, type: 'compile', files, main }); });
}

export const tactLoaded = () => !!worker;
