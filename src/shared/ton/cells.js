// Cells for the Contracts tab on TON (Android app): a builder for message bodies typed field by field, the arguments
// and results of get methods (TON Center stack format), TEP-64 token metadata (on-chain dictionary or off-chain link),
// the names of well-known operation codes, and a field-by-field view of any cell.
import { Buffer } from './buffer.js';
import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import { sha256 } from '@noble/hashes/sha256';
import { parseAmount } from '../format.js';

/** A field the user typed can't be encoded: `key` is an i18n key, `index` the field (if any). */
export class FieldError extends Error {
  constructor(key, vars = {}, index = null) { super(key); this.key = key; this.vars = vars; this.index = index; }
}

// ------------------------------------------------------------ inputs
/** Integer typed by the user: decimal or 0x hex, optional minus sign. */
export function parseBig(text) {
  const s = String(text ?? '').trim().replace(/[\s_]/g, '');
  if (!/^-?(0x[0-9a-fA-F]+|\d+)$/.test(s)) throw new FieldError('tonc.err.number');
  return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
}

/** Address in any form (friendly, raw, ton:// link); '' -> null (addr_none). */
export function parseAddr(text, { optional = false } = {}) {
  let s = String(text ?? '').trim();
  if (!s) { if (optional) return null; throw new FieldError('tonc.err.address'); }
  const link = /^ton:\/\/transfer\/([^?#]+)/i.exec(s);
  if (link) s = decodeURIComponent(link[1]);
  try { return Address.parse(s); } catch { throw new FieldError('tonc.err.address'); }
}

/** BoC typed by the user (base64, base64url or hex) -> Cell. */
export function parseBoc(text) {
  const s = String(text ?? '').trim().replace(/\s/g, '');
  if (!s) throw new FieldError('tonc.err.boc');
  try {
    const buf = /^(0x)?[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 ? Buffer.from(s.replace(/^0x/, ''), 'hex') : Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const cells = Cell.fromBoc(buf);
    if (cells.length !== 1) throw new Error();
    return cells[0];
  } catch { throw new FieldError('tonc.err.boc'); }
}

export const toB64 = (cell) => cell.toBoc().toString('base64');
export const toHex = (cell) => cell.toBoc().toString('hex');

// ------------------------------------------------------------ message builder
/**
 * Field types of the message builder:
 *   uint / int (bits), coins (amount with `unit` decimals, 9 = GRAM, 0 = raw), address ('' = none), bool,
 *   text (snake string), hex (raw bytes), ref (a cell as reference, from a BoC), maybeRef (bit + optional ref),
 *   slice (the bits and refs of a BoC stored inline).
 */
export const FIELD_TYPES = ['uint', 'int', 'coins', 'address', 'bool', 'text', 'hex', 'ref', 'maybeRef', 'slice'];
export const DEFAULT_BITS = { uint: 32, int: 32 };

function store(b, f) {
  const v = f.value;
  switch (f.type) {
    case 'uint':
    case 'int': {
      const bits = Number(f.bits);
      if (!Number.isInteger(bits) || bits < 1 || bits > (f.type === 'uint' ? 256 : 257)) throw new FieldError('tonc.err.bits');
      const n = parseBig(v);
      const max = f.type === 'uint' ? 1n << BigInt(bits) : 1n << BigInt(bits - 1);
      if (f.type === 'uint' ? n < 0n || n >= max : n < -max || n >= max) throw new FieldError('tonc.err.range', { bits });
      if (f.type === 'uint') b.storeUint(n, bits); else b.storeInt(n, bits);
      return;
    }
    case 'coins': {
      const unit = Number(f.unit ?? 9);
      const n = unit ? parseAmount(v, unit) : (() => { const x = parseBig(v); if (x < 0n) throw new FieldError('tonc.err.number'); return x; })();
      if (n == null) throw new FieldError('tonc.err.number');
      if (n >= 1n << 120n) throw new FieldError('tonc.err.range', { bits: 120 });
      b.storeCoins(n);
      return;
    }
    case 'address': b.storeAddress(parseAddr(v, { optional: true })); return;
    case 'bool': b.storeBit(v === true || v === 'true' || v === '1'); return;
    case 'text': b.storeStringTail(String(v ?? '')); return;
    case 'hex': {
      const s = String(v ?? '').trim().replace(/^0x/, '').replace(/\s/g, '');
      if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new FieldError('tonc.err.hex');
      b.storeBuffer(Buffer.from(s, 'hex'));
      return;
    }
    case 'ref': b.storeRef(parseBoc(v)); return;
    case 'maybeRef': b.storeMaybeRef(String(v ?? '').trim() ? parseBoc(v) : null); return;
    case 'slice': b.storeSlice(parseBoc(v).beginParse()); return;
    default: throw new FieldError('tonc.err.type');
  }
}

/** Cell from a list of fields; null for an empty list. Errors carry the index of the field. */
export function buildCell(fields) {
  if (!fields?.length) return null;
  const b = beginCell();
  fields.forEach((f, i) => {
    try { store(b, f); } catch (e) {
      if (e instanceof FieldError) { e.index = i; throw e; }
      throw new FieldError('tonc.err.overflow', {}, i); // too many bits or refs for one cell
    }
  });
  return b.endCell();
}

/** Text comment body (op 0). */
export const commentBody = (text) => beginCell().storeUint(0, 32).storeStringTail(String(text)).endCell();

// ------------------------------------------------------------ get methods
/** Argument types of a get method: int, address (passed as a slice), cell, slice (both from a BoC). */
export const ARG_TYPES = ['int', 'address', 'cell', 'slice'];

const numHex = (n) => (n < 0n ? `-0x${(-n).toString(16)}` : `0x${n.toString(16)}`);

/** One argument in TON Center's stack format. */
export function stackArg({ type, value }) {
  if (type === 'int') return { type: 'num', value: numHex(parseBig(value)) };
  if (type === 'address') return { type: 'slice', value: toB64(beginCell().storeAddress(parseAddr(value)).endCell()) };
  if (type === 'cell') return { type: 'cell', value: toB64(parseBoc(value)) };
  if (type === 'slice') return { type: 'slice', value: toB64(parseBoc(value)) };
  throw new FieldError('tonc.err.type');
}

/**
 * TON Center stack -> [{ kind: 'num', value: bigint } | { kind: 'cell' | 'slice', cell } | { kind: 'tuple', items }
 *                     | { kind: 'null' } | { kind: 'unknown', raw }]
 */
export function readStack(stack) {
  const one = (e) => {
    if (!e || e.type === 'null' || e.value == null) return { kind: 'null' };
    if (e.type === 'num') { // TON Center: hex with a sign, e.g. -0x1 (BigInt doesn't take a signed hex string)
      try { const v = String(e.value); return { kind: 'num', value: v.startsWith('-') ? -BigInt(v.slice(1)) : BigInt(v) }; } catch { return { kind: 'unknown', raw: e }; }
    }
    if (e.type === 'cell' || e.type === 'slice') { try { return { kind: e.type, cell: Cell.fromBase64(e.value) }; } catch { return { kind: 'unknown', raw: e }; } }
    if (Array.isArray(e.value)) return { kind: 'tuple', items: e.value.map(one) };
    if (Array.isArray(e.value?.elements)) return { kind: 'tuple', items: e.value.elements.map(one) };
    return { kind: 'unknown', raw: e };
  };
  return (stack || []).map(one);
}

// ------------------------------------------------------------ reading cells
/** The address stored in a cell/slice (and nothing else): Address, null for addr_none, undefined if it isn't one. */
export function cellAddress(cell) {
  try {
    const s = cell.beginParse();
    const a = s.loadMaybeAddress();
    if (s.remainingBits || s.remainingRefs) return undefined;
    return a;
  } catch { return undefined; }
}

const printable = (s) => s.length > 0 && !/[\u0000-\u0008\u000e-\u001f�]/.test(s);

/** Snake-encoded text of a cell (optionally after a 0x00 prefix byte), or null. */
export function cellText(cell, { prefix = false } = {}) {
  try {
    const s = cell.beginParse();
    if (prefix && s.loadUint(8) !== 0) return null;
    if (s.remainingBits % 8) return null;
    const text = s.loadStringTail();
    return printable(text) ? text : null;
  } catch { return null; }
}

// ------------------------------------------------------------ TEP-64 metadata
export const META_KEYS = ['name', 'symbol', 'description', 'image', 'decimals', 'uri', 'image_data', 'amount_style', 'render_type', 'social_links', 'marketplace', 'cover_image'];
const keyOf = (k) => BigInt('0x' + Buffer.from(sha256(new TextEncoder().encode(k))).toString('hex'));

function readValue(cell) {
  const s = cell.beginParse();
  const tag = s.remainingBits >= 8 ? s.loadUint(8) : -1;
  if (tag === 0) return s.loadStringTail();
  if (tag === 1) { // chunked
    const d = s.loadDict(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
    return [...d.keys()].sort((a, b) => a - b).map((i) => d.get(i).beginParse().loadStringTail()).join('');
  }
  return null;
}

/**
 * Token / NFT content (TEP-64): { onchain: { name, symbol, ... } } with the on-chain dictionary (its `uri` key, if
 * any, links extra off-chain data), or { uri } for off-chain content; null if the cell isn't TEP-64 content.
 */
export function parseContent(cell) {
  try {
    const s = cell.beginParse();
    const tag = s.loadUint(8);
    if (tag === 1) return { uri: s.loadStringTail() };
    if (tag !== 0) return null;
    const d = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    const onchain = {};
    for (const k of META_KEYS) {
      const v = d.get(keyOf(k));
      if (v) { try { const x = readValue(v); if (x != null) onchain[k] = x; } catch { /* unreadable value */ } }
    }
    return { onchain };
  } catch { return null; }
}

/** On-chain TEP-64 content from { name, symbol, decimals, image, description, ... } (empty values are left out). */
export function buildOnchainContent(meta) {
  const d = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || String(v) === '') continue;
    d.set(keyOf(k), beginCell().storeUint(0, 8).storeStringTail(String(v)).endCell());
  }
  return beginCell().storeUint(0, 8).storeDict(d).endCell();
}

/** Off-chain content: a link to a JSON file. */
export const buildOffchainContent = (uri) => beginCell().storeUint(1, 8).storeStringTail(String(uri)).endCell();

/** A link that can be fetched from the app: https as is, ipfs:// through a public gateway; else null. */
export function fetchableUri(uri) {
  const s = String(uri || '').trim();
  if (/^https:\/\//i.test(s)) return s;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(s);
  if (ipfs) return `https://ipfs.io/ipfs/${ipfs[1]}`;
  return null;
}

// ------------------------------------------------------------ operation codes
/** Well-known operation codes (first 32 bits of an internal message body). */
export const OPS = {
  0x00000000: 'comment',
  0xffffffff: 'bounce',
  0x0f8a7ea5: 'jetton_transfer',
  0x178d4519: 'jetton_internal_transfer',
  0x7362d09c: 'jetton_notify',
  0xd53276db: 'excess',
  0x595f07bc: 'jetton_burn',
  0x7bdd97de: 'jetton_burn_notification',
  0x2c76b973: 'provide_wallet_address',
  0xd1735400: 'take_wallet_address',
  0x5fcc3d14: 'nft_transfer',
  0x05138d91: 'nft_ownership_assigned',
  0x2fcb26a2: 'get_static_data',
  0x8b771735: 'report_static_data',
  0x693d3950: 'get_royalty_params',
  0xa8cb00ad: 'report_royalty_params',
  0x7369676e: 'wallet_signed_external',
  0x73696e74: 'wallet_signed_internal',
};
export const opName = (op) => OPS[op >>> 0] || null;
export const opHex = (op) => `0x${(op >>> 0).toString(16).padStart(8, '0')}`;

/**
 * Field-by-field view of a cell for the inspector: { bits, hex, refs: [...], guess: { op, opName, queryId, text,
 * address } } down to `max` levels.
 */
export function describeCell(cell, depth = 0, max = 4) {
  const out = { bits: cell.bits.length, hex: cell.bits.toString(), exotic: cell.isExotic, refs: [], more: 0, guess: {} };
  const g = out.guess;
  const addr = cellAddress(cell);
  if (addr) g.address = addr;
  else if (cell.bits.length >= 32) {
    try {
      const s = cell.beginParse();
      const op = s.loadUint(32);
      g.op = op; g.opName = opName(op);
      if (op === 0) g.text = cellText(cell.beginParse().skip(32).asCell());
      else if (s.remainingBits >= 64) g.queryId = s.loadUintBig(64);
    } catch { /* fewer bits than expected */ }
  }
  if (!g.op && !g.address && cell.bits.length % 8 === 0) { const text = cellText(cell); if (text && text.length > 1) g.text = text; }
  if (depth < max) out.refs = cell.refs.map((r) => describeCell(r, depth + 1, max));
  else out.more = cell.refs.length;
  return out;
}
