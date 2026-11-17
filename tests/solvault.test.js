// Solana in the vault and the wallet's Solana logic that needs no network: keys of each kind of account, Solana-only
// accounts (Phantom's key format, kept case-sensitive), signing, backup round trip; Solana Pay links; the history's
// reading of real-shaped transactions; DAS NFTs.
import { resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HDNodeWallet } from 'ethers';
import * as v from '../src/background/vault.js';
import { solanaHandlers } from '../src/background/solana.js';
import '../src/background/families.js';
import { hdSeed, keyOfSeed, secretText, fromBase64, toBase64, verifyBytes } from '../src/shared/solana/core.js';
import { buildTransaction, parseTransaction, system } from '../src/shared/solana/tx.js';
import { SOL_CHAINS } from '../src/shared/solana/api.js';
import { classifySol } from '../src/shared/solana/history.js';
import { parseSolanaPay, rawToDecimal, decimalToRaw, solanaDriver, dasItems, solPoisonKit } from '../src/ui/solana/driver.js';
import { snsName, domainKey } from '../src/shared/solana/sns.js';
import * as b58 from '../src/shared/solana/base58.js';

const A = 'test test test test test test test test test test test junk';
const PK = '0x' + '22'.repeat(32);
const SOL = SOL_CHAINS[-501];

test('Solana accounts in the vault', { timeout: 300000 }, async () => {
  await reset();
  await v.createVault('walletpw1', A, 'Main');
  await v.unlock('walletpw1');
  const hd0 = HDNodeWallet.fromPhrase(A, undefined, "m/44'/60'/0'/0/0").address;
  const hd1 = (await v.addHdAccount('Two')).address;
  const imp = (await v.importPrivateKey(PK, 'Imp')).address;

  // the UI gets addresses only, for the phrase's accounts (m/44'/501'/i'/0', as Phantom)
  const map = await solanaHandlers.solanaAccounts();
  assert.deepEqual(Object.keys(map).sort(), [hd0, hd1].sort());
  assert.equal(map[hd1].address, keyOfSeed(hdSeed(A, 1)).address);
  assert.ok(!JSON.stringify(map).includes('secret'));
  assert.equal(await v.familyKeySource('solana', imp), null, 'an Ethereum key has no Solana key');

  // signing: the account's slot, after the password
  const me = map[hd0].address;
  const tx = buildTransaction({ payer: me, recentBlockhash: '11111111111111111111111111111111', instructions: [system.transfer(me, map[hd1].address, 1000n)] });
  await assert.rejects(() => solanaHandlers.solanaSign({ from: hd0, txs: [toBase64(tx)], password: 'wrong' }));
  const r = await solanaHandlers.solanaSign({ from: hd0, txs: [toBase64(tx)], password: 'walletpw1' });
  const signed = parseTransaction(fromBase64(r.txs[0]));
  assert.ok(verifyBytes(signed.signatures[0], signed.message, me));
  assert.equal(r.signatures[0], b58.encode(signed.signatures[0]));
  await assert.rejects(() => solanaHandlers.solanaSign({ from: hd1, txs: [toBase64(tx)], password: 'walletpw1' }), /./, 'not its transaction');

  // import from another app: the phrase on its paths, or a Phantom key
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const look = await solanaHandlers.solanaInspectKey({ phrase });
  assert.equal(look.found.length, 11); // 5 + 5 + solana-keygen
  assert.equal(look.found[0].path, "m/44'/501'/0'/0'");
  const trust = look.found.find((x) => x.scheme === 'bip44' && x.index === 0);
  const acc = await solanaHandlers.solanaImport({ phrase, scheme: 'bip44', index: 0, name: 'Trust' });
  assert.equal(acc.type, 'solana');
  assert.equal(acc.address, trust.address, 'case kept');
  assert.equal(await v.exportPrivateKey(acc.address, 'walletpw1'), secretText(hdSeed(phrase, 0, 'bip44')), 'exported as Phantom imports it');
  await assert.rejects(() => solanaHandlers.solanaImport({ phrase, scheme: 'bip44', index: 0 }), /already|già/);
  const key = secretText(new Uint8Array(32).fill(5));
  const k2 = await solanaHandlers.solanaImport({ secret: key, name: 'Phantom' });
  assert.equal(k2.address, keyOfSeed(new Uint8Array(32).fill(5)).address);
  assert.equal((await solanaHandlers.solanaAccounts())[k2.address].address, k2.address);
  await assert.rejects(() => v.getSigner(k2.address), /./, 'no Ethereum signer for a Solana account');

  // backup -> restore keeps the Solana accounts
  const backup = await v.exportBackup('walletpw1', 'backuppw1');
  await reset();
  await v.restoreVault('newpw123', backup, 'backuppw1');
  await v.unlock('newpw123');
  const st = await v.view();
  const sols = st.accounts.filter((a) => a.type === 'solana');
  assert.deepEqual(sols.map((a) => [a.address, a.name]).sort(), [[acc.address, 'Trust'], [k2.address, 'Phantom']].sort());
  assert.equal((await solanaHandlers.solanaAccounts())[acc.address].address, acc.address);
});

test('Solana Pay links: amounts in units, tokens by mint, references', () => {
  const me = keyOfSeed(new Uint8Array(32).fill(7)).address, mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.equal(rawToDecimal(1500000000n, 9), '1.5');
  assert.equal(rawToDecimal(1n, 9), '0.000000001');
  assert.equal(rawToDecimal(2000000n, 6), '2');
  assert.equal(decimalToRaw('1.5', 9), 1500000000n);
  assert.equal(decimalToRaw('0.0000000001', 9), null, 'more decimals than the token has');
  const link = solanaDriver.paymentLink(SOL, { address: me, token: { address: mint, decimals: 6 }, amountRaw: '2500000', ask: true });
  assert.equal(link, `solana:${me}?amount=2.5&spl-token=${mint}`);
  const q = solanaDriver.parseQr(SOL, link);
  assert.deepEqual([q.address, q.token, q.amountRaw, q.amountText], [me, mint, null, '2.5']);
  const n = solanaDriver.parseQr(SOL, `solana:${me}?amount=0.25&memo=order%2042&reference=${mint}`);
  assert.deepEqual([n.amountRaw, n.memo], [250000000n, 'order 42']);
  assert.deepEqual(parseSolanaPay(`solana:${me}?reference=${mint}`).references, [mint]);
  assert.equal(solanaDriver.paymentLink(SOL, { address: me, token: { native: true }, amountRaw: null, ask: false }), me);
  assert.equal(solanaDriver.parseQr(SOL, 'solana:https://merchant.example/pay'), null, 'transaction requests are not transfers');
  assert.equal(solanaDriver.parseQr(SOL, me).address, me);
});

test('.sol names and the poisoning kit', () => {
  assert.equal(snsName('Bonfida.SOL'), 'bonfida');
  assert.equal(snsName('a.b.sol'), null);
  assert.equal(snsName('bonfida'), null);
  assert.equal(domainKey('bonfida'), 'Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb'); // as the name service derives it (read on mainnet)
  const kit = solPoisonKit();
  const a = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.equal(kit.canonical(` ${a} `), a);
  assert.ok(kit.lookalike(a, 'EPjFzzzzAufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
  assert.ok(!kit.lookalike(a, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1V'), 'the same start, a different end');
  assert.ok(!kit.lookalike(a, a));
  assert.equal(kit.canonical('0x1234'), null);
});

// ---------------------------------------------------------------- history
const ME = keyOfSeed(new Uint8Array(32).fill(7)).address, OTHER = keyOfSeed(new Uint8Array(32).fill(8)).address;
const SYS = '11111111111111111111111111111111', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MY_USDC = 'FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B', HIS_USDC = '3hNzYSQs2ziFhnXYzxNqQ1HGnW8pQs9Gf4KfoRErfw9i';
const metas = new Map([[USDC, { symbol: 'USDC', decimals: 6, icon: 'u.png', known: true }], [BONK, { symbol: 'Bonk', decimals: 5, icon: '', known: false, spam: true }]]);
const sig = { signature: 'sig1', blockTime: 1794557759, err: null };
const tb = (accountIndex, mint, owner, amount, decimals = 6) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals } });
const txOf = ({ keys, pre, post, preT = [], postT = [], ixs = [], fee = 5000, inner = [] }) => ({
  meta: { err: null, fee, preBalances: pre, postBalances: post, preTokenBalances: preT, postTokenBalances: postT, innerInstructions: inner },
  transaction: { message: { accountKeys: keys, instructions: ixs } },
});
const key = (pubkey, signer = false, writable = true) => ({ pubkey, signer, writable });

test('history: a USDC send that opened the recipient\'s account (rent counted with the fee)', () => {
  const tx = txOf({
    keys: [key(ME, true), key(MY_USDC), key(HIS_USDC), key(OTHER, false, false), key(USDC, false, false)],
    pre: [100_000_000, 2_039_280, 0, 0, 1], post: [100_000_000 - 5000 - 2_039_280, 2_039_280, 2_039_280, 0, 1],
    preT: [tb(1, USDC, ME, 5_000_000)], postT: [tb(1, USDC, ME, 3_000_000), tb(2, USDC, OTHER, 2_000_000)],
    ixs: [
      { program: 'spl-associated-token-account', programId: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', parsed: { type: 'createIdempotent', info: {} } },
      { program: 'spl-token', programId: TOKEN, parsed: { type: 'transferChecked', info: { source: MY_USDC, destination: HIS_USDC, authority: ME, mint: USDC, tokenAmount: { amount: '2000000' } } } },
      { program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: 'invoice 7' },
    ],
  });
  const it = classifySol(SOL, ME, sig, tx, metas);
  assert.equal(it.kind, 'send');
  assert.deepEqual(it.transfers.map((x) => [x.dir, x.symbol, x.amount, x.counterparty]), [['out', 'USDC', '2000000', OTHER]]);
  assert.equal(it.fee, String(5000 + 2_039_280));
  assert.equal(it.to, OTHER);
  assert.equal(it.comment, 'invoice 7');
  assert.ok(it.sentByMe && !it.spam);
});

test('history: a swap SOL -> USDC through Jupiter, a SOL payment received, dust and spam', () => {
  const swap = classifySol(SOL, ME, sig, txOf({
    keys: [key(ME, true), key(MY_USDC), key('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', false, false)],
    pre: [2_000_000_000, 2_039_280, 1], post: [1_000_000_000 - 5000, 2_039_280, 1],
    preT: [tb(1, USDC, ME, 0)], postT: [tb(1, USDC, ME, 150_000_000)],
    ixs: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: '' }],
    inner: [{ index: 0, instructions: [{ program: 'system', programId: SYS, parsed: { type: 'transfer', info: { source: ME, destination: 'wsolacct', lamports: 1e9 } } }] }],
  }), metas);
  assert.equal(swap.kind, 'swap');
  assert.deepEqual(swap.transfers.map((x) => [x.dir, x.symbol, x.amount]), [['out', 'SOL', '1000000000'], ['in', 'USDC', '150000000']]);
  assert.equal(swap.via, 'Jupiter');
  assert.equal(swap.fee, '5000');

  const received = classifySol(SOL, ME, sig, txOf({
    keys: [key(OTHER, true), key(ME), key(SYS, false, false)], pre: [5e9, 1e9, 1], post: [4e9 - 5000, 2e9, 1],
    ixs: [{ program: 'system', programId: SYS, parsed: { type: 'transfer', info: { source: OTHER, destination: ME, lamports: 1e9 } } }],
  }), metas);
  assert.deepEqual([received.kind, received.from, received.fee, received.spam, received.sentByMe], ['receive', OTHER, null, false, false]);

  const dust = classifySol(SOL, ME, sig, txOf({
    keys: [key(OTHER, true), key(ME), key(SYS, false, false)], pre: [5e9, 1e9, 1], post: [5e9 - 5001, 1e9 + 1, 1],
    ixs: [{ program: 'system', programId: SYS, parsed: { type: 'transfer', info: { source: OTHER, destination: ME, lamports: 1 } } }],
  }), metas);
  assert.ok(dust.spam, 'a lamport from a stranger: address poisoning');

  const airdrop = classifySol(SOL, ME, sig, txOf({
    keys: [key(OTHER, true), key('myBonkAcct'), key(ME, false, false)], pre: [5e9, 0, 1e9], post: [5e9 - 2_044_280, 2_039_280, 1e9],
    postT: [tb(1, BONK, ME, 1_000_000, 5)], ixs: [],
  }), metas);
  assert.deepEqual([airdrop.kind, airdrop.spam], ['receive', true]);

  const mention = classifySol(SOL, ME, sig, txOf({ keys: [key(OTHER, true), key(ME, false, false)], pre: [5e9, 1e9], post: [5e9 - 5000, 1e9] }), metas);
  assert.deepEqual([mention.kind, mention.spam], ['contract', true]);
});

test('NFTs from DAS: images, collections, compressed spam', () => {
  const items = dasItems([
    { id: 'A1', interface: 'MplCoreAsset', content: { metadata: { name: 'Cat #1', attributes: [{ trait_type: 'Eyes', value: 'Blue' }] }, links: { image: 'https://x/cat.png' } }, grouping: [{ group_key: 'collection', group_value: 'COLL', collection_metadata: { name: 'Cats' } }] },
    { id: 'A2', interface: 'V1_NFT', compression: { compressed: true }, content: { metadata: { name: 'Claim your reward at free-sol.xyz' }, files: [{ uri: 'https://x/a.png', mime: 'image/png' }] }, grouping: [] },
    { id: 'A3', interface: 'FungibleToken', content: { metadata: { name: 'USDC' } } },
    { id: 'A4', interface: 'V1_NFT', burnt: true, content: { metadata: { name: 'gone' } } },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].name, items[0].collection, items[0].contract, items[0].image, items[0].standard, items[0].spam], ['Cat #1', 'Cats', 'COLL', 'https://x/cat.png', 'Metaplex Core', false]);
  assert.ok(items[1].spam);
});

test('history: a small sale through an aggregator keeps its SOL (not taken for rent)', () => {
  const sale = classifySol(SOL, ME, sig, txOf({
    keys: [key(ME, true), key(MY_USDC), key('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', false, false)],
    pre: [100_000_000, 2_039_280, 1], post: [100_000_000 - 5000 + 1_500_000, 2_039_280, 1],
    preT: [tb(1, USDC, ME, 1_000_000)], postT: [tb(1, USDC, ME, 0)],
    ixs: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: '' }],
  }), metas);
  assert.equal(sale.kind, 'swap');
  assert.deepEqual(sale.transfers.map((x) => [x.dir, x.symbol, x.amount]), [['in', 'SOL', '1500000'], ['out', 'USDC', '1000000']]);
});

test('Solana vanity: words to base58 patterns, matching in any case, honest difficulty', async () => {
  const { toSolPattern, solMatches, solDifficulty, solProbability } = await import('../src/shared/solana/vanity.js');
  assert.equal(toSolPattern('Cafè').pattern, 'Cafe');
  const m = toSolPattern('l0I x');
  assert.equal(m.pattern, 'Loix');
  assert.deepEqual(m.chars.map((c) => c.kind), ['sub', 'sub', 'sub', 'same']);
  assert.equal(toSolPattern('abcdefgh').pattern, 'abcde', 'at most 5 characters');
  assert.ok(solMatches('CAFExyz9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9', 'cafe', 'start', true));
  assert.ok(!solMatches('CAFExyz9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9', 'cafe', 'start', false));
  assert.ok(solMatches('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtcafe', 'CaFe', 'end', true));
  // the end is uniform: any case halves the work for each letter with two cases
  assert.equal(Math.round(solDifficulty('ab', 'end', false)), 58 * 58);
  assert.equal(Math.round(solDifficulty('ab', 'end', true)), 29 * 29);
  assert.equal(Math.round(solDifficulty('9', 'end', true)), 58, 'a digit has one form');
  // the start: 2..J is common (44-character addresses), a later letter only in the rare 43-character ones
  assert.ok(solDifficulty('C', 'start', false) < 20);
  assert.ok(solDifficulty('z', 'start', false) > 900);
  assert.ok(solProbability(0, 100) === 0 && solProbability(1e9, 100) > 0.999);
  // a real key: its address matches its own start, in any case
  const k = keyOfSeed(new Uint8Array(32).fill(11));
  assert.ok(solMatches(k.address, k.address.slice(0, 3).toLowerCase(), 'start', true));
});

test('NFTs without an indexer: a Metaplex metadata account read to its verified collection', async () => {
  const { metaplexFull } = await import('../src/shared/solana/nfts.js');
  const { concat, utf8, addressBytes } = await import('../src/shared/solana/core.js');
  const { u32, u16 } = await import('../src/shared/solana/tx.js');
  const pad = (s, n) => { const b = new Uint8Array(n); b.set(utf8(s)); return concat([u32(n), b]); };
  const coll = keyOfSeed(new Uint8Array(32).fill(12)).address;
  const data = concat([
    Uint8Array.of(4), new Uint8Array(64), pad('Cat #7', 32), pad('CAT', 10), pad('https://x/7.json', 200), u16(500),
    Uint8Array.of(1), u32(1), new Uint8Array(32), Uint8Array.of(1, 100), // one creator
    Uint8Array.of(1, 1), Uint8Array.of(1, 254), Uint8Array.of(1, 0), // primary sale, mutable, edition nonce, token standard
    Uint8Array.of(1, 1), addressBytes(coll), // collection, verified
  ]);
  assert.deepEqual(metaplexFull(data), { name: 'Cat #7', symbol: 'CAT', uri: 'https://x/7.json', collection: { verified: true, key: coll } });
});
