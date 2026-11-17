// New tokens and NFT collections on Solana, without a compiler: on Solana a token isn't a contract of its own but an
// account of the token program (Token-2022, with its name, symbol and link in the token itself: the metadata
// extension), and an NFT an account of Metaplex Core. Also their management: minting, burning, freezing, authorities,
// metadata. No network here: instructions and the rules for building them.
import { sha256 } from '@noble/hashes/sha256';
import { addressBytes, addressOf, concat, utf8 } from './core.js';
import { PROGRAMS, system, token, createAtaIdempotent, ataAddress, AUTHORITY, u8, u16, u32 } from './tx.js';

export const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const str = (s) => { const b = utf8(s); return concat([u32(b.length), b]); };
const ZERO32 = new Uint8Array(32);
/** OptionalNonZeroPubkey (Token-2022's extensions): 32 bytes, zeros = none. */
const optNonZero = (k) => (k ? addressBytes(k) : ZERO32);
const ixDisc = (s) => sha256(utf8(s)).slice(0, 8);

// ------------------------------------------------------------ Token-2022 with its metadata
export const LIMITS = { name: 32, symbol: 10, uri: 200, decimals: 9 };
const MINT_WITH_POINTER = 165 + 1 + 4 + 64; // base mint padded to an account's size + account type + MetadataPointer TLV
/** Bytes of the metadata extension (TLV) for these texts. */
export const metadataSpace = ({ name, symbol, uri, extra = [] }) => 4 + 32 + 32 + 4 + utf8(name).length + 4 + utf8(symbol).length + 4 + utf8(uri).length
  + 4 + extra.reduce((n, [k, v]) => n + 4 + utf8(k).length + 4 + utf8(v).length, 0);
/** The space the mint account is created with, and the space it will have once the metadata is written (rent). */
export const mintSpace = (texts) => ({ space: MINT_WITH_POINTER, full: MINT_WITH_POINTER + metadataSpace(texts) });

export const metadataIx = {
  initialize: ({ mint, updateAuthority, mintAuthority, name, symbol, uri }) => ({
    programId: PROGRAMS.token2022,
    keys: [meta(mint, false, true), meta(updateAuthority, false, false), meta(mint, false, false), meta(mintAuthority, true, false)],
    data: concat([ixDisc('spl_token_metadata_interface:initialize_account'), str(name), str(symbol), str(uri)]),
  }),
  /** field: 'name' | 'symbol' | 'uri' | any other key (an additional field) */
  updateField: ({ mint, authority, field, value }) => {
    const f = { name: u8(0), symbol: u8(1), uri: u8(2) }[field] || concat([u8(3), str(field)]);
    return { programId: PROGRAMS.token2022, keys: [meta(mint, false, true), meta(authority, true, false)], data: concat([ixDisc('spl_token_metadata_interface:updating_field'), f, str(value)]) };
  },
  /** next = null: the metadata can never change again. */
  updateAuthority: ({ mint, authority, next }) => ({
    programId: PROGRAMS.token2022, keys: [meta(mint, false, true), meta(authority, true, false)],
    data: concat([ixDisc('spl_token_metadata_interface:update_the_authority'), optNonZero(next)]),
  }),
};

/**
 * The instructions creating a token: the mint account (Token-2022, metadata in it), its supply minted to the owner's
 * account; optionally the supply fixed for ever (no mint authority) and no freeze authority from the start.
 * p: { payer, mint (the new account's address: its key signs too), decimals, supply (raw), name, symbol, uri,
 *      fixedSupply, freezable, rent (lamports for the full size: rentExempt(mintSpace(p).full)) }
 */
export function createTokenIxs(p) {
  const { space } = mintSpace(p);
  const program = PROGRAMS.token2022;
  const ata = ataAddress(p.payer, p.mint, program);
  return [
    system.createAccount(p.payer, p.mint, p.rent, space, program),
    { programId: program, keys: [meta(p.mint, false, true)], data: concat([u8(39), u8(0), optNonZero(p.payer), addressBytes(p.mint)]) }, // metadata pointer: the mint itself
    token.initializeMint2({ mint: p.mint, decimals: p.decimals, mintAuthority: p.payer, freezeAuthority: p.freezable ? p.payer : null, program }),
    metadataIx.initialize({ mint: p.mint, updateAuthority: p.payer, mintAuthority: p.payer, name: p.name, symbol: p.symbol, uri: p.uri }),
    ...(BigInt(p.supply) > 0n ? [
      createAtaIdempotent({ payer: p.payer, owner: p.payer, mint: p.mint, program, ata }),
      token.mintTo({ mint: p.mint, destination: ata, authority: p.payer, amount: p.supply, program }),
    ] : []),
    ...(p.fixedSupply ? [token.setAuthority({ account: p.mint, current: p.payer, type: AUTHORITY.mint, next: null, program })] : []),
  ];
}

/** Management of a token the user has authority on. Every builder gets the mint's program (Token or Token-2022). */
export const tokenAdmin = {
  /** Mint `amount` to `to` (its token account is opened if missing). */
  mint: ({ payer, mint, program, to, amount }) => {
    const dest = ataAddress(to, mint, program);
    return [createAtaIdempotent({ payer, owner: to, mint, program, ata: dest }), token.mintTo({ mint, destination: dest, authority: payer, amount, program })];
  },
  burn: ({ owner, mint, program, amount, decimals, account = ataAddress(owner, mint, program) }) => [token.burnChecked({ account, mint, owner, amount, decimals, program })],
  freeze: ({ authority, mint, program, holder }) => [token.freeze({ account: ataAddress(holder, mint, program), mint, authority, program })],
  thaw: ({ authority, mint, program, holder }) => [token.thaw({ account: ataAddress(holder, mint, program), mint, authority, program })],
  /** kind: 'mint' | 'freeze'; next = null gives it up for ever. */
  authority: ({ current, mint, program, kind, next }) => [token.setAuthority({ account: mint, current, type: kind === 'mint' ? AUTHORITY.mint : AUTHORITY.freeze, next, program })],
};

/**
 * Lamports to add to a Token-2022 mint before its metadata grows (the account must stay rent-exempt): the rent of the
 * new size minus what it holds. texts: the metadata after the change.
 */
export const topUp = (rentNew, lamportsNow) => (rentNew > lamportsNow ? rentNew - lamportsNow : 0n);

/** The token-metadata extension of a Token-2022 mint's data: { updateAuthority, name, symbol, uri, extra } or null. */
export function readMintMetadata(data) {
  if (data.length <= 166 || data[165] !== 1) return null;
  let o = 166;
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  while (o + 4 <= data.length) {
    const type = dv.getUint16(o, true), len = dv.getUint16(o + 2, true);
    if (type === 19) { // TokenMetadata
      let p = o + 4;
      const rd = () => { const n = dv.getUint32(p, true); const s = new TextDecoder().decode(data.slice(p + 4, p + 4 + n)); p += 4 + n; return s; };
      const ua = data.slice(p, p + 32); p += 64; // update authority, mint
      const name = rd(), symbol = rd(), uri = rd();
      const extra = [];
      const n = dv.getUint32(p, true); p += 4;
      for (let i = 0; i < n && i < 50; i++) extra.push([rd(), rd()]);
      return { updateAuthority: ua.every((x) => x === 0) ? null : addressOf(ua), name, symbol, uri, extra, space: len };
    }
    if (type === 0 && len === 0) break;
    o += 4 + len;
  }
  return null;
}

// ------------------------------------------------------------ Metaplex Core (NFTs)
const PERCENT_ALL = 100;
/** Royalties plugin: { basisPoints, creators: [{ address, percentage }], ruleSet: None }, with no explicit authority. */
const royaltiesPlugins = (bps, creator) => (bps > 0
  ? concat([u8(1), u32(1), u8(0) /* Plugin::Royalties */, u16(bps), u32(1), addressBytes(creator), u8(PERCENT_ALL), u8(0) /* RuleSet::None */, u8(0) /* authority: None */])
  : u8(0));

export const core = {
  /** A new collection (its address: a new key, which signs). royaltyBps: 500 = 5% to `royaltyTo`. */
  createCollection: ({ payer, collection, name, uri, royaltyBps = 0, royaltyTo = payer }) => ({
    programId: CORE,
    keys: [meta(collection, true, true), meta(CORE, false, false) /* update authority: the payer */, meta(payer, true, true), meta(PROGRAMS.system, false, false)],
    data: concat([u8(1), str(name), str(uri), royaltiesPlugins(royaltyBps, royaltyTo)]),
  }),
  /** A new NFT (its address: a new key, which signs), in a collection the payer is the authority of, for `owner`. */
  createAsset: ({ payer, asset, collection = null, name, uri, owner = null }) => ({
    programId: CORE,
    keys: [
      meta(asset, true, true), collection ? meta(collection, false, true) : meta(CORE, false, false), meta(CORE, false, false) /* authority: the payer */,
      meta(payer, true, true), owner ? meta(owner, false, false) : meta(CORE, false, false), meta(CORE, false, false) /* update authority */,
      meta(PROGRAMS.system, false, false), meta(CORE, false, false) /* log wrapper */,
    ],
    data: concat([u8(0), u8(0) /* DataState::AccountState */, str(name), str(uri), u8(0) /* no plugins */]),
  }),
  /** Gives an NFT to `newOwner` (the payer owns it; `collection` when it belongs to one). */
  transfer: ({ payer, asset, collection = null, newOwner }) => ({
    programId: CORE,
    keys: [
      meta(asset, false, true), collection ? meta(collection, false, false) : meta(CORE, false, false), meta(payer, true, true), meta(CORE, false, false) /* authority: the payer */,
      meta(newOwner, false, false), meta(CORE, false, false) /* system program: not needed */, meta(CORE, false, false) /* log wrapper */,
    ],
    data: concat([u8(14), u8(0) /* no compression proof */]),
  }),
  updateCollection: ({ payer, collection, name = null, uri = null }) => ({
    programId: CORE,
    keys: [meta(collection, false, true), meta(payer, true, true), meta(CORE, false, false) /* authority: the payer */, meta(CORE, false, false) /* new update authority */, meta(PROGRAMS.system, false, false), meta(CORE, false, false)],
    data: concat([u8(16), name == null ? u8(0) : concat([u8(1), str(name)]), uri == null ? u8(0) : concat([u8(1), str(uri)])]),
  }),
};

/** A Core account's data: { kind: 'asset', owner, updateAuthority, collection, name, uri } | { kind: 'collection', updateAuthority, name, uri, minted, size } | null. */
export function readCore(data) {
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.length);
    let o = 1;
    const rd = () => { const n = dv.getUint32(o, true); if (n > 2000) throw new Error('bad'); const s = new TextDecoder().decode(data.slice(o + 4, o + 4 + n)); o += 4 + n; return s; };
    if (data[0] === 1) { // AssetV1
      const owner = addressOf(data.slice(1, 33)); o = 33;
      const uaKind = data[o]; o += 1;
      let ua = null, collection = null;
      if (uaKind === 1) { ua = addressOf(data.slice(o, o + 32)); o += 32; } else if (uaKind === 2) { collection = addressOf(data.slice(o, o + 32)); o += 32; }
      return { kind: 'asset', owner, updateAuthority: ua, collection, name: rd(), uri: rd() };
    }
    if (data[0] === 5) { // CollectionV1
      const ua = addressOf(data.slice(1, 33)); o = 33;
      const name = rd(), uri = rd();
      return { kind: 'collection', updateAuthority: ua, name, uri, minted: dv.getUint32(o, true), size: dv.getUint32(o + 4, true) };
    }
  } catch { /* not a Core account */ }
  return null;
}

/** The JSON a token's or an NFT's link should point to (Metaplex's standard): to be hosted by the user. */
export const metadataJson = ({ name, symbol = '', description = '', image = '' }) => JSON.stringify({ name, symbol, description, image }, null, 2);
