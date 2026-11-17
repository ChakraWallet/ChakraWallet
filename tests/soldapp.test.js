// Solana dapps (wallet side, src/background/solanaDapp.js): sessions per site, transactions and messages signed only
// through an approval (a stand-in that says yes or no), signatures checked with an independent Ed25519 (NaCl), Sign In
// With Solana's text; and the transaction checks of the approval screen (src/shared/solana/inspect.js).
import { resetStorage as reset } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import * as v from '../src/background/vault.js';
import { solanaDappFamily } from '../src/background/solanaDapp.js';
import { signInText } from '../src/shared/solana/siws.js';
import { hdSeed, keyOfSeed, toBase64, fromBase64, addressBytes, utf8 } from '../src/shared/solana/core.js';
import { buildTransaction, parseTransaction, compileMessage, system, token, PROGRAMS, ataAddress } from '../src/shared/solana/tx.js';
import { staticRisks, describeIx, readTokenAccount, looksLikeTransaction } from '../src/shared/solana/inspect.js';
import { messageInstructions } from '../src/shared/solana/tx.js';
import * as b58 from '../src/shared/solana/base58.js';
import '../src/background/families.js';

const PHRASE = 'test test test test test test test test test test test junk';
const O = 'https://app.example.org';
const HASH = '11111111111111111111111111111111';

test('Solana dapp sessions and signatures', { timeout: 300000 }, async () => {
  await reset();
  await v.createVault('walletpw1', PHRASE, 'Main');
  await v.unlock('walletpw1');
  const hd0 = (await v.view()).accounts[0].address;
  const me = keyOfSeed(hdSeed(PHRASE, 0)).address;
  const asked = [], events = [];
  let answer = 'yes';
  const family = solanaDappFamily({
    async requestApproval(origin, kind, params) {
      asked.push({ kind, params });
      if (answer === 'no') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      return family.approvals[kind].complete({ origin, kind, params }, { account: hd0 });
    },
    ensureUnlocked: async () => {},
    emitToOrigin: async (origin, event, data) => { events.push({ origin, event, data }); },
  });
  const call = (method, params, origin = O) => family.handle(origin, method, params);

  // refused before anything is asked
  await assert.rejects(() => call('solana_connect', {}, 'http://app.example.org'), /https/);
  await assert.rejects(() => call('solana_signMessage', { message: toBase64(utf8('hi')) }), /connect first/);
  assert.deepEqual(await call('solana_connect', { silent: true }), { accounts: [] }, 'a silent connect asks nothing');
  assert.equal(asked.length, 0);

  // declined, then connected
  answer = 'no';
  await assert.rejects(() => call('solana_connect', {}), /rejected/);
  answer = 'yes';
  assert.deepEqual(await call('solana_connect', {}), { accounts: [me] });
  assert.deepEqual(events.at(-1), { origin: O, event: 'solana', data: { accounts: [me] } });
  const n = asked.length;
  assert.deepEqual(await call('solana_connect', { silent: true }), { accounts: [me] }, 'reconnects silently');
  assert.deepEqual(await call('solana_connect', {}), { accounts: [me] });
  assert.equal(asked.length, n, 'no second approval for the same site');
  assert.deepEqual((await family.state(await v.view())).solSites[O].address, me);

  // a message: signed with the account's key (checked by NaCl)
  const msg = utf8('Hello from app.example.org');
  const r = await call('solana_signMessage', { message: toBase64(msg) });
  assert.ok(nacl.sign.detached.verify(msg, fromBase64(r.signature), addressBytes(me)));
  assert.equal(asked.at(-1).kind, 'solSignMessage');

  // a transaction: signed in the account's slot, only for the connected account
  const tx = buildTransaction({ payer: me, recentBlockhash: HASH, instructions: [system.transfer(me, keyOfSeed(new Uint8Array(32).fill(3)).address, 1000n)] });
  const s = await call('solana_signTransaction', { chain: 'solana:devnet', transactions: [toBase64(tx)] });
  const signed = parseTransaction(fromBase64(s.signed[0]));
  assert.ok(nacl.sign.detached.verify(signed.message, signed.signatures[0], addressBytes(me)));
  assert.equal(asked.at(-1).kind, 'solTx');
  const other = buildTransaction({ payer: keyOfSeed(new Uint8Array(32).fill(4)).address, recentBlockhash: HASH, instructions: [system.transfer(keyOfSeed(new Uint8Array(32).fill(4)).address, me, 1n)] });
  await assert.rejects(() => call('solana_signTransaction', { transactions: [toBase64(other)] }), /not for the connected account/);
  await assert.rejects(() => call('solana_signTransaction', { transactions: ['bm90IGEgdHg='] }), /Unreadable/);
  await assert.rejects(() => call('solana_signTransaction', { chain: 'solana:testnet', transactions: [toBase64(tx)] }), /Unsupported chain/);

  // sign in: the page's domain, the chosen account, the standard text
  await assert.rejects(() => call('solana_signIn', { input: { domain: 'evil.example' } }), /does not match/);
  const si = await call('solana_signIn', { input: { statement: 'Welcome', nonce: 'abc12345', uri: 'https://app.example.org' } });
  assert.equal(si.address, me);
  const text = new TextDecoder().decode(fromBase64(si.signedMessage));
  assert.equal(text, `app.example.org wants you to sign in with your Solana account:\n${me}\n\nWelcome\n\nURI: https://app.example.org\nNonce: abc12345`);
  assert.ok(nacl.sign.detached.verify(fromBase64(si.signedMessage), fromBase64(si.signature), addressBytes(me)));

  // the user disconnects the site: the page is told, the session is gone
  await family.disconnect(O);
  assert.deepEqual(events.at(-1).data, { accounts: [] });
  assert.deepEqual(await call('solana_accounts', {}), { accounts: [] });
});

test('Sign In With Solana: optional lines only when given, resources listed', () => {
  assert.equal(signInText({ domain: 'a.io', address: 'ADDR' }), 'a.io wants you to sign in with your Solana account:\nADDR');
  assert.equal(signInText({ domain: 'a.io', address: 'ADDR', version: '1', chainId: 'mainnet', resources: ['https://a.io/x'] }),
    'a.io wants you to sign in with your Solana account:\nADDR\n\nVersion: 1\nChain ID: mainnet\nResources:\n- https://a.io/x');
});

test('approval checks: dangerous instructions, token accounts, disguised transactions', () => {
  const me = keyOfSeed(new Uint8Array(32).fill(7)).address, thief = keyOfSeed(new Uint8Array(32).fill(6)).address;
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const mine = ataAddress(me, USDC);
  const ix = (programId, keys, data) => ({ programId, keys: keys.map((pubkey, i) => ({ pubkey, isSigner: i === keys.length - 1, isWritable: i === 0 })), data });
  // assign of the wallet account, owner change of a token account, an allowance
  const assign = { programId: PROGRAMS.system, keys: [{ pubkey: me, isSigner: true, isWritable: true }], data: Uint8Array.from([1, 0, 0, 0, ...addressBytes(thief)]) };
  const setOwner = token.setAuthority({ account: mine, current: me, type: 2, next: thief });
  const approve = ix(PROGRAMS.token, [mine, thief, me], Uint8Array.from([4, 100, 0, 0, 0, 0, 0, 0, 0]));
  const risks = staticRisks([assign, setOwner, approve], me, new Set([mine]));
  assert.deepEqual(risks.map((r) => [r.level, r.key]), [['danger', 'assign'], ['danger', 'tokenOwner'], ['warn', 'delegate']]);
  assert.equal(risks[1].vars.to, thief);
  assert.deepEqual(staticRisks([system.transfer(me, thief, 5n)], me), [], 'a plain payment is not flagged here (the simulation shows it)');
  assert.equal(describeIx(system.transfer(me, thief, 5n)).fields.lamports, 5n);
  assert.equal(describeIx(approve).fields.delegate, thief);
  // a token account's first 165 bytes
  const data = new Uint8Array(165);
  data.set(addressBytes(USDC), 0); data.set(addressBytes(me), 32); new DataView(data.buffer).setBigUint64(64, 123n, true);
  assert.deepEqual(readTokenAccount(data), { mint: USDC, owner: me, amount: 123n });
  // a "message" that is a transaction's message
  const message = compileMessage({ payer: me, recentBlockhash: HASH, instructions: [system.transfer(me, thief, 5n)] });
  assert.ok(looksLikeTransaction(message));
  assert.ok(looksLikeTransaction(buildTransaction({ payer: me, recentBlockhash: HASH, instructions: [system.transfer(me, thief, 5n)] })));
  assert.ok(!looksLikeTransaction(utf8('Sign in to app.example.org, nonce 42')));
  assert.equal(messageInstructions(parseTransaction(buildTransaction({ payer: me, recentBlockhash: HASH, instructions: [setOwner] })).msg)[0].programId, PROGRAMS.token);
  assert.ok(b58.encode(addressBytes(me)) === me);
});

test('review fixes: durable nonces flagged, a token over several accounts, a service\'s own compute budget', async () => {
  const me = keyOfSeed(new Uint8Array(32).fill(7)).address, nonceAcc = keyOfSeed(new Uint8Array(32).fill(5)).address;
  const advance = { programId: PROGRAMS.system, keys: [{ pubkey: nonceAcc, isSigner: false, isWritable: true }, { pubkey: 'SysvarRecentB1ockHashes11111111111111111111', isSigner: false, isWritable: false }, { pubkey: me, isSigner: true, isWritable: false }], data: Uint8Array.from([4, 0, 0, 0]) };
  assert.equal(describeIx(advance).name, 'advanceNonce');
  assert.deepEqual(staticRisks([advance, system.transfer(me, nonceAcc, 1n)], me).map((r) => [r.level, r.key]), [['danger', 'nonce']]);
  const { holdings } = await import('../src/shared/solana/tokens.js');
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const ata = ataAddress(me, USDC), other = keyOfSeed(new Uint8Array(32).fill(2)).address;
  const [h] = holdings(me, [
    { account: ata, mint: USDC, amount: '0', decimals: 6, program: PROGRAMS.token, frozen: false },
    { account: other, mint: USDC, amount: '100', decimals: 6, program: PROGRAMS.token, frozen: false },
  ]);
  assert.equal(h.amount, 100n);
  assert.equal(h.account, other, 'sends take from the account that holds the tokens, not the empty associated one');
  assert.deepEqual(h.parts, [{ account: other, amount: '100' }]);
  const { ownBudget } = await import('../src/ui/solana/tx.js');
  const { computeBudget } = await import('../src/shared/solana/tx.js');
  assert.equal(ownBudget([system.transfer(me, other, 1n)]), null);
  assert.deepEqual(ownBudget([computeBudget.unitLimit(50000), computeBudget.unitPrice(1234), system.transfer(me, other, 1n)]), { limit: 50000, price: 1234 });
});

test('Jupiter within its limit: a refused request waits for the window and is tried again', async () => {
  const { jupFetch } = await import('../src/shared/solana/jupiter.js');
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{"code":429}', { status: 429, headers: { 'x-ratelimit-reset': String((Date.now() + 400) / 1000) } });
    return new Response('[]', { status: 200 });
  };
  try {
    const t0 = Date.now();
    const r = await jupFetch('/tokens/v2/search?query=x');
    assert.equal(r.status, 200);
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 >= 300, 'waited for the reset');
  } finally { globalThis.fetch = real; }
});

test('MEV protection: Jito\'s tip within bounds, the bundle sent privately, the usual nodes when Jito is away', async () => {
  const { jitoTip, sendViaJito } = await import('../src/shared/solana/jito.js');
  const { jupSwapTx } = await import('../src/ui/solana/swap.js');
  const real = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes('tip_floor')) return new Response(JSON.stringify([{ landed_tips_75th_percentile: 0.0000167 }]));
      if (String(url).includes('block-engine')) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'SIG' }));
      if (String(url).includes('/swap/v1/swap')) return new Response(JSON.stringify({ swapTransaction: toBase64(buildTransaction({ payer: keyOfSeed(new Uint8Array(32).fill(7)).address, recentBlockhash: HASH, instructions: [] })), prioritizationFeeLamports: 16700 }));
      return new Response('{}', { status: 404 });
    };
    assert.equal(await jitoTip(), 16700n);
    assert.equal(await sendViaJito(Uint8Array.of(1, 2, 3)), 'SIG');
    const sent = seen.find((x) => x.url.includes('block-engine'));
    assert.match(sent.url, /bundleOnly=true/);
    assert.equal(sent.body.method, 'sendTransaction');
    const tx = await jupSwapTx({ q: 1 }, 'me', { jitoTip: 16700n });
    assert.equal(tx.priorityFee, 16700n);
    assert.deepEqual(seen.at(-1).body.prioritizationFeeLamports, { jitoTipLamports: 16700 }, 'a tip instead of a priority fee');
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await sendViaJito(Uint8Array.of(1)), null, 'unreachable: the caller uses the usual nodes');
  } finally { globalThis.fetch = real; }
});
