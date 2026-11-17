// Solana transactions: the wire format (legacy and version 0 messages, with address lookup tables), signing, and the
// instructions of the standard programs the wallet uses (System, Compute Budget, Memo, SPL Token / Token-2022,
// Associated Token Account). No network here.
//
// An instruction is { programId, keys: [{ pubkey, isSigner, isWritable }], data: Uint8Array } (addresses as base58).
import { addressBytes, addressOf, concat, utf8, findProgramAddress, signBytes, keyOfSeed, equalBytes } from './core.js';
import * as b58 from './base58.js';

export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  memoV1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  rent: 'SysvarRent111111111111111111111111111111111',
  clock: 'SysvarC1ock11111111111111111111111111111111',
  instructions: 'Sysvar1nstructions1111111111111111111111111',
  loaderV3: 'BPFLoaderUpgradeab1e11111111111111111111111',
  loaderV2: 'BPFLoader2111111111111111111111111111111111',
  loaderV1: 'BPFLoader1111111111111111111111111111111111',
  loaderV4: 'LoaderV411111111111111111111111111111111111',
  addressLookupTable: 'AddressLookupTab1e1111111111111111111111111',
  stake: 'Stake11111111111111111111111111111111111111',
  vote: 'Vote111111111111111111111111111111111111111',
};
/** wrapped SOL (the native coin as an SPL token, in swaps and bridges). */
export const WSOL = 'So11111111111111111111111111111111111111112';
export const isTokenProgram = (p) => p === PROGRAMS.token || p === PROGRAMS.token2022;

// ------------------------------------------------------------ little-endian writers
export const u8 = (n) => Uint8Array.of(Number(n) & 0xff);
export const u16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(n), true); return b; };
export const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n) >>> 0, true); return b; };
export const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
export const i64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; };

/** compact-u16 ("shortvec"): the length prefix of the wire format. */
export function compactU16(n) {
  const out = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) { out.push(b | 0x80); } else { out.push(b); break; }
  }
  return Uint8Array.from(out);
}
function readCompactU16(bytes, o) {
  let v = 0, size = 0;
  for (;;) {
    const b = bytes[o + size];
    if (b === undefined) throw new Error('truncated');
    v |= (b & 0x7f) << (7 * size);
    size++;
    if (!(b & 0x80)) break;
    if (size > 3) throw new Error('bad length');
  }
  return [v, size];
}

// ------------------------------------------------------------ compiling a message
/**
 * Builds a message: { payer, instructions, recentBlockhash, lookupTables? } -> bytes. With lookupTables
 * ([{ key, addresses }]) a version 0 message: accounts found in a table (not signers, not programs) go by index.
 */
export function compileMessage({ payer, instructions, recentBlockhash, lookupTables = null }) {
  const metas = new Map(); // address -> { signer, writable, program }
  const add = (k, signer, writable, program = false) => {
    const m = metas.get(k) || { signer: false, writable: false, program: false };
    m.signer ||= signer; m.writable ||= writable; m.program ||= program;
    metas.set(k, m);
  };
  add(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, !!k.isSigner, !!k.isWritable);
    add(ix.programId, false, false, true);
  }
  // accounts found in a lookup table (version 0 only)
  const looked = new Map(); // address -> { table, index }
  if (lookupTables) {
    for (const [k, m] of metas) {
      if (m.signer || m.program) continue;
      for (let t = 0; t < lookupTables.length && !looked.has(k); t++) {
        const i = lookupTables[t].addresses.indexOf(k);
        if (i >= 0 && i < 256) looked.set(k, { table: t, index: i });
      }
    }
  }
  const entries = [...metas.entries()].filter(([k]) => !looked.has(k));
  const group = (signer, writable) => entries.filter(([k, m]) => k !== payer && m.signer === signer && m.writable === writable).map(([k]) => k);
  const statics = [payer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const header = [1 + group(true, true).length + group(true, false).length, group(true, false).length, group(false, false).length];
  // lookups: per table, the writable then the readonly indexes; the loaded accounts follow the static ones
  const tables = (lookupTables || []).map((tb, t) => {
    const mine = [...looked.entries()].filter(([, v]) => v.table === t);
    return {
      key: tb.key,
      writable: mine.filter(([k]) => metas.get(k).writable).map(([k, v]) => [k, v.index]),
      readonly: mine.filter(([k]) => !metas.get(k).writable).map(([k, v]) => [k, v.index]),
    };
  }).filter((x) => x.writable.length || x.readonly.length);
  const order = [...statics, ...tables.flatMap((x) => x.writable.map(([k]) => k)), ...tables.flatMap((x) => x.readonly.map(([k]) => k))];
  const at = new Map(order.map((k, i) => [k, i]));
  if (order.length > 256) throw new Error('too many accounts');
  const ixBytes = instructions.map((ix) => concat([
    u8(at.get(ix.programId)), compactU16(ix.keys.length), Uint8Array.from(ix.keys.map((k) => at.get(k.pubkey))),
    compactU16(ix.data.length), ix.data,
  ]));
  const body = [
    Uint8Array.from(header), compactU16(statics.length), ...statics.map(addressBytes), addressBytes(recentBlockhash),
    compactU16(ixBytes.length), ...ixBytes,
  ];
  if (!lookupTables) return concat(body);
  return concat([
    u8(0x80), ...body, compactU16(tables.length),
    ...tables.map((x) => concat([
      addressBytes(x.key), compactU16(x.writable.length), Uint8Array.from(x.writable.map(([, i]) => i)),
      compactU16(x.readonly.length), Uint8Array.from(x.readonly.map(([, i]) => i)),
    ])),
  ]);
}

// ------------------------------------------------------------ reading a message
/**
 * bytes -> { version: 'legacy' | 0, header: { signatures, readonlySigned, readonlyUnsigned }, keys (static, base58),
 * recentBlockhash, instructions: [{ programIndex, accounts: [index], data }], lookups: [{ key, writable, readonly }] }.
 */
export function parseMessage(bytes) {
  let o = 0;
  let version = 'legacy';
  if (bytes[0] & 0x80) {
    version = bytes[0] & 0x7f;
    if (version !== 0) throw new Error(`unsupported message version ${version}`);
    o = 1;
  }
  const header = { signatures: bytes[o], readonlySigned: bytes[o + 1], readonlyUnsigned: bytes[o + 2] };
  o += 3;
  const read = () => { const [v, n] = readCompactU16(bytes, o); o += n; return v; };
  const take = (n) => { if (o + n > bytes.length) throw new Error('truncated'); const b = bytes.slice(o, o + n); o += n; return b; };
  const nKeys = read();
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(addressOf(take(32)));
  const recentBlockhash = addressOf(take(32));
  const nIx = read();
  const instructions = [];
  for (let i = 0; i < nIx; i++) {
    const programIndex = take(1)[0];
    const accounts = Array.from(take(read()));
    const data = take(read());
    instructions.push({ programIndex, accounts, data });
  }
  const lookups = [];
  if (version === 0) {
    const n = read();
    for (let i = 0; i < n; i++) {
      const key = addressOf(take(32));
      const writable = Array.from(take(read()));
      const readonly = Array.from(take(read()));
      lookups.push({ key, writable, readonly });
    }
  }
  if (o !== bytes.length) throw new Error('trailing bytes');
  if (header.signatures > nKeys || header.signatures < 1) throw new Error('bad header');
  return { version, header, keys, recentBlockhash, instructions, lookups };
}

/**
 * Every account of a parsed message, in index order, with its role: [{ pubkey, signer, writable, lookup? }].
 * `loaded`: the lookup tables' contents { [table key]: [addresses] } (missing tables leave `pubkey` null).
 */
export function messageAccounts(msg, loaded = {}) {
  const { signatures, readonlySigned, readonlyUnsigned } = msg.header;
  const out = msg.keys.map((pubkey, i) => ({
    pubkey, signer: i < signatures,
    writable: i < signatures ? i < signatures - readonlySigned : i < msg.keys.length - readonlyUnsigned,
  }));
  for (const l of msg.lookups) for (const i of l.writable) out.push({ pubkey: loaded[l.key]?.[i] ?? null, signer: false, writable: true, lookup: l.key });
  for (const l of msg.lookups) for (const i of l.readonly) out.push({ pubkey: loaded[l.key]?.[i] ?? null, signer: false, writable: false, lookup: l.key });
  return out;
}

/** A parsed message's instructions as instructions: { programId, keys: [{ pubkey, isSigner, isWritable }], data }. */
export function messageInstructions(msg, loaded = {}) {
  const acc = messageAccounts(msg, loaded);
  return msg.instructions.map((ix) => ({
    programId: acc[ix.programIndex]?.pubkey,
    keys: ix.accounts.map((i) => ({ pubkey: acc[i]?.pubkey ?? null, isSigner: !!acc[i]?.signer, isWritable: !!acc[i]?.writable })),
    data: ix.data,
  }));
}

// ------------------------------------------------------------ transactions
const ZERO_SIG = new Uint8Array(64);
/** signatures (64 bytes each, zeros where not signed yet) + message -> wire bytes. */
export const serializeTransaction = (signatures, message) => concat([compactU16(signatures.length), ...signatures, message]);

/** Wire bytes -> { signatures: [Uint8Array(64)], message (bytes), msg (parsed) }. */
export function parseTransaction(bytes) {
  const [n, size] = readCompactU16(bytes, 0);
  let o = size;
  const signatures = [];
  for (let i = 0; i < n; i++) { signatures.push(bytes.slice(o, o + 64)); o += 64; }
  const message = bytes.slice(o);
  const msg = parseMessage(message);
  if (n !== msg.header.signatures) throw new Error('signature count');
  return { signatures, message, msg };
}

/** A new unsigned transaction for a message: the signature slots it needs, empty. */
export const unsignedTransaction = (message) => serializeTransaction(Array.from({ length: parseMessage(message).header.signatures }, () => ZERO_SIG), message);

/**
 * Signs a transaction (wire bytes) with the given 32-byte seeds, each in the slot of its address among the signers.
 * Throws when a key isn't a signer of the message. Returns { bytes, signature (base58, the first slot: the id) }.
 */
export function signTransaction(bytes, seeds) {
  const tx = parseTransaction(bytes);
  for (const seed of seeds) {
    const { address } = keyOfSeed(seed);
    const i = tx.msg.keys.slice(0, tx.msg.header.signatures).indexOf(address);
    if (i < 0) throw new Error('not a signer of this transaction');
    tx.signatures[i] = signBytes(tx.message, seed);
  }
  return { bytes: serializeTransaction(tx.signatures, tx.message), signature: b58.encode(tx.signatures[0]) };
}
/** The id of a signed transaction: its first signature, base58. */
export const transactionId = (bytes) => b58.encode(parseTransaction(bytes).signatures[0]);
export const isSigned = (sig) => !equalBytes(sig, ZERO_SIG);

/** Size limit of a transaction on the wire. */
export const MAX_TX_SIZE = 1232;

// ------------------------------------------------------------ instructions of the standard programs
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

export const system = {
  transfer: (from, to, lamports) => ({ programId: PROGRAMS.system, keys: [meta(from, true, true), meta(to, false, true)], data: concat([u32(2), u64(lamports)]) }),
  createAccount: (from, account, lamports, space, owner) => ({
    programId: PROGRAMS.system, keys: [meta(from, true, true), meta(account, true, true)],
    data: concat([u32(0), u64(lamports), u64(space), addressBytes(owner)]),
  }),
};

export const computeBudget = {
  unitLimit: (units) => ({ programId: PROGRAMS.computeBudget, keys: [], data: concat([u8(2), u32(units)]) }),
  /** price of a compute unit in micro-lamports: the priority fee */
  unitPrice: (microLamports) => ({ programId: PROGRAMS.computeBudget, keys: [], data: concat([u8(3), u64(microLamports)]) }),
};

/** A memo (text) attached to the transaction, signed by `signer`. */
export const memo = (text, signer) => ({ programId: PROGRAMS.memo, keys: [meta(signer, true, true)], data: utf8(text) });

/** COption<Pubkey> as the token programs pack it: 1 + 32 bytes when set, 1 byte when not. */
const optionKey = (k) => (k ? concat([u8(1), addressBytes(k)]) : u8(0));
export const AUTHORITY = { mint: 0, freeze: 1, owner: 2, close: 3, metadataPointer: 12, metadata: 12 };

export const token = {
  transferChecked: ({ source, mint, destination, owner, amount, decimals, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(source, false, true), meta(mint, false, false), meta(destination, false, true), meta(owner, true, false)],
    data: concat([u8(12), u64(amount), u8(decimals)]),
  }),
  mintTo: ({ mint, destination, authority, amount, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(mint, false, true), meta(destination, false, true), meta(authority, true, false)], data: concat([u8(7), u64(amount)]),
  }),
  burnChecked: ({ account, mint, owner, amount, decimals, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(account, false, true), meta(mint, false, true), meta(owner, true, false)], data: concat([u8(15), u64(amount), u8(decimals)]),
  }),
  setAuthority: ({ account, current, type, next, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(account, false, true), meta(current, true, false)], data: concat([u8(6), u8(type), optionKey(next)]),
  }),
  freeze: ({ account, mint, authority, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(account, false, true), meta(mint, false, false), meta(authority, true, false)], data: u8(10),
  }),
  thaw: ({ account, mint, authority, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(account, false, true), meta(mint, false, false), meta(authority, true, false)], data: u8(11),
  }),
  closeAccount: ({ account, destination, owner, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(account, false, true), meta(destination, false, true), meta(owner, true, false)], data: u8(9),
  }),
  initializeMint2: ({ mint, decimals, mintAuthority, freezeAuthority = null, program = PROGRAMS.token }) => ({
    programId: program, keys: [meta(mint, false, true)], data: concat([u8(20), u8(decimals), addressBytes(mintAuthority), optionKey(freezeAuthority)]),
  }),
  syncNative: (account, program = PROGRAMS.token) => ({ programId: program, keys: [meta(account, false, true)], data: u8(17) }),
};

/** The associated token account of an owner for a mint (the address wallets send that token to). */
export const ataAddress = (owner, mint, program = PROGRAMS.token) => findProgramAddress([addressBytes(owner), addressBytes(program), addressBytes(mint)], PROGRAMS.ata)[0];

/** Creates the associated token account if it doesn't exist yet (no error when it does). */
export const createAtaIdempotent = ({ payer, owner, mint, program = PROGRAMS.token, ata = ataAddress(owner, mint, program) }) => ({
  programId: PROGRAMS.ata,
  keys: [meta(payer, true, true), meta(ata, false, true), meta(owner, false, false), meta(mint, false, false), meta(PROGRAMS.system, false, false), meta(program, false, false)],
  data: u8(1),
});

/** A transaction ready to sign: { payer, instructions, recentBlockhash, lookupTables? } -> wire bytes, unsigned. */
export const buildTransaction = (p) => unsignedTransaction(compileMessage(p));
