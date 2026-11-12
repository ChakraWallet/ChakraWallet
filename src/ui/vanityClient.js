// Vanity search on several Web Workers (one per core, one core left to the interface).
// Every key found is checked again with ethers before it is handed to the interface.
import { Wallet } from 'ethers';
import { matches } from '../shared/vanity.js';

const WORKER_URL = 'vanity-worker.js'; // next to popup.html / index.html (see build.mjs)

export const threads = () => Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency || 2) - 1));

/** Estimated attempts/s on all threads: one thread measured for a moment, x0.5 for the slower cores of phones
 *  (measured on a Galaxy S23 Ultra: 120k/s on one thread, 350k/s on 7). During the search the real speed is used. */
export function measureRate(ms = 700) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(WORKER_URL); } catch (e) { reject(e); return; }
    w.onmessage = (e) => { if (e.data?.type === 'bench') { w.terminate(); resolve(e.data.rate * threads() * 0.5); } };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker')); };
    w.postMessage({ type: 'bench', ms });
  });
}

/**
 * Starts the search. Callbacks:
 *   onProgress({ tried, rate, sample, elapsed })   ~10 times a second
 *   onFound({ privateKey, address, tried, elapsed }) address in checksum case, already verified
 *   onError(error)
 * Returns stop(): terminates every worker (also called automatically on found/error).
 */
export function startSearch({ pattern, where, onProgress, onFound, onError }) {
  const workers = [];
  const t0 = performance.now();
  const recent = [{ t: t0, n: 0 }]; // recent (time, tried) points for the speed
  let tried = 0;
  let sample = '';
  let done = false;
  let tick = null;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(tick);
    for (const w of workers) w.terminate();
  };
  const fail = (e) => { if (done) return; stop(); onError?.(e instanceof Error ? e : new Error(String(e?.message || e))); };
  const report = () => {
    const now = performance.now();
    recent.push({ t: now, n: tried });
    while (recent.length > 2 && now - recent[0].t > 4000) recent.shift();
    const a = recent[0];
    const rate = now > a.t ? ((tried - a.n) * 1000) / (now - a.t) : 0;
    onProgress?.({ tried, rate, sample, elapsed: (now - t0) / 1000 });
  };
  const found = (f) => {
    if (done) return;
    let address;
    try { address = new Wallet(f.privateKey).address; } catch (e) { fail(e); return; }
    if (address.toLowerCase() !== '0x' + f.address || !matches(address, pattern, where)) { fail(new Error('vanity: verification failed')); return; }
    stop();
    onFound?.({ privateKey: f.privateKey, address, tried, elapsed: (performance.now() - t0) / 1000 });
  };
  try {
    for (let i = 0; i < threads(); i++) {
      const w = new Worker(WORKER_URL);
      w.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'progress') { tried += m.tried; sample = m.sample; } else if (m.type === 'found') found(m);
      };
      w.onerror = (e) => fail(new Error(e.message || 'worker'));
      w.postMessage({ type: 'start', pattern, where });
      workers.push(w);
    }
  } catch (e) { fail(e); return stop; }
  tick = setInterval(report, 100);
  return stop;
}
