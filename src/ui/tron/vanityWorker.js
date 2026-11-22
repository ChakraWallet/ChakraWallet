// Web Worker of the Tron vanity search (bundled as tron-vanity-worker.js). Runs until terminated.
//   in  { type: 'bench', ms }                      -> out { type: 'bench', rate }     keys/s of this thread
//   in  { type: 'start', pattern, where, anyCase } -> out { type: 'progress', tried, sample } every ~150 ms
//                                                  -> out { type: 'found', privateKey (0x hex), address }
// Keys come from Ethereum's fast scanner (consecutive keys, one point addition each); a Tron address is the same
// 20 bytes in base58 with its checksum. The key travels to the page only when it matches, and is checked again there.
import { scanWith, randomScalar } from '../vanitySearch.js';
import { encodeAddress } from '../../shared/tron/core.js';
import { tronMatches } from '../../shared/tron/vanity.js';

const BATCH = 1024;
const bytes = new Uint8Array(21);
bytes[0] = 0x41;
const toAddress = (h) => { bytes.set(h.subarray(12, 32), 1); return encodeAddress(bytes); };

function scan(pattern, where, anyCase) {
  let sample = '';
  const r = scanWith((h) => { sample = toAddress(h); return tronMatches(sample, pattern, where, anyCase); }, randomScalar(BATCH), BATCH);
  return { found: r.found ? { privateKey: r.found.privateKey, address: sample } : null, sample };
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'bench') {
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < (m.ms || 600)) { scan('\u0000', 'start', false); n += BATCH; }
    self.postMessage({ type: 'bench', rate: (n * 1000) / (performance.now() - t0) });
    return;
  }
  if (m.type !== 'start') return;
  let tried = 0;
  let last = performance.now();
  for (;;) {
    const r = scan(m.pattern, m.where, m.anyCase);
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
