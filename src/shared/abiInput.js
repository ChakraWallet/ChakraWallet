// Guided ABI forms: the state of a form field for any Solidity type, what the user typed -> values for ethers,
// and decoded values -> something readable. Pure functions (tested in tests/abiInput.test.js).
//
// Field state by type:  scalars -> string (bool -> boolean)   T[] / T[k] -> array of child states   tuple -> array of
// component states. Numbers accept 123, 0x7b, 1e18, 1.5 ether / gwei / wei, and a unit chosen in the form (decimals).
import { getAddress, isAddress, hexlify, toUtf8Bytes, toUtf8String, isHexString, dataLength, zeroPadBytes, formatUnits, parseUnits } from 'ethers';

export class ArgError extends Error {
  constructor(key, path, vars = {}) { super(key); this.key = key; this.path = path; this.vars = vars; }
}

/** Empty state of a field. */
export function emptyValue(p) {
  if (p.baseType === 'tuple') return p.components.map(emptyValue);
  if (p.baseType === 'array') return p.arrayLength > 0 ? Array.from({ length: p.arrayLength }, () => emptyValue(p.arrayChildren)) : [];
  if (p.baseType === 'bool') return false;
  return '';
}

const UNITS = { wei: 0, gwei: 9, ether: 18, eth: 18 };

/**
 * Integer typed by the user. decimals: unit chosen next to the field (0 = raw). Inline units win: "1.5 ether".
 * Accepts underscores / spaces as separators, hex, scientific notation (1e18, 2.5e6).
 */
export function parseInteger(text, decimals = 0) {
  let s = String(text ?? '').trim().replace(/[_\s](?=\d)/g, '');
  if (!s) throw new ArgError('contracts.err.empty');
  const unit = /^(.*?)\s*(wei|gwei|ether|eth)$/i.exec(s);
  if (unit) { s = unit[1].trim(); decimals = UNITS[unit[2].toLowerCase()]; }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  let v;
  if (/^0x[0-9a-fA-F]+$/.test(body)) v = BigInt(body);
  else if (/^\d+(\.\d+)?e\d+$/i.test(body)) {
    const [m, e] = body.toLowerCase().split('e');
    v = parseUnits(m, Number(e) + decimals);
  } else if (/^\d+(\.\d+)?$|^\.\d+$/.test(body)) {
    try { v = parseUnits(body, decimals); } catch { throw new ArgError('contracts.err.tooManyDecimals', null, { decimals }); }
  } else throw new ArgError('contracts.err.notNumber');
  return neg ? -v : v;
}

function checkRange(type, v) {
  const m = /^(u?)int(\d*)$/.exec(type);
  const bits = BigInt(m[2] || 256);
  if (m[1] === 'u') {
    if (v < 0n) throw new ArgError('contracts.err.negative');
    if (v >= 1n << bits) throw new ArgError('contracts.err.tooBig', null, { type });
  } else if (v < -(1n << (bits - 1n)) || v >= 1n << (bits - 1n)) throw new ArgError('contracts.err.tooBig', null, { type });
  return v;
}

/** Bytes typed by the user: 0x-hex, or text (UTF-8). bytesN: text is right-padded, hex must be N bytes (shorter is padded). */
function parseBytes(p, text) {
  const s = String(text ?? '');
  const fixed = /^bytes(\d+)$/.exec(p.type);
  let hex;
  if (isHexString(s.trim())) hex = s.trim();
  else if (s.trim().startsWith('0x')) throw new ArgError('contracts.err.badHex');
  else hex = hexlify(toUtf8Bytes(s));
  if (fixed) {
    const n = Number(fixed[1]);
    if (dataLength(hex) > n) throw new ArgError('contracts.err.bytesLength', null, { n });
    hex = zeroPadBytes(hex, n);
  }
  return hex;
}

/**
 * Field state -> value for ethers. ctx: { units: { [path]: decimals } } (unit chosen for a numeric field).
 * Throws ArgError with the path of the field ('0', '1.2', ...).
 */
export function toArg(p, v, ctx = {}, path = '') {
  try {
    if (p.baseType === 'tuple') return p.components.map((c, i) => toArg(c, v?.[i], ctx, path ? `${path}.${i}` : String(i)));
    if (p.baseType === 'array') {
      const list = Array.isArray(v) ? v : [];
      if (p.arrayLength > 0 && list.length !== p.arrayLength) throw new ArgError('contracts.err.arrayLength', null, { n: p.arrayLength });
      return list.map((x, i) => toArg(p.arrayChildren, x, ctx, path ? `${path}.${i}` : String(i)));
    }
    if (p.baseType === 'bool') return v === true || v === 'true' || v === '1';
    if (p.baseType === 'address') {
      const s = String(v ?? '').trim();
      if (!s) throw new ArgError('contracts.err.empty');
      if (!isAddress(s)) throw new ArgError('contracts.err.badAddress');
      return getAddress(s.toLowerCase());
    }
    if (/^u?int/.test(p.baseType)) return checkRange(p.type, parseInteger(v, ctx.units?.[path] || 0));
    if (p.baseType === 'string') return String(v ?? '');
    if (/^bytes/.test(p.baseType)) return parseBytes(p, v);
    throw new ArgError('contracts.err.unsupported', null, { type: p.type });
  } catch (e) {
    if (e instanceof ArgError) { if (e.path == null) e.path = path; throw e; }
    throw new ArgError('contracts.err.invalid', path, { msg: e.message });
  }
}

/** All arguments of a function (inputs: ethers ParamType[]). */
export const toArgs = (inputs, values, ctx) => inputs.map((p, i) => toArg(p, values[i], ctx, String(i)));

/** Arguments typed as JSON (advanced mode): [arg0, arg1, ...]; numbers may be strings ("1000000000000000000"). */
export function argsFromJson(inputs, text) {
  let v;
  try { v = JSON.parse(text || '[]'); } catch { throw new ArgError('contracts.err.badJson'); }
  if (!Array.isArray(v)) v = [v];
  if (v.length !== inputs.length) throw new ArgError('contracts.err.argCount', null, { n: inputs.length });
  const toState = (p, x) => {
    if (p.baseType === 'tuple') return p.components.map((c, i) => toState(c, Array.isArray(x) ? x[i] : x?.[c.name]));
    if (p.baseType === 'array') return (Array.isArray(x) ? x : []).map((y) => toState(p.arrayChildren, y));
    if (p.baseType === 'bool') return x === true || x === 'true';
    return x == null ? '' : String(x);
  };
  return toArgs(inputs, inputs.map((p, i) => toState(p, v[i])));
}

/** Decoded values -> JSON for copying (bigint as decimal strings, structs as arrays). */
export function toJson(value) {
  return JSON.stringify(value, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
}

/** Is it likely a timestamp in seconds? (2001 .. 2096) - used to show a date next to a number. */
export const looksLikeTime = (name, v) => typeof v === 'bigint' && v > 1_000_000_000n && v < 4_000_000_000n && /time|date|deadline|expir|start|end|until|since|last|unlock|at$/i.test(name || '');

/**
 * Decoded value -> display tree: { type, name, text, mono?, address?, sub?, children? }.
 * ctx: { decimals } of a token, to show amounts next to the raw integer.
 */
export function display(p, v, ctx = {}) {
  const name = p.name || '';
  if (p.baseType === 'tuple') return { type: p.type, name, children: p.components.map((c, i) => display(c, v?.[i], ctx)) };
  if (p.baseType === 'array') return { type: p.type, name, children: Array.from(v || []).map((x, i) => display(p.arrayChildren, x, ctx, i)), count: v?.length ?? 0 };
  if (p.baseType === 'address') return { type: p.type, name, text: String(v), mono: true, address: String(v) };
  if (p.baseType === 'bool') return { type: p.type, name, text: v ? 'true' : 'false' };
  if (/^u?int/.test(p.baseType)) {
    const n = BigInt(v);
    let sub = null;
    if (looksLikeTime(name, n)) sub = { kind: 'time', ms: Number(n) * 1000 };
    else if (ctx.decimals != null && (n >= 10n ** BigInt(Math.max(0, ctx.decimals - 6)) || n === 0n) && /amount|balance|supply|value|allowance|assets|shares|total|reserve|fee/i.test(name || ctx.fn || '')) sub = { kind: 'units', text: formatUnits(n, ctx.decimals) };
    else if (n >= 10n ** 15n) sub = { kind: 'ether', text: formatUnits(n, 18) };
    return { type: p.type, name, text: n.toString(), sub };
  }
  if (p.baseType === 'string') return { type: p.type, name, text: String(v) };
  if (/^bytes/.test(p.baseType)) {
    let text = null;
    try { const s = toUtf8String(String(v).replace(/(00)+$/, '')); if (s && /^[\x20-\x7e]+$/.test(s)) text = s; } catch { /* binary */ }
    return { type: p.type, name, text: String(v), mono: true, sub: text ? { kind: 'text', text } : null };
  }
  return { type: p.type, name, text: String(v) };
}

/** Raw return data split in 32-byte words (functions without a known output type). */
export const words = (hex) => (String(hex || '0x').slice(2).match(/.{1,64}/g) || []).map((w) => '0x' + w);

/** Suggested unit for a numeric field (decimals), from its name and the contract: token amounts, wei values. */
export function suggestUnit(p, fnName, token) {
  if (!/^uint/.test(p.type)) return 0;
  const n = `${p.name || ''}`;
  if (token?.decimals != null && /amount|value|wad|assets|shares|qty|quantity/i.test(n) && /transfer|approve|mint|burn|deposit|withdraw|redeem|permit|increase|decrease|send|stake|unstake/i.test(fnName || '')) return token.decimals;
  return 0;
}
