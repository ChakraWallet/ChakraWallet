// Solana programs and accounts for the Contracts tab: what an address is (a program, its data, a token, a wallet, a
// program's account), a program's interface published on chain (Anchor's IDL account, or the Program Metadata
// program), and the upgradeable loader's instructions (deploying a compiled program, upgrading it, its authority).
import { accountInfo, multipleParsed, rpc } from './api.js';
import { addressOf, addressBytes, createWithSeed, findProgramAddress, concat, utf8 } from './core.js';
import { PROGRAMS, u32, u64 } from './tx.js';
import { normalizeIdl } from './idl.js';
import * as b58 from './base58.js';
import { KNOWN_PROGRAMS } from './history.js';

export const PROGRAM_METADATA = 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S';
const NATIVE_PROGRAMS = {
  [PROGRAMS.system]: 'System Program', [PROGRAMS.token]: 'Token Program', [PROGRAMS.token2022]: 'Token-2022', [PROGRAMS.ata]: 'Associated Token Account',
  [PROGRAMS.memo]: 'Memo', [PROGRAMS.computeBudget]: 'Compute Budget', [PROGRAMS.stake]: 'Stake', [PROGRAMS.vote]: 'Vote',
  [PROGRAMS.loaderV3]: 'BPF Upgradeable Loader', [PROGRAMS.addressLookupTable]: 'Address Lookup Table', [PROGRAM_METADATA]: 'Program Metadata',
  ...KNOWN_PROGRAMS,
};
export const programName = (id) => NATIVE_PROGRAMS[id] || null;
const LOADERS = new Set([PROGRAMS.loaderV1, PROGRAMS.loaderV2, PROGRAMS.loaderV3, PROGRAMS.loaderV4, 'NativeLoader1111111111111111111111111111111']);

// ------------------------------------------------------------ what an address is
const u32At = (d, o) => new DataView(d.buffer, d.byteOffset, d.length).getUint32(o, true);
const u64At = (d, o) => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(o, true);
/** Option<Pubkey> as bincode writes it: 1 byte, then 32 when set. */
const optKey = (d, o) => (d[o] ? addressOf(d.slice(o + 1, o + 33)) : null);

/** The upgradeable loader's state of an account: { type: 'buffer' | 'program' | 'programdata', … } or null. */
export function loaderState(data) {
  if (data.length < 4) return null;
  const tag = u32At(data, 0);
  if (tag === 1) return { type: 'buffer', authority: optKey(data, 4), size: data.length - BUFFER_META };
  if (tag === 2) return { type: 'program', programData: addressOf(data.slice(4, 36)) };
  if (tag === 3) return { type: 'programdata', slot: Number(u64At(data, 4)), authority: optKey(data, 12), size: data.length - PROGRAMDATA_META };
  return null;
}
export const BUFFER_META = 37; // tag (4) + Option<Pubkey> (33)
export const PROGRAMDATA_META = 45; // tag (4) + slot (8) + Option<Pubkey> (33)
export const PROGRAM_SPACE = 36; // tag (4) + programdata address (32)

/**
 * What an address is: { address, exists, lamports, owner, ownerName, executable, space, data, kind, … }
 * kind: 'program' (with loader, upgradeable, authority, programData, slot, size) | 'programdata' | 'buffer' | 'mint' |
 * 'tokenAccount' | 'wallet' (system-owned) | 'data' (an account of a program) | 'empty'.
 */
export async function loadSolAccount(chain, address) {
  const acc = await accountInfo(chain, address);
  if (!acc) return { address, exists: false, kind: 'empty', lamports: 0n };
  const base = { address, exists: true, lamports: acc.lamports, owner: acc.owner, ownerName: programName(acc.owner), executable: acc.executable, space: acc.data.length, data: acc.data, name: programName(address) };
  if (acc.executable || LOADERS.has(acc.owner) && loaderState(acc.data)?.type === 'program') {
    const p = { ...base, kind: 'program', loader: acc.owner, upgradeable: false };
    if (acc.owner === PROGRAMS.loaderV3) {
      const st = loaderState(acc.data);
      if (st?.programData) {
        const pd = await accountInfo(chain, st.programData).catch(() => null);
        const ps = pd ? loaderState(pd.data.slice(0, PROGRAMDATA_META)) : null;
        Object.assign(p, { programData: st.programData, upgradeable: !!ps?.authority, authority: ps?.authority || null, slot: ps?.slot ?? null, size: pd ? pd.data.length - PROGRAMDATA_META : null, programDataLamports: pd?.lamports ?? null });
      }
    }
    return p;
  }
  if (acc.owner === PROGRAMS.loaderV3) {
    const st = loaderState(acc.data);
    if (st) return { ...base, kind: st.type, ...st };
  }
  if (acc.owner === PROGRAMS.token || acc.owner === PROGRAMS.token2022) {
    const [parsed] = await multipleParsed(chain, [address]);
    const p = parsed?.data?.parsed;
    if (p?.type === 'mint') return { ...base, kind: 'mint', mint: p.info };
    if (p?.type === 'account') return { ...base, kind: 'tokenAccount', token: p.info };
  }
  if (acc.owner === PROGRAMS.system) return { ...base, kind: 'wallet' };
  return { ...base, kind: 'data' };
}

// ------------------------------------------------------------ interfaces published on chain
async function inflate(bytes, format = 'deflate') {
  const ds = new DecompressionStream(format);
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}
/** Anchor's IDL account of a program: createWithSeed(the program's base PDA, "anchor:idl"). */
export const anchorIdlAddress = (programId) => createWithSeed(findProgramAddress([], programId)[0], 'anchor:idl', programId);
/** The Program Metadata program's canonical "idl" entry of a program. */
export function metadataIdlAddress(programId) {
  const seed = new Uint8Array(16);
  seed.set(utf8('idl'));
  return findProgramAddress([addressBytes(programId), seed], PROGRAM_METADATA)[0];
}

/**
 * A program's IDL from the chain: { idl (normalised), raw (JSON text), source: 'anchor' | 'metadata' } or
 * { codama: true } (a Codama description, not readable here) or null when none is published.
 */
export async function fetchOnchainIdl(chain, programId) {
  // Anchor: discriminator (8), authority (32), length (4), zlib data
  const a = await accountInfo(chain, anchorIdlAddress(programId)).catch(() => null);
  if (a && a.owner === programId && a.data.length > 44) {
    const len = u32At(a.data, 40);
    const raw = new TextDecoder().decode(await inflate(a.data.slice(44, 44 + len)));
    return { idl: normalizeIdl(raw, programId), raw, source: 'anchor' };
  }
  // Program Metadata: header (96 bytes: …, encoding @83, compression @84, data source @86, length @87), then the data
  const m = await accountInfo(chain, metadataIdlAddress(programId)).catch(() => null);
  if (m && m.owner === PROGRAM_METADATA && m.data.length > 96 && m.data[0] === 2) {
    const len = u32At(m.data, 87);
    const body = m.data.slice(96, 96 + len);
    const comp = m.data[84];
    const bytes = comp === 2 ? await inflate(body, 'deflate') : comp === 1 ? await inflate(body, 'gzip') : body;
    const raw = new TextDecoder().decode(bytes);
    const j = JSON.parse(raw);
    if (j.standard === 'codama' || j.kind === 'rootNode') return { codama: true };
    return { idl: normalizeIdl(j, programId), raw, source: 'metadata' };
  }
  return null;
}

// ------------------------------------------------------------ the upgradeable loader (deploying programs)
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
export const programDataAddress = (program) => findProgramAddress([addressBytes(program)], PROGRAMS.loaderV3)[0];

export const loader = {
  initializeBuffer: (buffer, authority) => ({ programId: PROGRAMS.loaderV3, keys: [meta(buffer, false, true), meta(authority, false, false)], data: u32(0) }),
  write: (buffer, authority, offset, bytes) => ({
    programId: PROGRAMS.loaderV3, keys: [meta(buffer, false, true), meta(authority, true, false)],
    data: concat([u32(1), u32(offset), u64(bytes.length), bytes]),
  }),
  deploy: ({ payer, program, buffer, authority, maxLen }) => ({
    programId: PROGRAMS.loaderV3,
    keys: [meta(payer, true, true), meta(programDataAddress(program), false, true), meta(program, false, true), meta(buffer, false, true),
      meta(PROGRAMS.rent, false, false), meta(PROGRAMS.clock, false, false), meta(PROGRAMS.system, false, false), meta(authority, true, false)],
    data: concat([u32(2), u64(maxLen)]),
  }),
  upgrade: ({ program, buffer, spill, authority }) => ({
    programId: PROGRAMS.loaderV3,
    keys: [meta(programDataAddress(program), false, true), meta(program, false, true), meta(buffer, false, true), meta(spill, false, true),
      meta(PROGRAMS.rent, false, false), meta(PROGRAMS.clock, false, false), meta(authority, true, false)],
    data: u32(3),
  }),
  /** New authority of a buffer or of a program's data; next = null makes a program immutable for ever. */
  setAuthority: ({ account, current, next }) => ({
    programId: PROGRAMS.loaderV3, keys: [meta(account, false, true), meta(current, true, false), ...(next ? [meta(next, false, false)] : [])], data: u32(4),
  }),
  /** Closes a buffer, or a program (its data account: the program can't run any more), sending its SOL to `recipient`. */
  close: ({ account, recipient, authority, program = null }) => ({
    programId: PROGRAMS.loaderV3,
    keys: [meta(account, false, true), meta(recipient, false, true), meta(authority, true, false), ...(program ? [meta(program, false, true)] : [])],
    data: u32(5),
  }),
  /**
   * More room for a program's data (an upgrade larger than the space it was deployed with). In a transaction of its
   * own, before the upgrade: the extended program counts as deployed in that slot.
   */
  extend: ({ program, payer, bytes }) => ({
    programId: PROGRAMS.loaderV3,
    keys: [meta(programDataAddress(program), false, true), meta(program, false, true), meta(PROGRAMS.system, false, false), meta(payer, true, true)],
    data: concat([u32(6), u32(bytes)]),
  }),
  /** The same, signed by the upgrade authority (networks where the plain one is no longer accepted). */
  extendChecked: ({ program, authority, payer, bytes }) => ({
    programId: PROGRAMS.loaderV3,
    keys: [meta(programDataAddress(program), false, true), meta(program, false, true), meta(authority, true, false), meta(PROGRAMS.system, false, false), meta(payer, true, true)],
    data: concat([u32(9), u32(bytes)]),
  }),
};

/** Bytes of program written per transaction (a transaction is at most 1232 bytes; one signature). */
export const WRITE_CHUNK = 1000;
/** The pieces of a program to write into its buffer: [{ offset, bytes }]. */
export const chunksOf = (elf, size = WRITE_CHUNK) => Array.from({ length: Math.ceil(elf.length / size) }, (_, i) => ({ offset: i * size, bytes: elf.subarray(i * size, (i + 1) * size) }));
/** Is it a Solana program (an ELF file for the BPF / SBF machine)? */
export const isElf = (b) => b.length > 64 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 && b[4] === 2;

/** Buffers left by interrupted deploys, whose authority is `authority`: [{ address, lamports, size }] (their SOL can be recovered). */
export async function buffersOf(chain, authority) {
  const r = await rpc(chain, 'getProgramAccounts', [PROGRAMS.loaderV3, {
    encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: b58.encode(u32(1)) } }, { memcmp: { offset: 4, bytes: b58.encode(Uint8Array.of(1)) } }, { memcmp: { offset: 5, bytes: authority } }],
  }]);
  return r.map((x) => ({ address: x.pubkey, lamports: BigInt(x.account.lamports), size: (x.account.space ?? 0) - BUFFER_META }));
}
