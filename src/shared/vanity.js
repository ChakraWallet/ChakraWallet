// Vanity addresses: free text -> hex pattern (best-effort look-alike substitutions), matching and the maths
// for difficulty and time estimates. The search runs in Web Workers (src/ui/vanityWorker.js, core in vanitySearch.js).
// Only accounts with a separate private key: a recovery phrase costs ~200x more per attempt.

export const MAX_VANITY = 6;                 // hex characters; each one multiplies the work by 16
export const WHERE = ['start', 'end'];       // the pattern goes at the start or at the end of the address, never both

// Letters that are not hex digits -> the digit that looks most like them. Letters without a credible
// look-alike (k m n p r u v w x y j) are dropped, like spaces and punctuation.
export const LOOKALIKE = { o: '0', i: '1', l: '1', z: '2', h: '4', s: '5', g: '6', t: '7', q: '9' };

const isHex = (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
const plain = (ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); // "è" -> "e"

/**
 * Converts what the user types into the pattern to search.
 * chars: one entry per typed character (whitespace skipped), kind = 'same' | 'sub' (substituted) | 'drop' | 'over' (beyond the limit)
 */
export function toPattern(text, max = MAX_VANITY) {
  const chars = [];
  let pattern = '';
  for (const ch of String(text || '')) {
    if (/\s/.test(ch)) continue;
    const c = plain(ch);
    const to = c.length === 1 ? (isHex(c) ? c : LOOKALIKE[c] || null) : null;
    let kind = !to ? 'drop' : to === c ? 'same' : 'sub';
    if (to && pattern.length >= max) kind = 'over';
    else if (to) pattern += to;
    chars.push({ from: ch, to, kind });
  }
  return { chars, pattern };
}

/** Does this address (any case, with or without 0x) carry the pattern where requested? */
export function matches(address, pattern, where) {
  const a = String(address || '').toLowerCase().replace(/^0x/, '');
  if (a.length !== 40 || !pattern) return false;
  return where === 'end' ? a.endsWith(pattern) : a.startsWith(pattern);
}

/** Average number of attempts (case-insensitive: 16 possibilities per character). */
export const difficulty = (pattern) => 16 ** String(pattern || '').length;

/** Probability of having found it after `tried` attempts (each attempt is independent). */
export function probability(tried, pattern) {
  const d = difficulty(pattern);
  if (d <= 1) return 1;
  return 1 - Math.exp(tried * Math.log1p(-1 / d));
}

/** Typical time in seconds at `rate` attempts/s (the mean; half of the searches end before ~70% of it). */
export const expectedSeconds = (pattern, rate) => (rate > 0 ? difficulty(pattern) / rate : Infinity);

/** An example address that shows the pattern in place: pattern + random filler, split for display. */
export function exampleParts(pattern, where, filler) {
  const rest = String(filler || '').toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '').padEnd(40, '0').slice(0, 40 - pattern.length);
  return where === 'end' ? { before: rest, pattern, after: '' } : { before: '', pattern, after: rest };
}

/** The real address split around the pattern (keeps the address's own checksum case). */
export function splitAddress(address, pattern, where) {
  const a = String(address || '').replace(/^0x/i, '');
  const n = pattern.length;
  return where === 'end' ? { before: a.slice(0, 40 - n), pattern: a.slice(40 - n), after: '' } : { before: '', pattern: a.slice(0, n), after: a.slice(n) };
}
