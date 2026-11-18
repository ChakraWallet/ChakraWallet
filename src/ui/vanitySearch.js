// Vanity search core (runs inside a Web Worker, see vanityWorker.js; pure so it can be tested in Node).
// Incremental method: from a random scalar k, the points kG, (k+1)G, (k+2)G… are obtained with one point
// addition each (instead of a full scalar multiplication), then brought to affine coordinates in one batch
// with a single modular inversion. ~15x faster than generating every key from scratch.
// Every batch starts from a fresh 256-bit random scalar (crypto.getRandomValues): never a small seed.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const { ProjectivePoint: Point, CURVE } = secp256k1;
const Fp = CURVE.Fp;
const G = Point.BASE;
export const BATCH = 2048;

const HEX = '0123456789abcdef';
const HEXV = new Uint8Array(128);
for (let i = 0; i < 16; i++) HEXV[HEX.charCodeAt(i)] = i;

// 32-byte big-endian field element into buf at off (bigint -> hex -> bytes is the fastest path in JS)
function put32(buf, off, x) {
  const s = x.toString(16).padStart(64, '0');
  for (let i = 0, j = off; i < 64; i += 2, j++) buf[j] = (HEXV[s.charCodeAt(i)] << 4) | HEXV[s.charCodeAt(i + 1)];
}

const hexOf = (bytes, from, to) => { let s = ''; for (let i = from; i < to; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]; return s; };

/** Uniform random scalar in [1, n - span) so that k .. k+span-1 are all valid private keys. */
export function randomScalar(span = BATCH) {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    let k = 0n;
    for (const x of b) k = (k << 8n) | BigInt(x);
    if (k > 0n && k + BigInt(span) < CURVE.n) return k;
  }
}

/** Pattern -> nibble checks on the 20 address bytes (hash bytes 12..31). */
export function compile(pattern, where) {
  const p = String(pattern || '').toLowerCase();
  if (!/^[0-9a-f]{1,40}$/.test(p)) throw new Error('bad pattern');
  const start = where === 'end' ? 40 - p.length : 0;
  return [...p].map((c, i) => {
    const pos = start + i; // nibble position in the address
    return { byte: 12 + (pos >> 1), high: (pos & 1) === 0, v: HEXV[c.charCodeAt(0)] };
  });
}

function hit(h, checks) {
  for (const c of checks) if ((c.high ? h[c.byte] >> 4 : h[c.byte] & 15) !== c.v) return false;
  return true;
}

/**
 * Tries the keys k0 .. k0+count-1.
 * Returns { found: { privateKey, address } | null, sample: last address tried (lowercase, no 0x) }.
 */
export function scan(checks, k0 = randomScalar(), count = BATCH) {
  const r = scanWith((h) => hit(h, checks), k0, count);
  return { found: r.found ? { privateKey: r.found.privateKey, address: hexOf(r.found.hash, 12, 32) } : null, sample: hexOf(r.last, 12, 32) };
}

/**
 * The same scan with a test of its own on each keccak hash (the address is its bytes 12..31): e.g. Tron, whose
 * addresses are those 20 bytes in base58. -> { found: { privateKey, hash } | null, last: the last hash }.
 */
export function scanWith(test, k0 = randomScalar(), count = BATCH) {
  const pts = new Array(count);
  let p = G.multiply(k0);
  for (let i = 0; i < count; i++) { pts[i] = p; p = p.add(G); }
  const inv = Fp.invertBatch(pts.map((q) => q.pz));
  const buf = new Uint8Array(64);
  let h;
  for (let i = 0; i < count; i++) {
    put32(buf, 0, Fp.mul(pts[i].px, inv[i]));
    put32(buf, 32, Fp.mul(pts[i].py, inv[i]));
    h = keccak_256(buf);
    if (test(h)) return { found: { privateKey: '0x' + (k0 + BigInt(i)).toString(16).padStart(64, '0'), hash: h }, last: h };
  }
  return { found: null, last: h };
}

/** Attempts per second of this thread, measured for about `ms` milliseconds. */
export function bench(ms = 600) {
  const checks = compile('0'.repeat(40), 'start'); // never matches in practice
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { scan(checks, randomScalar(512), 512); n += 512; }
  return n / ((performance.now() - t0) / 1000);
}
