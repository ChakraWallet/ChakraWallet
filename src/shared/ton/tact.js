// Tact contracts compiled in the app (TON studio, Android): init data, message bodies and get-method arguments built
// from the ABI and from the cell layout ("allocation") the compiler returns for every type - the same layout its
// TypeScript bindings use. Supported field types: integers (fixed size, coins), bool, address, cell/slice/builder,
// string, fixed bytes, maps (as a BoC), structs (inline or as a reference), optional values of all of them.
import { beginCell, Cell } from '@ton/core';
import { Buffer } from './buffer.js';
import { parseBig, parseAddr, parseBoc, FieldError, toB64 } from './cells.js';
import { parseAmount } from '../format.js';

/** How a form shows an ABI type: { kind: int | uint | coins | bool | address | cell | string | bytes | map | struct | unsupported, bits?, bytes?, type?, optional } */
export function fieldKind(type, types = {}) {
  const optional = !!type?.optional;
  if (type?.kind === 'dict') return { kind: 'map', optional: true };
  if (type?.kind !== 'simple') return { kind: 'unsupported', optional };
  const ty = type.type, f = type.format;
  if (ty === 'int' || ty === 'uint') {
    if (f === 'coins') return { kind: 'coins', optional };
    if (f == null || typeof f === 'number') return { kind: ty, bits: f ?? (ty === 'int' ? 257 : 256), optional };
    return { kind: 'unsupported', optional };
  }
  if (ty === 'bool') return { kind: 'bool', optional };
  if (ty === 'address') return { kind: 'address', optional };
  if (ty === 'cell' || ty === 'slice' || ty === 'builder') return { kind: 'cell', optional, remainder: f === 'remainder' };
  if (ty === 'string') return { kind: 'string', optional };
  if (ty === 'fixed-bytes') return { kind: 'bytes', bytes: f, optional };
  if (types[ty]) return { kind: 'struct', type: ty, optional };
  return { kind: 'unsupported', optional };
}

/** Empty form value for a type (structs: an object with their fields). */
export function emptyOf(type, types = {}, abiTypes = []) {
  const k = fieldKind(type, types);
  if (k.kind === 'struct' && !k.optional) {
    const def = abiTypes.find((x) => x.name === k.type);
    return Object.fromEntries((def?.fields || []).map((f) => [f.name, emptyOf(f.type, types, abiTypes)]));
  }
  if (k.kind === 'bool') return k.optional ? '' : false;
  if (k.kind === 'coins') return { v: '', unit: 9 };
  return '';
}

const isEmpty = (v) => v == null || v === '' || (typeof v === 'object' && !Object.keys(v).length) || (v && typeof v === 'object' && 'v' in v && v.v === '');

function coinsOf(v) {
  if (v && typeof v === 'object' && 'v' in v) {
    const n = v.unit ? parseAmount(v.v, v.unit) : parseBig(v.v);
    if (n == null || n < 0n) throw new FieldError('tonc.err.amount');
    return n;
  }
  const n = parseBig(v);
  if (n < 0n) throw new FieldError('tonc.err.amount');
  return n;
}

function storeStruct(b, name, value, types) {
  const t = types[name];
  if (!t) throw new FieldError('tonc.tact.err.type', { type: name });
  if (t.header != null) b.storeUint(t.header, 32);
  storeAllocation(b, t.root, value || {}, types);
}

function storeField(b, f, v, types, path) {
  const op = f.op, ty = f.type;
  try {
    if (op.kind === 'address') { b.storeAddress(parseAddr(typeof v === 'string' ? v : '', { optional: op.optional })); return; }
    if (op.kind === 'map') { b.storeMaybeRef(isEmpty(v) ? null : parseBoc(v)); return; }
    if (op.optional) {
      if (isEmpty(v) && !(op.kind === 'boolean' && v === false)) { b.storeBit(0); return; }
      b.storeBit(1);
    }
    switch (op.kind) {
      case 'int': b.storeInt(parseBig(v), op.bits); return;
      case 'uint': b.storeUint(parseBig(v), op.bits); return;
      case 'varuint16':
        if (ty?.format !== 'coins') throw new FieldError('tonc.tact.err.varint');
        b.storeCoins(coinsOf(v)); return;
      case 'boolean': b.storeBit(v === true || v === 'true'); return;
      case 'cell': case 'slice': case 'builder': {
        const c = parseBoc(v);
        if (op.format === 'remainder') b.storeSlice(c.beginParse()); else b.storeRef(c);
        return;
      }
      case 'string': b.storeStringRefTail(String(v)); return;
      case 'fixed-bytes': {
        const s = String(v).trim().replace(/^0x/, '');
        if (!/^[0-9a-fA-F]*$/.test(s) || s.length !== op.bytes * 2) throw new FieldError('tonc.tact.err.bytes', { n: op.bytes });
        b.storeBuffer(Buffer.from(s, 'hex')); return;
      }
      case 'struct':
        if (op.ref) { const c = beginCell(); storeStruct(c, op.type, v, types); b.storeRef(c.endCell()); } else storeStruct(b, op.type, v, types);
        return;
      default: throw new FieldError('tonc.tact.err.varint');
    }
  } catch (e) {
    if (e instanceof FieldError && !e.path) e.path = path;
    if (e instanceof FieldError) throw e;
    throw Object.assign(new FieldError('tonc.err.range', { bits: op.bits ?? '' }), { path });
  }
}

function storeAllocation(b, alloc, values, types, prefix = '') {
  for (const f of alloc.ops) storeField(b, f, values?.[f.name], types, prefix + f.name);
  if (alloc.next) {
    const nb = beginCell();
    storeAllocation(nb, alloc.next, values, types, prefix);
    b.storeRef(nb.endCell());
  }
}

/** Data cell of a new contract from its init arguments (values by argument name). */
export function tactInitData(init, values, types) {
  if (!init) return beginCell().endCell();
  if (init.unsupported || !init.allocation) throw new FieldError('tonc.tact.err.initUnsupported');
  const b = beginCell();
  if (init.system) b.storeRef(Cell.fromBase64(init.system));
  if (init.prefix) b.storeUint(init.prefix.value, init.prefix.bits);
  storeAllocation(b, init.allocation, values, types);
  return b.endCell();
}

/** Body of a typed message (its 32-bit header + fields). */
export function tactMessageBody(typeName, values, types) {
  const b = beginCell();
  storeStruct(b, typeName, values, types);
  return b.endCell();
}

/** A get-method argument in the format of cells.stackArg (or a raw TON Center stack entry for strings). */
export function tactStackArg(type, value) {
  const k = fieldKind(type);
  if (k.kind === 'int' || k.kind === 'uint') return { type: 'int', value };
  if (k.kind === 'coins') return { type: 'int', value: coinsOf(value).toString() };
  if (k.kind === 'bool') return { type: 'int', value: value === true || value === 'true' ? '-1' : '0' };
  if (k.kind === 'address') return { type: 'address', value };
  if (k.kind === 'cell') return { type: type.type === 'slice' ? 'slice' : 'cell', value };
  if (k.kind === 'string') return { type: 'slice', value: toB64(beginCell().storeStringTail(String(value)).endCell()) };
  throw new FieldError('tonc.tact.err.arg');
}

/** Result type hint (shared/ton/contracts.js interpret) for a getter's return type. */
export function tactHint(type) {
  if (!type || type.kind !== 'simple') return null;
  if (type.type === 'bool') return 'bool';
  if (type.type === 'address') return 'address';
  if (type.type === 'int' || type.type === 'uint') return type.format === 'coins' ? 'amount' : 'int';
  if (type.type === 'cell' || type.type === 'slice') return 'cell';
  return null;
}

/** Readable signature of an ABI type, e.g. "Int as uint32", "Address?", "map<Int, Address>". */
export function typeLabel(type) {
  if (!type) return '';
  if (type.kind === 'dict') return `map<${type.key}, ${type.value}>`;
  const base = { int: 'Int', uint: 'Int', bool: 'Bool', address: 'Address', cell: 'Cell', slice: 'Slice', builder: 'Builder', string: 'String', 'fixed-bytes': 'Slice' }[type.type] || type.type;
  const fmt = type.format != null ? ` as ${typeof type.format === 'number' ? (type.type === 'uint' ? 'uint' : type.type === 'fixed-bytes' ? 'bytes' : 'int') + type.format : type.format}` : '';
  return `${base}${type.optional ? '?' : ''}${fmt}`;
}

/** Receivers of the ABI a wallet can call: [{ kind: 'typed', type } | { kind: 'text', text } | { kind: 'anyText' } | { kind: 'empty' }] */
export function tactReceivers(abi) {
  return (abi?.receivers || []).filter((r) => r.receiver === 'internal').map((r) => {
    const m = r.message || {};
    if (m.kind === 'typed') return { kind: 'typed', type: m.type };
    if (m.kind === 'text' && m.text != null) return { kind: 'text', text: m.text };
    if (m.kind === 'text') return { kind: 'anyText' };
    if (m.kind === 'empty') return { kind: 'empty' };
    return { kind: 'any' };
  });
}

export const DEFAULT_TACT = `// A simple counter: anyone can add to it, only the owner can reset it.
message Add {
    amount: Int as uint32;
}

contract Counter {
    owner: Address;
    counter: Int as uint32 = 0;

    init(owner: Address) {
        self.owner = owner;
    }

    // deployment and plain GRAM transfers
    receive() {}

    receive(msg: Add) {
        self.counter += msg.amount;
    }

    receive("reset") {
        require(sender() == self.owner, "Only the owner can reset");
        self.counter = 0;
    }

    get fun counter(): Int {
        return self.counter;
    }

    get fun owner(): Address {
        return self.owner;
    }
}
`;
