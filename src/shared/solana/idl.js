// Solana programs' interfaces (IDL) and their binary format (Borsh): what the Contracts tab reads and writes with.
// Three IDL formats are read and normalised into one: Anchor 0.30+ (discriminators in the IDL), Anchor up to 0.29
// ("legacy": discriminators from the names) and Shank (Metaplex: a one-byte instruction number).
//
// Normalised IDL: { format, name, address, instructions: [Ix], accounts: [{ name, discriminator, type }], types (Map),
//   errors: [{ code, name, msg }] }
//   Ix: { name, docs, discriminator (Uint8Array), args: [{ name, type }], accounts: [{ name, writable, signer,
//         optional, address?, pda?: { seeds: [{ kind: 'const', value } | { kind: 'arg', path } | { kind: 'account', path }], program? }, docs }] }
//   type: 'bool' | 'u8'…'u128' | 'i8'…'i128' | 'f32' | 'f64' | 'string' | 'pubkey' | 'bytes' | { vec } | { option } |
//         { coption } | { array: [type, n] } | { defined: name }
// Values (forms in, decoded out): integers as bigint (or text when typed), pubkeys as base58, bytes as Uint8Array,
// structs as objects, enums as { __variant: name, …fields } (tuple fields: _0, _1…), options as null or the value.
import { sha256 } from '@noble/hashes/sha256';
import { addressBytes, addressOf, utf8, concat, findProgramAddress, fromHex, isAddress } from './core.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const INTS = { u8: [1, false], u16: [2, false], u32: [4, false], u64: [8, false], u128: [16, false], i8: [1, true], i16: [2, true], i32: [4, true], i64: [8, true], i128: [16, true] };
export const isIntType = (t) => typeof t === 'string' && t in INTS;

// ------------------------------------------------------------ normalising
/** "initializeUser" -> "initialize_user" (Anchor up to 0.29 names its discriminators from the Rust names). */
export const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const disc = (s) => sha256(enc.encode(s)).slice(0, 8);

function normType(t) {
  if (typeof t === 'string') return t === 'publicKey' ? 'pubkey' : t;
  if (!t || typeof t !== 'object') throw new Error('bad type');
  if ('vec' in t) return { vec: normType(t.vec) };
  if ('option' in t) return { option: normType(t.option) };
  if ('coption' in t) return { coption: normType(t.coption) };
  if ('array' in t) return { array: [normType(t.array[0]), typeof t.array[1] === 'number' ? t.array[1] : Number(t.array[1]?.value ?? t.array[1])] };
  if ('defined' in t) return { defined: typeof t.defined === 'string' ? t.defined : t.defined.name };
  if ('generic' in t) return { generic: t.generic };
  throw new Error(`unsupported type ${JSON.stringify(t)}`);
}
function normTypeDef(d) {
  const ty = d.type || d;
  if (ty.kind === 'struct') {
    const f = ty.fields || [];
    return f.length && typeof f[0] === 'object' && 'name' in f[0] ? { kind: 'struct', fields: f.map((x) => ({ name: x.name, type: normType(x.type) })) } : { kind: 'tuple', fields: f.map(normType) };
  }
  if (ty.kind === 'enum') {
    return {
      kind: 'enum',
      variants: (ty.variants || []).map((v) => {
        if (!v.fields?.length) return { name: v.name };
        const named = typeof v.fields[0] === 'object' && v.fields[0] && 'name' in v.fields[0];
        return named ? { name: v.name, fields: v.fields.map((x) => ({ name: x.name, type: normType(x.type) })) } : { name: v.name, tuple: v.fields.map(normType) };
      }),
    };
  }
  if (ty.kind === 'type' || ty.kind === 'alias') return { kind: 'alias', type: normType(ty.alias || ty.value) };
  throw new Error(`unsupported type kind ${ty.kind}`);
}
const bytesOf = (v) => (v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v) : typeof v === 'string' ? enc.encode(v) : new Uint8Array());

function normSeed(s) {
  if (s.kind === 'const') return { kind: 'const', value: Array.isArray(s.value) ? Uint8Array.from(s.value) : typeof s.value === 'string' ? (s.type === 'pubkey' || s.type === 'publicKey' ? addressBytes(s.value) : enc.encode(s.value)) : bytesOf(s.value) };
  if (s.kind === 'arg') return { kind: 'arg', path: s.path };
  if (s.kind === 'account') return { kind: 'account', path: s.path };
  return { kind: 'unknown' };
}
/** Accounts of an instruction, flattened (Anchor's nested groups become "group.name"). */
function normAccounts(list, legacy, prefix = '') {
  const out = [];
  for (const a of list || []) {
    if (a.accounts) { out.push(...normAccounts(a.accounts, legacy, `${prefix}${a.name}.`)); continue; }
    out.push({
      name: `${prefix}${a.name}`, docs: a.docs || [],
      writable: !!(legacy ? a.isMut : a.writable), signer: !!(legacy ? a.isSigner : a.signer), optional: !!(legacy ? a.isOptional : a.optional),
      address: a.address || null,
      pda: a.pda ? { seeds: (a.pda.seeds || []).map(normSeed), program: a.pda.program ? normSeed(a.pda.program) : null } : null,
    });
  }
  return out;
}

/** Any of the three IDL formats (text or object) -> the normalised IDL; throws when it isn't one. */
export function normalizeIdl(input, programId = null) {
  const j = typeof input === 'string' ? JSON.parse(input) : input;
  if (!j || !Array.isArray(j.instructions)) throw new Error('not an IDL');
  const shank = j.metadata?.origin === 'shank' || j.instructions.some((ix) => ix.discriminant);
  const modern = !shank && (!!j.address || !!j.metadata?.spec || j.instructions.some((ix) => Array.isArray(ix.discriminator)));
  const legacy = !modern;
  const types = new Map();
  for (const d of j.types || []) types.set(d.name, normTypeDef(d));
  // Anchor 0.30+: account types live in `types`; older formats describe them in place
  for (const a of j.accounts || []) if (a.type && !types.has(a.name)) types.set(a.name, normTypeDef(a));
  const instructions = j.instructions.map((ix) => ({
    name: ix.name, docs: ix.docs || [],
    discriminator: modern ? Uint8Array.from(ix.discriminator)
      : shank ? (ix.discriminant.type === 'u8' ? Uint8Array.of(ix.discriminant.value) : encode(ix.discriminant.type, ix.discriminant.value, types))
        : disc(`global:${snake(ix.name)}`),
    args: (ix.args || []).map((a) => ({ name: a.name, type: normType(a.type) })),
    accounts: normAccounts(ix.accounts, legacy),
    returns: ix.returns ? normType(ix.returns) : null, // Anchor's view functions: what the simulation gives back
  }));
  const accounts = (j.accounts || []).map((a) => ({
    name: a.name,
    discriminator: modern && a.discriminator ? Uint8Array.from(a.discriminator) : shank ? null : disc(`account:${a.name}`),
    type: { defined: a.name },
  }));
  return {
    format: modern ? 'anchor' : shank ? 'shank' : 'anchor-legacy',
    name: j.metadata?.name || j.name || '', version: j.metadata?.version || j.version || '',
    address: j.address || j.metadata?.address || programId || null,
    instructions, accounts, types, errors: (j.errors || []).map((e) => ({ code: e.code, name: e.name, msg: e.msg || '' })),
  };
}

// ------------------------------------------------------------ Borsh
const resolve = (t, types) => {
  let d = t;
  for (let i = 0; i < 8 && d && typeof d === 'object' && 'defined' in d; i++) {
    const def = types.get(d.defined);
    if (!def) throw new Error(`unknown type ${d.defined}`);
    if (def.kind !== 'alias') return def;
    d = def.type;
  }
  return d;
};

function intBytes(t, v) {
  const [n, signed] = INTS[t];
  let x = typeof v === 'bigint' ? v : BigInt(String(v ?? '').trim() || 'x');
  const bits = BigInt(n * 8);
  const min = signed ? -(1n << (bits - 1n)) : 0n, max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (x < min || x > max) throw new Error(`${t} out of range`);
  if (x < 0n) x += 1n << bits;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
const lenBytes = (n) => intBytes('u32', n);

/** A value -> its Borsh bytes, for a type of the IDL. */
export function encode(t, v, types = new Map()) {
  if (isIntType(t)) return intBytes(t, v);
  switch (t) {
    case 'bool': return Uint8Array.of(v === true || v === 'true' || v === 1 ? 1 : 0);
    case 'f32': { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, Number(v), true); return b; }
    case 'f64': { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, Number(v), true); return b; }
    case 'string': { const s = enc.encode(String(v ?? '')); return concat([lenBytes(s.length), s]); }
    case 'pubkey': return addressBytes(String(v || '').trim());
    case 'bytes': { const b = toBytes(v); return concat([lenBytes(b.length), b]); }
    default: break;
  }
  if (t.vec) {
    if (t.vec === 'u8' && !Array.isArray(v)) { const b = toBytes(v); return concat([lenBytes(b.length), b]); }
    const a = v || [];
    return concat([lenBytes(a.length), ...a.map((x) => encode(t.vec, x, types))]);
  }
  if (t.option) return v == null || v === '' ? Uint8Array.of(0) : concat([Uint8Array.of(1), encode(t.option, v, types)]);
  if (t.coption) return v == null || v === '' ? new Uint8Array(4) : concat([lenBytes(1), encode(t.coption, v, types)]);
  if (t.array) {
    const [inner, n] = t.array;
    if (inner === 'u8' && !Array.isArray(v)) { const b = toBytes(v); if (b.length !== n) throw new Error(`${n} bytes expected`); return b; }
    const a = v || [];
    if (a.length !== n) throw new Error(`${n} items expected`);
    return concat(a.map((x) => encode(inner, x, types)));
  }
  if (t.defined) {
    const def = resolve(t, types);
    if (typeof def === 'string' || !def.kind) return encode(def, v, types);
    if (def.kind === 'struct') return concat(def.fields.map((f) => encode(f.type, v?.[f.name], types)));
    if (def.kind === 'tuple') return concat(def.fields.map((ft, i) => encode(ft, v?.[`_${i}`] ?? v?.[i], types)));
    if (def.kind === 'enum') {
      const name = typeof v === 'string' ? v : v?.__variant;
      const i = def.variants.findIndex((x) => x.name === name);
      if (i < 0) throw new Error(`unknown variant ${name}`);
      const vr = def.variants[i];
      const tag = Uint8Array.of(i);
      if (vr.fields) return concat([tag, ...vr.fields.map((f) => encode(f.type, v?.[f.name], types))]);
      if (vr.tuple) return concat([tag, ...vr.tuple.map((ft, k) => encode(ft, v?.[`_${k}`], types))]);
      return tag;
    }
  }
  throw new Error(`can't encode ${JSON.stringify(t)}`);
}

/** Bytes given as Uint8Array, an array of numbers (also as JSON text) or hex (0x…). */
export function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  const s = String(v ?? '').trim();
  if (!s) return new Uint8Array();
  if (/^0x[0-9a-f]*$/i.test(s) || /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return fromHex(s);
  if (s.startsWith('[')) return Uint8Array.from(JSON.parse(s));
  throw new Error('bytes: hex (0x…) or [1,2,3]');
}

/** Borsh bytes -> [value, next offset], for a type of the IDL. Throws when the data runs out. */
export function decode(t, b, o = 0, types = new Map()) {
  const need = (n) => { if (o + n > b.length) throw new Error('data too short'); };
  if (isIntType(t)) {
    const [n, signed] = INTS[t];
    need(n);
    let x = 0n;
    for (let i = n - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[o + i]);
    if (signed && x >= 1n << BigInt(n * 8 - 1)) x -= 1n << BigInt(n * 8);
    return [x, o + n];
  }
  const view = () => new DataView(b.buffer, b.byteOffset, b.length);
  switch (t) {
    case 'bool': need(1); return [b[o] !== 0, o + 1];
    case 'f32': need(4); return [view().getFloat32(o, true), o + 4];
    case 'f64': need(8); return [view().getFloat64(o, true), o + 8];
    case 'pubkey': need(32); return [addressOf(b.slice(o, o + 32)), o + 32];
    case 'string': case 'bytes': {
      need(4);
      const n = view().getUint32(o, true);
      need(4 + n);
      const raw = b.slice(o + 4, o + 4 + n);
      return [t === 'string' ? dec.decode(raw) : raw, o + 4 + n];
    }
    default: break;
  }
  if (t.vec) {
    need(4);
    const n = view().getUint32(o, true);
    o += 4;
    if (t.vec === 'u8') { need(n); return [b.slice(o, o + n), o + n]; }
    if (n > 100000) throw new Error('vector too long');
    const out = [];
    for (let i = 0; i < n; i++) { const [x, k] = decode(t.vec, b, o, types); out.push(x); o = k; }
    return [out, o];
  }
  if (t.option) { need(1); if (!b[o]) return [null, o + 1]; return decode(t.option, b, o + 1, types); }
  if (t.coption) { need(4); if (!view().getUint32(o, true)) return [null, o + 4 + byteSize(t.coption, types)]; return decode(t.coption, b, o + 4, types); }
  if (t.array) {
    const [inner, n] = t.array;
    if (inner === 'u8') { need(n); return [b.slice(o, o + n), o + n]; }
    const out = [];
    for (let i = 0; i < n; i++) { const [x, k] = decode(inner, b, o, types); out.push(x); o = k; }
    return [out, o];
  }
  if (t.defined) {
    const def = resolve(t, types);
    if (typeof def === 'string' || !def.kind) return decode(def, b, o, types);
    if (def.kind === 'struct') {
      const v = {};
      for (const f of def.fields) { const [x, k] = decode(f.type, b, o, types); v[f.name] = x; o = k; }
      return [v, o];
    }
    if (def.kind === 'tuple') {
      const v = {};
      def.fields.forEach((ft, i) => { const [x, k] = decode(ft, b, o, types); v[`_${i}`] = x; o = k; });
      return [v, o];
    }
    if (def.kind === 'enum') {
      need(1);
      const vr = def.variants[b[o]];
      if (!vr) throw new Error(`bad variant ${b[o]}`);
      o += 1;
      const v = { __variant: vr.name };
      for (const f of vr.fields || []) { const [x, k] = decode(f.type, b, o, types); v[f.name] = x; o = k; }
      (vr.tuple || []).forEach((ft, i) => { const [x, k] = decode(ft, b, o, types); v[`_${i}`] = x; o = k; });
      return [v, o];
    }
  }
  throw new Error(`can't decode ${JSON.stringify(t)}`);
}
/** Fixed size of a type (for COption's empty case), or 0 when it varies. */
function byteSize(t, types) {
  if (isIntType(t)) return INTS[t][0];
  if (t === 'bool') return 1;
  if (t === 'pubkey') return 32;
  if (t === 'f32') return 4;
  if (t === 'f64') return 8;
  if (t?.array) return byteSize(t.array[0], types) * t.array[1];
  return 0;
}

// ------------------------------------------------------------ instructions and accounts
/** Accounts every program uses, by the names IDLs give them. */
export const WELL_KNOWN = {
  systemProgram: '11111111111111111111111111111111',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022Program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', tokenProgram2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  rent: 'SysvarRent111111111111111111111111111111111', clock: 'SysvarC1ock11111111111111111111111111111111',
  instructions: 'Sysvar1nstructions1111111111111111111111111', sysvarInstructions: 'Sysvar1nstructions1111111111111111111111111',
  memoProgram: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', tokenMetadataProgram: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
};
const leaf = (path) => String(path || '').split('.').pop();

/** The bytes a seed of a PDA stands for, or null while an input it needs is missing. */
function seedValue(seed, ix, { args, accounts, types }) {
  if (seed.kind === 'const') return seed.value;
  if (seed.kind === 'arg') {
    const [argName, ...rest] = String(seed.path).split('.');
    const arg = ix.args.find((a) => a.name === argName);
    if (!arg || args[argName] == null || args[argName] === '') return null;
    let type = arg.type, value = args[argName];
    for (const field of rest) { // a field of a struct argument
      const def = resolve(type, types);
      const f = def?.fields?.find((x) => x.name === field);
      if (!f) return null;
      type = f.type; value = value?.[field];
    }
    try {
      if (type === 'string') return enc.encode(String(value));
      return encode(type, value, types);
    } catch { return null; }
  }
  if (seed.kind === 'account') {
    const name = String(seed.path).split('.')[0];
    const a = accounts[name] ?? accounts[leaf(name)];
    return a && isAddress(a) && !String(seed.path).includes('.') ? addressBytes(a) : null;
  }
  return null;
}

/**
 * Fills what can be known of an instruction's accounts: fixed addresses, well-known programs, the signer (the wallet),
 * program-derived addresses from their seeds (once their inputs are there). Returns { [account name]: address }
 * merged over what the user typed (`given`).
 */
export function autoAccounts(idl, ix, { programId, me, args = {}, given = {} }) {
  const out = { ...given };
  for (let pass = 0; pass < 3; pass++) {
    for (const a of ix.accounts) {
      if (out[a.name]) continue;
      if (a.address) { out[a.name] = a.address; continue; }
      const known = WELL_KNOWN[leaf(a.name)];
      if (known) { out[a.name] = known; continue; }
      if (a.pda) {
        const seeds = a.pda.seeds.map((s) => seedValue(s, ix, { args, accounts: out, types: idl.types }));
        const prog = a.pda.program ? seedValue(a.pda.program, ix, { args, accounts: out, types: idl.types }) : null;
        if (seeds.every(Boolean) && (!a.pda.program || prog)) {
          try { out[a.name] = findProgramAddress(seeds, prog ? addressOf(prog) : programId)[0]; } catch { /* seeds too long */ }
        }
        continue;
      }
      if (a.signer && me) out[a.name] = me;
    }
  }
  return out;
}

/** An instruction of the IDL with its argument values and accounts -> { programId, keys, data }. */
export function buildIxFromIdl(idl, ix, { programId, args = {}, accounts = {} }) {
  const data = concat([ix.discriminator, ...ix.args.map((a) => {
    try { return encode(a.type, args[a.name], idl.types); } catch (e) { throw new Error(`${a.name}: ${e.message}`); }
  })]);
  const keys = ix.accounts.map((a) => {
    const v = accounts[a.name];
    if (!v && a.optional) return { pubkey: programId, isSigner: false, isWritable: false }; // an absent optional account: the program's id
    if (!v || !isAddress(v)) throw new Error(`${a.name}: address missing`);
    return { pubkey: v.trim(), isSigner: a.signer, isWritable: a.writable };
  });
  return { programId, keys, data };
}

/** An account's data -> { type (name), value } with the IDL's account types (by discriminator), or null. */
export function decodeAccount(idl, data) {
  for (const a of idl.accounts) {
    const d = a.discriminator;
    if (d && (data.length < d.length || !d.every((x, i) => data[i] === x))) continue;
    try { return { type: a.name, value: decode(a.type, data, d ? d.length : 0, idl.types)[0] }; } catch { if (d) return { type: a.name, value: null, error: true }; }
  }
  return null;
}

/** An instruction's data -> { ix, args } with the IDL (by discriminator), or null. */
export function decodeInstruction(idl, data) {
  for (const ix of idl.instructions) {
    const d = ix.discriminator;
    if (data.length < d.length || !d.every((x, i) => data[i] === x)) continue;
    try {
      let o = d.length;
      const args = {};
      for (const a of ix.args) { const [v, k] = decode(a.type, data, o, idl.types); args[a.name] = v; o = k; }
      return { ix, args };
    } catch { return { ix, args: null }; }
  }
  return null;
}

/** "custom program error: 0x1770" -> the IDL's error { code, name, msg }, or null. */
export function idlError(idl, text) {
  const m = /custom program error: 0x([0-9a-f]+)|"Custom":\s*(\d+)/i.exec(String(text || ''));
  if (!m || !idl) return null;
  const code = m[1] ? parseInt(m[1], 16) : Number(m[2]);
  return idl.errors.find((e) => e.code === code) || null;
}

/** A value decoded from Borsh, as text for the screens (bigint -> digits, bytes -> hex, structs -> JSON). */
export function showValue(v) {
  return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? `0x${Array.from(x, (y) => y.toString(16).padStart(2, '0')).join('')}` : x), 2);
}
export { utf8 };
