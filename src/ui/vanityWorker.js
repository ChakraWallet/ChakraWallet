// Web Worker for the vanity search (bundled as vanity-worker.js). Runs until the page terminates it.
//   in  { type: 'bench', ms }          -> out { type: 'bench', rate }            attempts/s of this thread
//   in  { type: 'start', pattern, where }
//                                      -> out { type: 'progress', tried, sample } every ~150 ms (tried = since the last one)
//                                      -> out { type: 'found', privateKey, address }
import { compile, scan, bench, BATCH } from './vanitySearch.js';

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'bench') { self.postMessage({ type: 'bench', rate: bench(m.ms) }); return; }
  if (m.type !== 'start') return;
  const checks = compile(m.pattern, m.where);
  let tried = 0;
  let last = performance.now();
  for (;;) {
    const r = scan(checks);
    tried += BATCH;
    if (r.found) {
      self.postMessage({ type: 'progress', tried, sample: r.sample });
      self.postMessage({ type: 'found', ...r.found });
      return;
    }
    const now = performance.now();
    if (now - last >= 150) { self.postMessage({ type: 'progress', tried, sample: r.sample }); tried = 0; last = now; }
  }
};
