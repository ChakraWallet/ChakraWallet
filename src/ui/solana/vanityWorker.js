// Web Worker of the Solana vanity search (bundled as sol-vanity-worker.js, Android app). Runs until terminated.
//   in  { type: 'bench', ms }                      -> out { type: 'bench', rate }     keys/s of this thread
//   in  { type: 'start', pattern, where, anyCase } -> out { type: 'progress', tried, sample } every ~150 ms
//                                                  -> out { type: 'found', seed (hex), address }
// A key is 32 random bytes (the seed): its address is the Ed25519 public key in base58. The seed travels to the page
// only when it matches, and the page checks it again before saving it.
import { ed25519 } from '@noble/curves/ed25519';
import { encodeAddress, solMatches } from '../../shared/solana/vanity.js';

const BATCH = 64;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function scan(pattern, where, anyCase) {
  const seeds = crypto.getRandomValues(new Uint8Array(32 * BATCH));
  let sample = '';
  for (let i = 0; i < BATCH; i++) {
    const seed = seeds.subarray(i * 32, i * 32 + 32);
    const address = encodeAddress(ed25519.getPublicKey(seed));
    if (solMatches(address, pattern, where, anyCase)) return { found: { seed: hex(seed), address }, sample: address };
    sample = address;
  }
  return { found: null, sample };
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
