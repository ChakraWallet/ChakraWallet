// Base58 (Bitcoin alphabet), as Solana writes addresses, signatures and keys. Leading zero bytes are '1's.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Uint8Array -> base58 text. */
export function encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = []; // base 58, least significant first
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/** base58 text -> Uint8Array; throws on a character outside the alphabet. */
export function decode(text) {
  const s = String(text);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes = []; // base 256, least significant first
  for (let i = zeros; i < s.length; i++) {
    const v = INDEX.get(s[i]);
    if (v === undefined) throw new Error('invalid base58');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}
