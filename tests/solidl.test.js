// Solana programs: IDLs in their three formats, Borsh, instructions built from an IDL (checked against the bytes of the
// hand-written Metaplex Core templates), program-derived accounts, the upgradeable loader's accounts, Token-2022 metadata.
// tests/fixtures/mpl-core-idl.json: a part of Metaplex Core's own IDL (github.com/metaplex-foundation/mpl-core, idls/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha256';
import coreIdl from './fixtures/mpl-core-idl.json';
import { normalizeIdl, encode, decode, buildIxFromIdl, autoAccounts, decodeAccount, decodeInstruction, idlError, snake, toBytes } from '../src/shared/solana/idl.js';
import { keyOfSeed, findProgramAddress, addressBytes, toHex, utf8, concat } from '../src/shared/solana/core.js';
import { PROGRAMS, u32, u64 } from '../src/shared/solana/tx.js';
import { core, CORE, readCore, readMintMetadata, metadataSpace, mintSpace, createTokenIxs } from '../src/shared/solana/templates.js';
import { loaderState, chunksOf, isElf, programDataAddress, loader, BUFFER_META } from '../src/shared/solana/programs.js';
import { spamSplToken } from '../src/shared/solana/tokens.js';

const ME = keyOfSeed(new Uint8Array(32).fill(7)).address, OTHER = keyOfSeed(new Uint8Array(32).fill(8)).address, NEW = keyOfSeed(new Uint8Array(32).fill(9)).address;

test('Shank IDL (Metaplex Core): the generic encoder gives the bytes of the hand-written templates', () => {
  const idl = normalizeIdl(coreIdl);
  assert.equal(idl.format, 'shank');
  const createColl = idl.instructions.find((x) => x.name === 'CreateCollectionV1');
  assert.deepEqual(Array.from(createColl.discriminator), [1]);
  // a collection with 5% royalties to ME
  const args = { createCollectionV1Args: {
    name: 'Cats', uri: 'https://x/c.json',
    plugins: [{ plugin: { __variant: 'Royalties', _0: { basisPoints: 500n, creators: [{ address: ME, percentage: 100 }], ruleSet: { __variant: 'None' } } }, authority: null }],
  } };
  const viaIdl = buildIxFromIdl(idl, createColl, { programId: CORE, args, accounts: { collection: NEW, payer: ME, systemProgram: PROGRAMS.system } });
  const byHand = core.createCollection({ payer: ME, collection: NEW, name: 'Cats', uri: 'https://x/c.json', royaltyBps: 500, royaltyTo: ME });
  assert.equal(toHex(viaIdl.data), toHex(byHand.data));
  assert.deepEqual(viaIdl.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), byHand.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), 'an absent optional account is the program id');
  // an NFT in that collection, for OTHER
  const createAsset = idl.instructions.find((x) => x.name === 'CreateV1');
  const a = buildIxFromIdl(idl, createAsset, {
    programId: CORE, args: { createV1Args: { dataState: { __variant: 'AccountState' }, name: 'Cat #1', uri: 'u', plugins: null } },
    accounts: { asset: NEW, collection: OTHER, payer: ME, owner: ME, systemProgram: PROGRAMS.system },
  });
  const h = core.createAsset({ payer: ME, asset: NEW, collection: OTHER, name: 'Cat #1', uri: 'u', owner: ME });
  assert.equal(toHex(a.data), toHex(h.data));
  assert.deepEqual(a.keys.map((k) => k.pubkey), h.keys.map((k) => k.pubkey));
  // transfer and collection update, and reading an instruction back
  const tr = idl.instructions.find((x) => x.name === 'TransferV1');
  const t1 = buildIxFromIdl(idl, tr, { programId: CORE, args: { transferV1Args: { compressionProof: null } }, accounts: { asset: NEW, payer: ME, newOwner: OTHER } });
  assert.equal(toHex(t1.data), toHex(core.transfer({ payer: ME, asset: NEW, newOwner: OTHER }).data));
  const up = idl.instructions.find((x) => x.name === 'UpdateCollectionV1');
  const u1 = buildIxFromIdl(idl, up, { programId: CORE, args: { updateCollectionV1Args: { newName: 'Dogs', newUri: null } }, accounts: { collection: NEW, payer: ME, systemProgram: PROGRAMS.system } });
  assert.equal(toHex(u1.data), toHex(core.updateCollection({ payer: ME, collection: NEW, name: 'Dogs' }).data));
  const back = decodeInstruction(idl, byHand.data);
  assert.equal(back.ix.name, 'CreateCollectionV1');
  assert.equal(back.args.createCollectionV1Args.plugins[0].plugin._0.basisPoints, 500n);
  assert.equal(back.args.createCollectionV1Args.plugins[0].plugin._0.creators[0].address, ME);
});

test('Anchor up to 0.29: discriminators from the names, accounts isMut/isSigner, account types in place', () => {
  const legacy = normalizeIdl({
    version: '0.1.0', name: 'counter',
    instructions: [
      { name: 'initialize', accounts: [{ name: 'counter', isMut: true, isSigner: false }, { name: 'user', isMut: true, isSigner: true }, { name: 'systemProgram', isMut: false, isSigner: false }], args: [{ name: 'start', type: 'u64' }] },
      { name: 'setLabel', accounts: [{ name: 'counter', isMut: true, isSigner: false }], args: [{ name: 'label', type: 'string' }, { name: 'owner', type: 'publicKey' }] },
    ],
    accounts: [{ name: 'Counter', type: { kind: 'struct', fields: [{ name: 'count', type: 'u64' }, { name: 'authority', type: 'publicKey' }, { name: 'label', type: { option: 'string' } }] } }],
    errors: [{ code: 6000, name: 'Overflow', msg: 'Too big' }],
  });
  assert.equal(legacy.format, 'anchor-legacy');
  assert.equal(toHex(legacy.instructions[0].discriminator), 'afaf6d1f0d989bed'); // sha256("global:initialize")[..8], as Anchor computes it
  assert.equal(snake('setLabel'), 'set_label');
  assert.equal(snake('createV1'), 'create_v1');
  assert.equal(toHex(legacy.instructions[1].discriminator), toHex(sha256(utf8('global:set_label')).slice(0, 8)));
  const ix = buildIxFromIdl(legacy, legacy.instructions[0], { programId: PROGRAMS.memo, args: { start: '42' }, accounts: autoAccounts(legacy, legacy.instructions[0], { programId: PROGRAMS.memo, me: ME, given: { counter: OTHER } }) });
  assert.deepEqual(ix.keys.map((k) => k.pubkey), [OTHER, ME, PROGRAMS.system], 'the signer is the wallet, the system program known by name');
  assert.equal(toHex(ix.data), 'afaf6d1f0d989bed' + '2a00000000000000');
  // an account of the program, decoded by its discriminator
  const data = concat([sha256(utf8('account:Counter')).slice(0, 8), u64(7n), addressBytes(ME), Uint8Array.of(1), u32(2), utf8('hi')]);
  assert.deepEqual(decodeAccount(legacy, data), { type: 'Counter', value: { count: 7n, authority: ME, label: 'hi' } });
  assert.equal(decodeAccount(legacy, new Uint8Array(20)), null);
  assert.equal(idlError(legacy, 'Program failed: custom program error: 0x1770').name, 'Overflow');
  assert.equal(idlError(legacy, '{"InstructionError":[0,{"Custom":6000}]}').msg, 'Too big');
});

test('Anchor 0.30+: discriminators in the IDL, PDAs from constants, arguments and accounts', () => {
  const idl = normalizeIdl({
    address: PROGRAMS.memo, metadata: { name: 'vault', version: '0.1.0', spec: '0.1.0' },
    instructions: [{
      name: 'deposit', discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
      accounts: [
        { name: 'user', writable: true, signer: true },
        { name: 'vault', writable: true, pda: { seeds: [{ kind: 'const', value: Array.from(utf8('vault')) }, { kind: 'account', path: 'user' }, { kind: 'arg', path: 'id' }] } },
        { name: 'config', optional: true },
        { name: 'system_program', address: PROGRAMS.system },
      ],
      args: [{ name: 'id', type: 'u16' }, { name: 'amounts', type: { vec: 'u64' } }, { name: 'kind', type: { defined: { name: 'Kind' } } }, { name: 'tag', type: { array: ['u8', 4] } }],
    }],
    accounts: [{ name: 'Vault', discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }],
    types: [
      { name: 'Vault', type: { kind: 'struct', fields: [{ name: 'owner', type: 'pubkey' }, { name: 'total', type: 'u128' }] } },
      { name: 'Kind', type: { kind: 'enum', variants: [{ name: 'Plain' }, { name: 'Locked', fields: [{ name: 'until', type: 'i64' }] }] } },
    ],
  });
  assert.equal(idl.format, 'anchor');
  const ix = idl.instructions[0];
  const args = { id: '3', amounts: ['1', '2'], kind: { __variant: 'Locked', until: '-1' }, tag: '0xdeadbeef' };
  const acc = autoAccounts(idl, ix, { programId: PROGRAMS.memo, me: ME, args });
  const expected = findProgramAddress([utf8('vault'), addressBytes(ME), Uint8Array.of(3, 0)], PROGRAMS.memo)[0];
  assert.equal(acc.vault, expected, 'the PDA from its seeds');
  assert.equal(acc.system_program, PROGRAMS.system);
  assert.equal(acc.config, undefined);
  const built = buildIxFromIdl(idl, ix, { programId: PROGRAMS.memo, args, accounts: acc });
  assert.equal(built.keys[2].pubkey, PROGRAMS.memo, 'optional, left empty: the program id');
  assert.equal(toHex(built.data), '0102030405060708' + '0300' + '02000000' + '0100000000000000' + '0200000000000000' + '01' + 'ffffffffffffffff' + 'deadbeef');
  assert.throws(() => buildIxFromIdl(idl, ix, { programId: PROGRAMS.memo, args: { ...args, id: '70000' }, accounts: acc }), /id: u16 out of range/);
  assert.throws(() => buildIxFromIdl(idl, ix, { programId: PROGRAMS.memo, args, accounts: { ...acc, user: '' } }), /user: address missing/);
  const vault = concat([Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]), addressBytes(OTHER), new Uint8Array(16).fill(255)]);
  assert.deepEqual(decodeAccount(idl, vault), { type: 'Vault', value: { owner: OTHER, total: (1n << 128n) - 1n } });
});

test('Borsh: every kind of value round trips', () => {
  const types = new Map([['P', { kind: 'struct', fields: [{ name: 'x', type: 'i32' }, { name: 'tags', type: { vec: 'string' } }] }], ['E', { kind: 'enum', variants: [{ name: 'A' }, { name: 'B', tuple: ['u8', 'bool'] }] }]]);
  const cases = [
    ['u8', 255n], ['i8', -128n], ['u64', 18446744073709551615n], ['i128', -(1n << 127n)], ['bool', true], ['string', 'ciao ✓'], ['pubkey', ME],
    [{ option: 'u16' }, null], [{ option: 'u16' }, 7n], [{ vec: 'pubkey' }, [ME, OTHER]], [{ array: ['u32', 2] }, [1n, 2n]],
    [{ defined: 'P' }, { x: -5n, tags: ['a', 'b'] }], [{ defined: 'E' }, { __variant: 'B', _0: 3n, _1: true }], [{ defined: 'E' }, { __variant: 'A' }],
    ['f64', 1.5],
  ];
  for (const [ty, v] of cases) {
    const b = encode(ty, v, types);
    const [back, end] = decode(ty, b, 0, types);
    assert.equal(end, b.length, JSON.stringify(ty));
    assert.deepEqual(back, v, JSON.stringify(ty));
  }
  assert.deepEqual(decode('bytes', encode('bytes', '0x0102'), 0)[0], Uint8Array.of(1, 2));
  assert.deepEqual(toBytes('[1, 2]'), Uint8Array.of(1, 2));
  assert.throws(() => decode('u64', new Uint8Array(4)), /too short/);
  assert.throws(() => encode('u8', '256'), /out of range/);
});

test('upgradeable loader: accounts read, program data address, instructions', () => {
  const buffer = concat([u32(1), Uint8Array.of(1), addressBytes(ME), new Uint8Array(100)]);
  assert.deepEqual(loaderState(buffer), { type: 'buffer', authority: ME, size: 100 });
  assert.equal(BUFFER_META, 37);
  const pd = concat([u32(3), u64(12345n), Uint8Array.of(0), new Uint8Array(32), new Uint8Array(10)]);
  assert.deepEqual(loaderState(pd), { type: 'programdata', slot: 12345, authority: null, size: 10 });
  const prog = concat([u32(2), addressBytes(OTHER)]);
  assert.deepEqual(loaderState(prog), { type: 'program', programData: OTHER });
  assert.equal(programDataAddress(OTHER), findProgramAddress([addressBytes(OTHER)], PROGRAMS.loaderV3)[0]);
  const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, ...new Uint8Array(2000)]);
  assert.ok(isElf(elf));
  assert.ok(!isElf(new Uint8Array(100)));
  const chunks = chunksOf(elf, 900);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.reduce((n, c) => n + c.bytes.length, 0), elf.length);
  assert.equal(chunks[2].offset, 1800);
  const w = loader.write(ME, OTHER, 1800, chunks[2].bytes);
  assert.equal(toHex(w.data.slice(0, 16)), '01000000' + '08070000' + toHex(u64(BigInt(chunks[2].bytes.length))));
  const d = loader.deploy({ payer: ME, program: NEW, buffer: OTHER, authority: ME, maxLen: 2005 });
  assert.equal(d.keys[1].pubkey, programDataAddress(NEW));
  assert.equal(toHex(d.data), '02000000' + toHex(u64(2005n)));
  assert.equal(loader.setAuthority({ account: OTHER, current: ME, next: null }).keys.length, 2, 'no new authority: immutable');
});

test('Token-2022 metadata: sizes, and the extension read back from a mint account', () => {
  const texts = { name: 'Chakra Test', symbol: 'CKT', uri: 'https://example.com/ckt.json' };
  assert.equal(metadataSpace(texts), 4 + 64 + 4 + 11 + 4 + 3 + 4 + 28 + 4);
  assert.equal(mintSpace(texts).space, 234);
  // a mint account as Token-2022 lays it out: base (82) padded to 165, account type, then the extensions
  const md = concat([addressBytes(ME), addressBytes(NEW), u32(11), utf8(texts.name), u32(3), utf8(texts.symbol), u32(28), utf8(texts.uri), u32(0)]);
  const tlv = (type, value) => concat([Uint8Array.of(type & 0xff, type >> 8), Uint8Array.of(value.length & 0xff, value.length >> 8), value]);
  const data = concat([new Uint8Array(165), Uint8Array.of(1), tlv(18, concat([addressBytes(ME), addressBytes(NEW)])), tlv(19, md)]);
  assert.deepEqual(readMintMetadata(data), { updateAuthority: ME, name: 'Chakra Test', symbol: 'CKT', uri: texts.uri, extra: [], space: md.length });
  assert.equal(readMintMetadata(new Uint8Array(82)), null);
  const ixs = createTokenIxs({ payer: ME, mint: NEW, decimals: 6, supply: 10n, ...texts, fixedSupply: true, freezable: false, rent: 1n });
  assert.deepEqual(ixs.map((x) => x.programId), [PROGRAMS.system, PROGRAMS.token2022, PROGRAMS.token2022, PROGRAMS.token2022, PROGRAMS.ata, PROGRAMS.token2022, PROGRAMS.token2022]);
  assert.equal(toHex(ixs[3].data.slice(0, 8)), toHex(sha256(utf8('spl_token_metadata_interface:initialize_account')).slice(0, 8)));
});

test('Metaplex Core accounts read back; fake tokens flagged', () => {
  const asset = concat([Uint8Array.of(1), addressBytes(ME), Uint8Array.of(2), addressBytes(OTHER), u32(3), utf8('Cat'), u32(1), utf8('u')]);
  assert.deepEqual(readCore(asset), { kind: 'asset', owner: ME, updateAuthority: null, collection: OTHER, name: 'Cat', uri: 'u' });
  const coll = concat([Uint8Array.of(5), addressBytes(ME), u32(4), utf8('Cats'), u32(1), utf8('u'), u32(3), u32(3)]);
  assert.deepEqual(readCore(coll), { kind: 'collection', updateAuthority: ME, name: 'Cats', uri: 'u', minted: 3, size: 3 });
  assert.equal(readCore(new Uint8Array(3)), null);
  assert.ok(spamSplToken(NEW, { symbol: 'USDC', name: 'USD Coin', known: false }), 'USDC at another mint');
  assert.ok(!spamSplToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', { symbol: 'USDC', name: 'USD Coin', known: true }));
  assert.ok(spamSplToken(NEW, { symbol: 'GIFT', name: 'Claim at free-sol.xyz', known: false }));
  assert.ok(spamSplToken(NEW, { symbol: 'X', name: 'x', known: false, spam: true }));
  assert.ok(!spamSplToken(NEW, { symbol: 'CKT', name: 'Chakra Test', known: false }));
});

test('token checks: Jupiter\'s copies are spam, probable junk is told apart from real tokens', async () => {
  const { junkSplToken } = await import('../src/shared/solana/tokens.js');
  assert.ok(spamSplToken(NEW, { symbol: 'NYAN', name: 'Nyan Cat', known: false, duplicate: true }), 'a copy of a known token');
  // not verified, low organic score, almost no liquidity: junk; with a real market, or verified: not
  assert.ok(junkSplToken({ known: false, listed: true, organic: 'low', liquidity: 12 }));
  assert.ok(!junkSplToken({ known: false, listed: true, organic: 'low', liquidity: 25000 }));
  assert.ok(!junkSplToken({ known: false, listed: true, organic: 'medium', liquidity: 10 }));
  assert.ok(!junkSplToken({ known: true, listed: true, organic: 'low', liquidity: 0 }));
  // unknown to Jupiter: junk only without any price
  assert.ok(junkSplToken(null, { unlisted: true, price: null }));
  assert.ok(!junkSplToken(null, { unlisted: true, price: 0.5 }));
  assert.ok(!junkSplToken(null, { unlisted: false, price: null }), 'not asked (Jupiter unreachable): no verdict');
});
