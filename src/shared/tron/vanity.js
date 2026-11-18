// Tron vanity addresses: an account with a key of its own whose address (T…) has a short word right after the T or
// at its end. Tron addresses are base58 (letters and digits but 0, O, I, l): most words fit as they are; "any case"
// accepts A or a in each place. The second character of a Tron address is almost always a capital letter A-Y (never
// a lower case one): a word at the start begins there. The search: Ethereum's key scanner (the same 20 bytes), each
// address written the Tron way (src/ui/tron/vanityWorker.js); the key is checked again before it is saved.
export const TRON_MAX_VANITY = 5; // characters; each one multiplies the work by up to 58
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const IN = new Set(ALPHABET);
const LOOKALIKE = { 0: 'o', O: 'o', I: 'i', l: 'L' }; // characters base58 lacks -> the closest it has
// how often each character is the second one of a Tron address (measured on 200,000 random addresses)
const SECOND = { 9: 0.0012, Z: 0.0136 };
for (const c of 'ABCDEFGHJKLMNPQRSTUVWXY') SECOND[c] = (1 - 0.0012 - 0.0136) / 23;

export const variants = (ch, anyCase) => (anyCase ? [...new Set([ch.toLowerCase(), ch.toUpperCase()])].filter((x) => IN.has(x)) : [ch]);

/** What the user types -> { chars: [{ from, to, kind: 'same' | 'sub' | 'drop' | 'over' }], pattern }. */
export function toTronPattern(text, { max = TRON_MAX_VANITY } = {}) {
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

/** The part of the address the pattern is compared with: right after the T, or the end. */
export const tronPart = (address, n, where) => (where === 'end' ? address.slice(address.length - n) : address.slice(1, 1 + n));

/** Does the address carry the pattern where asked (any case: each character in either case)? */
export function tronMatches(address, pattern, where, anyCase = true) {
  const a = String(address || '');
  if (!pattern || a.length !== 34 || a[0] !== 'T') return false;
  const part = tronPart(a, pattern.length, where);
  return anyCase ? part.toLowerCase() === pattern.toLowerCase() : part === pattern;
}

/** Average number of keys to try (Infinity: no Tron address can start that way). */
export function tronDifficulty(pattern, where, anyCase = true) {
  const p = String(pattern || '');
  if (!p) return 1;
  const odds = (ch) => variants(ch, anyCase).length / 58;
  if (where === 'end') return 1 / [...p].reduce((x, ch) => x * odds(ch), 1);
  const first = variants(p[0], anyCase).reduce((s, c) => s + (SECOND[c] || 0), 0);
  const prob = first * [...p.slice(1)].reduce((x, ch) => x * odds(ch), 1);
  return prob > 0 ? 1 / prob : Infinity;
}

export function tronProbability(tried, difficulty) {
  if (difficulty <= 1) return 1;
  if (!isFinite(difficulty)) return 0;
  return 1 - Math.exp(tried * Math.log1p(-1 / difficulty));
}

/** An example address showing the pattern in place (random base58 around it). */
export function tronExample(pattern, where) {
  const fill = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % 58]).join('');
  const second = 'ABCDEFGHJKLMNPQRSTUVWXY'[crypto.getRandomValues(new Uint8Array(1))[0] % 23];
  if (where === 'end') return `T${second}${fill(32 - pattern.length)}${pattern}`;
  return `T${pattern}${fill(33 - pattern.length)}`;
}
