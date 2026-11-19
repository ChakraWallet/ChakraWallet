// Runes and inscriptions, as far as a wallet needs them without an indexer.
// - Runestones (the Runes protocol's message, in an OP_RETURN OP_13 output): encoded to send runes (edicts: how many
//   of which rune go to which output; the pointer: where the rest goes), and recognised in a transaction.
// - Inscriptions (Ordinals): their envelope (OP_FALSE OP_IF "ord" …) in an input's witness; the coin that carries a new
//   inscription is created by that transaction.
// A coin created by a transaction with either is "protected": it may carry runes or an inscription, and spending it
// in a plain send would hand them to the recipient or to the miner.
// Spec: https://docs.ordinals.com/runes/specification.html
import { fromHex, toHex } from './keys.js';

// ------------------------------------------------------------ LEB128
export function leb128(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}
/** -> [values (bigint)] or null when malformed (truncated, longer than 18 bytes). */
export function unleb128(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let v = 0n, shift = 0n, n = 0;
    for (;;) {
      if (i >= bytes.length || n >= 18) return null;
      const b = bytes[i++]; n++;
      v |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) break;
    }
    out.push(v);
  }
  return out;
}

const TAG = { body: 0n, flags: 2n, rune: 4n, mint: 20n, pointer: 22n };
/** A rune id "block:tx" -> { block, tx } (bigint). */
export function parseRuneId(id) {
  const m = /^(\d+):(\d+)$/.exec(String(id || ''));
  if (!m) throw new Error('bad rune id');
  return { block: BigInt(m[1]), tx: BigInt(m[2]) };
}

/**
 * The script of a runestone that transfers runes: edicts [{ id: 'block:tx', amount (bigint), output }], pointer: the
 * output that gets every rune not moved by an edict (the change). -> script bytes (OP_RETURN OP_13 <payload>).
 */
export function runestoneScript({ edicts = [], pointer = null }) {
  const ints = [];
  if (pointer != null) ints.push(TAG.pointer, BigInt(pointer));
  if (edicts.length) {
    ints.push(TAG.body);
    const sorted = edicts.map((e) => ({ ...parseRuneId(e.id), amount: BigInt(e.amount), output: BigInt(e.output) }))
      .sort((a, b) => (a.block === b.block ? (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0) : a.block < b.block ? -1 : 1));
    let block = 0n, tx = 0n;
    for (const e of sorted) {
      const dBlock = e.block - block;
      ints.push(dBlock, dBlock === 0n ? e.tx - tx : e.tx, e.amount, e.output);
      block = e.block; tx = e.tx;
    }
  }
  const payload = ints.flatMap(leb128);
  // the payload in pushes of at most 520 bytes (a runestone is far smaller)
  const pushes = [];
  for (let k = 0; k < payload.length; k += 520) {
    const chunk = payload.slice(k, k + 520);
    if (chunk.length <= 75) pushes.push(chunk.length, ...chunk);
    else if (chunk.length <= 255) pushes.push(0x4c, chunk.length, ...chunk);
    else pushes.push(0x4d, chunk.length & 0xff, chunk.length >> 8, ...chunk);
  }
  return new Uint8Array([0x6a, 0x5d, ...pushes]);
}

/** The payload of a runestone output script (hex or bytes), or null if it isn't one. cenotaph: not data pushes only. */
export function runestonePayload(script) {
  const s = typeof script === 'string' ? fromHex(script) : script;
  if (s.length < 2 || s[0] !== 0x6a || s[1] !== 0x5d) return null;
  const out = [];
  for (let i = 2; i < s.length;) {
    const op = s[i++];
    let len;
    if (op <= 75) len = op;
    else if (op === 0x4c) len = s[i++];
    else if (op === 0x4d) { len = s[i] | (s[i + 1] << 8); i += 2; }
    else if (op === 0x4e) { len = s[i] | (s[i + 1] << 8) | (s[i + 2] << 16) | (s[i + 3] << 24); i += 4; }
    else return { cenotaph: true, bytes: out };
    if (i + len > s.length) return { cenotaph: true, bytes: out };
    out.push(...s.slice(i, i + len));
    i += len;
  }
  return { cenotaph: false, bytes: out };
}

/**
 * Decodes a runestone: { edicts: [{ id, amount, output }], pointer, mint, etching (bool), cenotaph } or null when the
 * script isn't a runestone.
 */
export function decodeRunestone(script) {
  const p = runestonePayload(script);
  if (!p) return null;
  const ints = unleb128(p.bytes);
  if (p.cenotaph || !ints) return { edicts: [], pointer: null, mint: null, etching: false, cenotaph: true };
  const fields = new Map();
  const edicts = [];
  let i = 0, cenotaph = false, body = false;
  for (; i < ints.length; i += 2) {
    const tag = ints[i];
    if (tag === TAG.body) { i++; body = true; break; }
    if (i + 1 >= ints.length) { cenotaph = true; break; }
    if (!fields.has(tag)) fields.set(tag, []);
    fields.get(tag).push(ints[i + 1]);
  }
  if (body) {
    let block = 0n, tx = 0n;
    const rest = ints.slice(i);
    if (rest.length % 4) cenotaph = true;
    for (let k = 0; k + 3 < rest.length; k += 4) {
      const [db, t, amount, output] = rest.slice(k, k + 4);
      block += db;
      tx = db === 0n ? tx + t : t;
      if (block === 0n && tx > 0n) cenotaph = true;
      edicts.push({ id: `${block}:${tx}`, amount, output: Number(output) });
    }
  }
  for (const tag of fields.keys()) if (tag % 2n === 0n && ![TAG.flags, TAG.rune, 6n, 8n, 10n, 12n, 14n, 16n, 18n, TAG.mint, TAG.pointer].includes(tag)) cenotaph = true;
  const mint = fields.get(TAG.mint);
  return {
    edicts, pointer: fields.has(TAG.pointer) ? Number(fields.get(TAG.pointer)[0]) : null,
    mint: mint && mint.length >= 2 ? `${mint[0]}:${mint[1]}` : null,
    etching: fields.has(TAG.flags) || fields.has(TAG.rune), cenotaph,
  };
}

// ------------------------------------------------------------ inscriptions
const ENVELOPE = '0063036f7264'; // OP_FALSE OP_IF OP_PUSHBYTES_3 "ord"
/** Whether a transaction (Esplora's JSON) reveals an inscription: an envelope in an input's witness. */
export const hasInscription = (tx) => (tx?.vin || []).some((v) => (v.witness || []).some((w) => String(w).includes(ENVELOPE)));
/** Whether a transaction (Esplora's JSON) carries a runestone. */
export const hasRunestone = (tx) => (tx?.vout || []).some((o) => String(o.scriptpubkey || '').startsWith('6a5d'));

/** Hex of a runestone script, for a plan's OP_RETURN output. */
export const runestoneHex = (spec) => toHex(runestoneScript(spec));
