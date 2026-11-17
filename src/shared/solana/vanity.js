// Solana vanity addresses: an account with a key of its own whose address starts or ends with a short word. Solana
// addresses are base58 (letters and digits but 0, O, I, l), so most words fit as they are; "any case" (on by
// default) accepts A or a in each place, which makes the search up to 2^n times shorter. The search: random keys in
// Web Workers (src/ui/solana/vanityWorker.js), each key checked again before it is saved.
import * as b58 from './base58.js';

export const SOL_MAX_VANITY = 5; // characters; each one multiplies the work by up to 58
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const IN = new Set(ALPHABET);
const LOOKALIKE = { 0: 'o', O: 'o', I: 'i', l: 'L' }; // characters base58 lacks -> the closest it has

/** The variants a character can take in an address (any case: both cases when base58 has both). */
export const variants = (ch, anyCase) => {
  if (!anyCase) return [ch];
  return [...new Set([ch.toLowerCase(), ch.toUpperCase()])].filter((x) => IN.has(x));
};

/**
 * What the user types -> the pattern to search: { chars: [{ from, to, kind: 'same' | 'sub' | 'drop' | 'over' }], pattern }.
 * Accents are removed, characters base58 lacks become their look-alike (0 -> o, I -> i), the rest is dropped.
 */
export function toSolPattern(text, { max = SOL_MAX_VANITY } = {}) {
  const chars = [];
  let pattern = '';
  for (const ch0 of String(text || '')) {
    if (/\s/.test(ch0)) continue;
    const ch = ch0.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const to = ch.length === 1 && IN.has(ch) ? ch : ch.length === 1 && LOOKALIKE[ch] ? LOOKALIKE[ch] : null;
    let kind = !to ? 'drop' : to === ch ? 'same' : 'sub';
    if (to && pattern.length >= max) kind = 'over';
    else if (to) pattern += to;
    chars.push({ from: ch0, to, kind });
  }
  return { chars, pattern };
}

/** Does the address carry the pattern where asked (any case: each character in either case)? */
export function solMatches(address, pattern, where, anyCase = true) {
  const a = String(address || '');
  if (!pattern || a.length < 32) return false;
  const part = where === 'end' ? a.slice(a.length - pattern.length) : a.slice(0, pattern.length);
  return anyCase ? part.toLowerCase() === pattern.toLowerCase() : part === pattern;
}

/**
 * Average number of keys to try. The end of an address is uniform; its start is not: 32 bytes give 44 characters
 * about 94.5% of the time, and then the first one is only 2 to J (the rest of the time 43 characters, any start).
 */
export function solDifficulty(pattern, where, anyCase = true) {
  const p = String(pattern || '');
  if (!p) return 1;
  const odds = (ch) => variants(ch, anyCase).length / 58;
  if (where === 'end') return 1 / [...p].reduce((x, ch) => x * odds(ch), 1);
  const rest = [...p.slice(1)].reduce((x, ch) => x * odds(ch), 1);
  const first = variants(p[0], anyCase);
  const in44 = first.filter((c) => { const i = ALPHABET.indexOf(c); return i >= 1 && i <= 17; }).length / 17;
  const prob = 0.945 * in44 * rest + 0.055 * (first.length / 58) * rest;
  return prob > 0 ? 1 / prob : Infinity;
}

/** Probability of having found it after `tried` keys. */
export function solProbability(tried, difficulty) {
  if (difficulty <= 1) return 1;
  return 1 - Math.exp(tried * Math.log1p(-1 / difficulty));
}

/** An example address showing the pattern in place (random base58 around it). */
export function solExample(pattern, where, length = 44) {
  const fill = Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => ALPHABET[b % 58]).join('').slice(0, length - pattern.length);
  return where === 'end' ? fill + pattern : pattern + fill;
}

export const encodeAddress = (bytes) => b58.encode(bytes);
