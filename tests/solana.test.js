// Solana: base58, keys (SLIP-0010 vectors, other apps' formats), program-derived addresses and the transaction wire
// format, checked against real mainnet transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import * as b58 from '../src/shared/solana/base58.js';
import {
  isAddress, isOnCurve, addressBytes, findProgramAddress, createWithSeed, hdSeed, keyOfSeed, seedFromSecret, secretText, fromBase64, toBase64, toHex, verifyBytes,
  fromHex, SCHEMES,
} from '../src/shared/solana/core.js';
import { slip10Ed25519, HARDENED } from '../src/shared/hd25519.js';
import {
  PROGRAMS, compileMessage, parseMessage, parseTransaction, serializeTransaction, messageAccounts, messageInstructions, signTransaction, buildTransaction,
  system, memo, computeBudget, token, ataAddress, createAtaIdempotent, compactU16, transactionId,
} from '../src/shared/solana/tx.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('base58: round trips, leading zeros, bad characters', () => {
  assert.deepEqual(b58.decode(PROGRAMS.system), new Uint8Array(32)); // 32 zero bytes = 32 '1's
  assert.equal(b58.encode(new Uint8Array(32)), PROGRAMS.system);
  assert.equal(b58.encode(Uint8Array.of(0, 0, 1)), '112');
  for (let i = 0; i < 50; i++) {
    const b = nacl.randomBytes(1 + (i % 64));
    if (i % 5 === 0) b[0] = 0;
    assert.deepEqual(b58.decode(b58.encode(b)), b);
  }
  assert.equal(b58.encode(fromHex('00000000000000000000')), '1111111111');
  assert.throws(() => b58.decode('0OIl'));
  assert.equal(b58.encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
});

test('addresses: valid, invalid, on and off the curve', () => {
  assert.ok(isAddress(USDC));
  assert.ok(isAddress(PROGRAMS.token));
  assert.ok(!isAddress('0x5e83857a7719B6aE2DE17af827140C04323a231C'));
  assert.ok(!isAddress(b58.encode(new Uint8Array(31).fill(9)))); // 31 bytes
  assert.ok(!isAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v0')); // not base58
  assert.ok(!isAddress(''));
  assert.ok(isOnCurve(keyOfSeed(new Uint8Array(32).fill(7)).address));
});

test('SLIP-0010 Ed25519: the specification test vector 1', () => {
  const seed = fromHex('000102030405060708090a0b0c0d0e0f');
  const H = HARDENED;
  assert.equal(toHex(slip10Ed25519(seed, [])), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(toHex(slip10Ed25519(seed, [0 + H])), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  assert.equal(toHex(slip10Ed25519(seed, [0 + H, 1 + H])), 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2');
  assert.equal(toHex(slip10Ed25519(seed, [0 + H, 1 + H, 2 + H])), '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9');
});

test('keys: the phrase on each scheme, the public key as NaCl computes it', () => {
  const a0 = keyOfSeed(hdSeed(PHRASE, 0)), a1 = keyOfSeed(hdSeed(PHRASE, 1));
  assert.notEqual(a0.address, a1.address);
  assert.deepEqual(a0.publicKey, nacl.sign.keyPair.fromSeed(a0.seed).publicKey);
  // the three schemes give three different accounts
  const all = Object.keys(SCHEMES).map((s) => keyOfSeed(hdSeed(PHRASE, 0, s)).address);
  assert.equal(new Set(all).size, 3);
  // solana-keygen: the first 32 bytes of the BIP-39 seed
  assert.equal(toHex(hdSeed(PHRASE, 0, 'cli')), '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1');
});

test('private keys: Phantom base58, solana-keygen JSON, hex; a mismatched public half is refused', () => {
  const seed = hdSeed(PHRASE, 0);
  const full = nacl.sign.keyPair.fromSeed(seed).secretKey; // 64 bytes
  assert.deepEqual(seedFromSecret(secretText(seed)), seed);
  assert.equal(b58.decode(secretText(seed)).length, 64);
  assert.deepEqual(seedFromSecret(JSON.stringify(Array.from(full))), seed);
  assert.deepEqual(seedFromSecret(toHex(full)), seed);
  assert.deepEqual(seedFromSecret(toHex(seed)), seed);
  const bad = full.slice(); bad[40] ^= 1;
  assert.throws(() => seedFromSecret(b58.encode(bad)));
  assert.throws(() => seedFromSecret('not a key'));
  assert.throws(() => seedFromSecret('[1,2,3]'));
});

test('program-derived addresses: an associated token account of mainnet', () => {
  // 9WzD…AWWM's USDC account (one of its token accounts listed by getTokenAccountsByOwner on mainnet)
  assert.equal(ataAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', USDC), 'FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B');
  const [pda, bump] = findProgramAddress([new TextEncoder().encode('anchor')], PROGRAMS.memo);
  assert.ok(!isOnCurve(pda)); assert.ok(bump <= 255);
  assert.ok(isAddress(createWithSeed(PROGRAMS.memo, 'anchor:idl', PROGRAMS.memo)));
});

// two transactions of mainnet (getTransaction, encoding base64): a legacy SOL transfer with a memo, and a version 0
// swap with a lookup table
const LEGACY = 'AT9QH45bh23m9gs8uy6VaNqn38TckYhvTXjxkcfjF2cSMCV1AE85UQDGdnorD9AwkgUkYM2pWWh82lbN9SQh6wgBAAIEJ66mhK8NNsNbH6k982QGBJIJd5GwObDDpS9j9sPi+0Z+jAiHYL/eHd3PMsF/IJuCQu5SqvEx+s2I0OosbQsG8gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUpTWpkpIQZNJOhxYNo4fHw1td28kruB5B+oQEEFRI0gVJDMIES5TWbFE5QrvOUrWhrJgpbPGPc7uB4dgEI5uAICAgABDAIAAAAQJwAAAAAAAAMBAIoBU29sYW5hIEluZGV4OiBhbiBBUEkgZm9yIGhpc3RvcmljYWwgdG9rZW4gYmFsYW5jZXMgYXQgZXhhY3QgU29sYW5hIHNsb3RzLiBUcnkgaXQgb3IgZGlzY3VzcyBpbnZlc3RpbmcgVVNEIDE1LDAwMCs6IGh0dHBzOi8vc29sYW5haW5kZXgudG9w';
const V0 = 'AeRjzdFsKH+SWRbCHPuAeXnucyjH2L+0TQr1KN9yvJlS+J2a+p8+w+sNoyEBiIbHnUBWl7bGagJYYAqmkJ9F2QmAAQAHD6UV3VpINzU6HEe4trOcfS3ucy83yJFUH5NgbL5M9TApP5XRr5CTsWk1H6tguEdSPtKta65oxvfjNhH/JlNhtcRb5qc2YqU7G6603hRVunBJgucpkqCTRnIrsRXiDcZEbDwKPaQZHCViv1QlYSifV3wVtOEStKZxg7ilq3c4WGdFgBZuG0cO5JipzaoU3ASVdPR0FWbIXGcP77fwz+fGJB6uZfU58E9cZqVk/AagxbAVEqj2nS1I/SVnikZkVm3BMgnv6KKr4Bh1W+uqSosdEanxQ5PmA4u2RTkSLmElHk0EeFIcsXnOu4WJtVai1eyU0kmGgv35uyr1rWTkkcxBU9oDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAIyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8AqQ7AWoSMhI/wfGri2Pq+DkfBaHb9QwKWroJ+J073jJVTBHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E4+0P/on9df2SnTAmx8pWHneSwmrNt/J3VFLMhqns4zl6DA+ZYuJUGJdNF+ajfDo10eg2U0JRPP8+y9FDzYZfI+3BggACQMAAAAAAAAAAAkGAAEAEwoUAQEJBgACABUKCwEBDCEBDQABAhMVFAsNDg0WDwMQEQECExUSFgAUCxcYFgQFBg1Km2y5cGjSoUBkCAAAAAAAAAAAAJb042oIAAAAKwAAALtk+swxxK8UKKFoBgcAAACFv78jAAAAAFAAAAAAAAEAAABLAAAAABAnAAELAwIAAAEJCgIABwwCAAAAbGsAAAAAAAABG7I2WmNgYRHgKHBod41zL2vwNl4phJLZCH0L/rgQ1SAEGagYpwapCR8aq64=';

test('wire format: real legacy and version 0 transactions read back byte for byte, signatures check out', () => {
  for (const b64 of [LEGACY, V0]) {
    const bytes = fromBase64(b64);
    const tx = parseTransaction(bytes);
    assert.deepEqual(serializeTransaction(tx.signatures, tx.message), bytes);
    assert.ok(verifyBytes(tx.signatures[0], tx.message, tx.msg.keys[0]), 'the fee payer signed the message');
    assert.equal(toBase64(bytes), b64);
  }
  const legacy = parseTransaction(fromBase64(LEGACY)).msg;
  assert.equal(legacy.version, 'legacy');
  const ixs = messageInstructions(legacy);
  assert.equal(ixs[0].programId, PROGRAMS.system);
  assert.equal(new DataView(ixs[0].data.buffer, ixs[0].data.byteOffset).getUint32(0, true), 2, 'a transfer');
  assert.equal(new DataView(ixs[0].data.buffer, ixs[0].data.byteOffset).getBigUint64(4, true), 10000n);
  assert.equal(ixs[1].programId, PROGRAMS.memo);
  assert.match(new TextDecoder().decode(ixs[1].data), /Solana Index/);

  const v0 = parseTransaction(fromBase64(V0)).msg;
  assert.equal(v0.version, 0);
  assert.equal(v0.lookups.reduce((n, l) => n + l.writable.length, 0), 4);
  assert.equal(v0.lookups.reduce((n, l) => n + l.readonly.length, 0), 6);
  // with the tables' contents (meta.loadedAddresses gives them in this order), the loaded accounts fall in place
  const loadedW = ['BBNe6tSmvsKSc58CEHpRnH1PnkWhekTryKascaCUtDuJ', '6r39rdnVL97FQ6GgbKckX7cJ7fe9jMjZ6u2ke7XG84r8', '99HaCKdDUNRCyRFhfrvrDGmaW8tqkvW5QFdcnB1CYbiD', 'FcgSynTZLYhYjdjfLym2GaUu3M2EfCndGoL1iKAf1PmU'];
  const acc = messageAccounts(v0);
  assert.equal(acc.length, v0.keys.length + 4 + 6);
  assert.ok(acc.slice(v0.keys.length, v0.keys.length + 4).every((a) => a.writable && a.pubkey === null), 'tables not given: unknown, writable');
  const loaded = {};
  for (const l of v0.lookups) loaded[l.key] = [];
  let w = 0;
  for (const l of v0.lookups) for (const i of l.writable) loaded[l.key][i] = loadedW[w++];
  const acc2 = messageAccounts(v0, loaded);
  assert.deepEqual(acc2.slice(v0.keys.length, v0.keys.length + 4).map((a) => a.pubkey), loadedW);
});

test('compiling: a SOL transfer with a memo and a priority fee, then signed', () => {
  const me = keyOfSeed(hdSeed(PHRASE, 0)), other = keyOfSeed(hdSeed(PHRASE, 1)).address;
  const blockhash = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';
  const ixs = [computeBudget.unitLimit(800), computeBudget.unitPrice(10000), system.transfer(me.address, other, 5000n), memo('hello', me.address)];
  const message = compileMessage({ payer: me.address, instructions: ixs, recentBlockhash: blockhash });
  const m = parseMessage(message);
  assert.equal(m.version, 'legacy');
  assert.deepEqual(m.header, { signatures: 1, readonlySigned: 0, readonlyUnsigned: 3 }); // budget, system, memo programs
  assert.equal(m.keys[0], me.address);
  assert.equal(m.recentBlockhash, blockhash);
  const back = messageInstructions(m);
  assert.deepEqual(back.map((x) => x.programId), ixs.map((x) => x.programId));
  assert.deepEqual(back[2].keys, ixs[2].keys);
  assert.deepEqual(back[3].data, ixs[3].data);
  // signing fills the payer's slot
  const unsigned = buildTransaction({ payer: me.address, instructions: ixs, recentBlockhash: blockhash });
  const { bytes, signature } = signTransaction(unsigned, [me.seed]);
  const tx = parseTransaction(bytes);
  assert.ok(verifyBytes(tx.signatures[0], tx.message, me.address));
  assert.equal(transactionId(bytes), signature);
  assert.throws(() => signTransaction(unsigned, [hdSeed(PHRASE, 3)]), /not a signer/);
});

test('compiling: a token transfer that creates the recipient account, and a version 0 message with a table', () => {
  const me = keyOfSeed(hdSeed(PHRASE, 0)).address, to = keyOfSeed(hdSeed(PHRASE, 1)).address;
  const blockhash = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';
  const ixs = [
    createAtaIdempotent({ payer: me, owner: to, mint: USDC }),
    token.transferChecked({ source: ataAddress(me, USDC), mint: USDC, destination: ataAddress(to, USDC), owner: me, amount: 1_500_000n, decimals: 6 }),
  ];
  const m = parseMessage(compileMessage({ payer: me, instructions: ixs, recentBlockhash: blockhash }));
  const acc = messageAccounts(m);
  const role = (k) => acc.find((a) => a.pubkey === k);
  assert.ok(role(ataAddress(to, USDC)).writable && !role(ataAddress(to, USDC)).signer);
  assert.ok(!role(USDC).writable);
  assert.ok(!role(to).writable, 'the recipient wallet itself is only read');
  assert.equal(m.header.signatures, 1);
  // version 0: the mint and the token program come from a table
  const table = { key: '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn', addresses: [PROGRAMS.system, USDC, ataAddress(to, USDC)] };
  const v0 = parseMessage(compileMessage({ payer: me, instructions: ixs, recentBlockhash: blockhash, lookupTables: [table] }));
  assert.equal(v0.version, 0);
  // the system program is only passed as an account here (the ATA program calls it): it can come from the table too
  assert.deepEqual(v0.lookups, [{ key: table.key, writable: [2], readonly: [1, 0] }]);
  const loaded = { [table.key]: table.addresses };
  const back = messageInstructions(v0, loaded);
  // same accounts in the same places (their roles are merged over the whole message: the payer is writable everywhere)
  assert.deepEqual(back.map((x) => x.keys.map((k) => k.pubkey)), ixs.map((x) => x.keys.map((k) => k.pubkey)));
  assert.deepEqual(back.map((x) => x.programId), ixs.map((x) => x.programId));
});

test('compact-u16', () => {
  assert.deepEqual(compactU16(0), Uint8Array.of(0));
  assert.deepEqual(compactU16(127), Uint8Array.of(0x7f));
  assert.deepEqual(compactU16(128), Uint8Array.of(0x80, 0x01));
  assert.deepEqual(compactU16(16384), Uint8Array.of(0x80, 0x80, 0x01));
  assert.ok(addressBytes(USDC).length === 32);
});
