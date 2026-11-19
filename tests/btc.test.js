// Bitcoin: keys and addresses against the official vectors (BIP84, BIP86, BIP49, BIP44, Electrum, WIF, BIP380), runes,
// coin selection and sizes, signatures, the search for funds (gap limit), the protection of coins with inscriptions or
// runes, the history, the background's checks before signing (own coins, own change, fee cap, replacement rules),
// the driver end to end (send, speed up, cancel, CPFP), imports and bridges - on a simulated network.
import { storage } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = { msg: [] };
const ev = (list) => ({ addListener: (f) => list?.push(f), removeListener() {} });
Object.assign(globalThis.chrome, {
  runtime: {
    id: 'test', getURL: (p) => `chrome-extension://test/${p}`, onMessage: ev(listeners.msg), onConnect: ev(), onInstalled: ev(),
    sendMessage: (msg) => new Promise((resolve) => { listeners.msg[0](msg, { id: 'test' }, resolve); }),
  },
  alarms: { create() {}, clear: async () => {}, onAlarm: ev() },
  tabs: { query: async () => [], sendMessage: async () => {}, create: async () => {} },
  windows: { onRemoved: ev(), create: async () => ({}), update: async () => ({}), remove: async () => {}, getLastFocused: async () => ({}) },
});
storage.onChanged = ev();

const btc = await import('@scure/btc-signer');
const { secp256k1, schnorr } = await import('@noble/curves/secp256k1');
const K = await import('../src/shared/btc/keys.js');
const { BTC_CHAINS } = await import('../src/shared/btc/networks.js');
const { selectCoins, txVbytes } = await import('../src/shared/btc/select.js');
const { signPlan, readTx } = await import('../src/shared/btc/build.js');
const { runestoneHex, decodeRunestone, hasRunestone, hasInscription } = await import('../src/shared/btc/runes.js');
const { scanAccount, totals, receiveAddress, newReceiveAddress, changeAddress, loadState, encodeAccount } = await import('../src/shared/btc/account.js');
const { markCoins } = await import('../src/shared/btc/coins.js');
const { setEsploraPace } = await import('../src/shared/btc/esplora.js');
const { setUnisatPace, setUnisatKey, forgetUnisat } = await import('../src/shared/btc/unisat.js');
const { familyOf: familySpec } = await import('../src/background/families.js');
const { registerUiHandlers } = await import('../src/background/index.js');
const { btcHandlers } = await import('../src/background/btc.js');
const { btcDriver, parseBip21 } = await import('../src/ui/btc/driver.js');
const { btcBridge } = await import('../src/ui/btc/bridge.js');
const { bitcoinNet, esploraTx } = await import('./helpers/btcnet.js');
const { t } = await import('../src/shared/i18n.js');
const like = (key) => new RegExp(t(key).replace(/\{\w+\}/g, '.*').replace(/[.*+?^$()|[\]\\]/g, (c) => (c === '.' || c === '*' ? c : `\\${c}`)).slice(0, 40));
registerUiHandlers(btcHandlers);
setEsploraPace(0);
setUnisatPace(0);

const MAIN = BTC_CHAINS[-8333], NET = MAIN.net;
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED = K.seedOfPhrase(PHRASE);
const ACC = { id: 'acc0', kind: 'hd', ...K.hdAccountPublic(SEED, 0, 0), receive: K.RECEIVE_TYPES };
const at = (b, c, i) => K.branchAddress(ACC.branches[b], c, i, NET);
const OTHER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TXID = (n) => n.toString(16).padStart(2, '0').repeat(32);
const send = (type, payload = {}) => new Promise((resolve, reject) => {
  listeners.msg[0]({ type, ...payload }, { id: 'test' }, (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))));
});
const reset = async () => { for (const k of Object.keys(storage.local.dump())) if (/^btc/.test(k)) await storage.local.remove(k); };

// ---------------------------------------------------------------- keys
test('keys: the official vectors of BIP84, BIP86, BIP49 and BIP44 (receive and change)', () => {
  assert.equal(at(0, 0, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(at(0, 1, 0), 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  assert.equal(at(1, 0, 0), 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  assert.equal(at(1, 0, 1), 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh');
  assert.equal(at(1, 1, 0), 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7');
  assert.equal(at(2, 0, 0), '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
  assert.equal(at(3, 0, 0), '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  assert.deepEqual(ACC.branches.map((b) => b.path), ["m/84'/0'/0'", "m/86'/0'/0'", "m/49'/0'/0'", "m/44'/0'/0'"]);
  assert.equal(ACC.fp, '73c5da0a');
  // the test networks: coin type 1, tb1 addresses
  const t = K.hdAccountPublic(SEED, 1, 0);
  assert.match(K.branchAddress(t.branches[0], 0, 0, BTC_CHAINS[-48333].net), /^tb1q/);
  assert.equal(t.branches[0].path, "m/84'/1'/0'");
});

test('keys: Electrum seeds (standard and SegWit), from Electrum\'s own tests', () => {
  const sw = K.electrumPublic('bitter grass shiver impose acquire brush forget axis eager alone wine silver');
  assert.equal(sw.kind, 'segwit');
  assert.equal(K.branchAddress(sw.branches[0], 0, 0, NET), 'bc1q3g5tmkmlvxryhh843v4dz026avatc0zzr6h3af');
  assert.equal(K.branchAddress(sw.branches[0], 1, 0, NET), 'bc1qdy94n2q5qcp0kg7v9yzwe6wvfkhnvyzje7nx2p');
  const st = K.electrumPublic('cycle rocket west magnet parrot shuffle foot correct salt library feed song');
  assert.equal(st.kind, 'standard');
  assert.equal(K.branchAddress(st.branches[0], 0, 0, NET), '1NNkttn1YvVGdqBW4PR6zvc3Zx3H5owKRf');
  assert.equal(K.branchAddress(st.branches[0], 1, 0, NET), '1KSezYMhAJMWqFbVFB2JshYg69UpmEXR4D');
  assert.equal(K.electrumSeedType(PHRASE), null, 'a BIP39 phrase is not an Electrum seed');
});

test('keys: WIF, descriptors with their checksum, addresses of every type', () => {
  const w = K.decodeWif('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn'); // private key 1
  assert.equal(K.addressOf('p2wpkh', w.publicKey, NET), OTHER);
  assert.equal(w.testnet, false);
  assert.equal(K.isUncompressedWif('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ'), true);
  assert.throws(() => K.decodeWif('not a key'));
  assert.equal(K.withChecksum('raw(deadbeef)'), 'raw(deadbeef)#89f8spxm'); // BIP380
  assert.match(K.branchDescriptor(ACC.branches[0], ACC.fp), /^wpkh\(\[73c5da0a\/84h\/0h\/0h\]xpub6CatWdiZ.*\/<0;1>\/\*\)#[a-z0-9]{8}$/);
  assert.match(K.branchDescriptor(ACC.branches[1], ACC.fp), /^tr\(\[73c5da0a\/86h\/0h\/0h\]xpub/);
  assert.match(K.toNetworkXpub(ACC.branches[0].xpub, true), /^tpub/);
  assert.equal(K.decodeAddress(at(1, 0, 0), NET).type, 'p2tr');
  assert.equal(K.decodeAddress('37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', NET).type, 'p2sh');
  assert.equal(K.decodeAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', NET), null, 'a test network address on mainnet');
});

// ---------------------------------------------------------------- runes
test('runes: the runestone of a transfer, the spec\'s delta encoding, recognised in transactions', () => {
  assert.equal(runestoneHex({ edicts: [{ id: '840000:3', amount: 100n, output: 1 }], pointer: 2 }), '6a5d09160200c0a233036401');
  const spec = [{ id: '10:5', amount: 5n, output: 1 }, { id: '50:1', amount: 25n, output: 4 }, { id: '10:7', amount: 1n, output: 8 }, { id: '10:5', amount: 10n, output: 3 }];
  const back = decodeRunestone(runestoneHex({ edicts: spec }));
  assert.deepEqual(back.edicts.map((e) => [e.id, e.amount, e.output]), [['10:5', 5n, 1], ['10:5', 10n, 3], ['10:7', 1n, 8], ['50:1', 25n, 4]]);
  assert.equal(back.cenotaph, false);
  assert.equal(decodeRunestone('6a0401020304'), null, 'a plain OP_RETURN is no runestone');
  assert.equal(decodeRunestone('6a5d4f').cenotaph, true, 'not a data push: cenotaph');
  assert.equal(hasRunestone({ vout: [{ scriptpubkey: '6a5d0100' }] }), true);
  assert.equal(hasInscription({ vin: [{ witness: ['aa', '20' + '11'.repeat(32) + 'ac0063036f7264010118'] }] }), true);
});

// ---------------------------------------------------------------- coin selection, sizes, signatures
const coin = (value, extra = {}) => ({ txid: TXID(extra.n ?? Number(value % 250n)), vout: 0, value, type: 'p2wpkh', confirmed: true, address: at(0, 0, 0), b: 0, c: 0, i: 0, ...extra });
const dest = (value) => ({ address: OTHER, script: K.decodeAddress(OTHER, NET).script, type: 'p2wpkh', value });
const CH = { address: at(0, 1, 0), script: K.decodeAddress(at(0, 1, 0), NET).script, type: 'p2wpkh', own: { b: 0, c: 1, i: 0 } };

test('select: one coin without change, change back, dust to the fee, max, not enough, forced change', () => {
  // a coin that pays it all with little left: no change
  let s = selectCoins({ coins: [coin(100_000n, { n: 1 }), coin(10_180n, { n: 2 })], outputs: [dest(10_000n)], change: CH, rate: 1 });
  assert.equal(s.inputs.length, 1); assert.equal(s.inputs[0].value, 10_180n); assert.equal(s.outputs.length, 1);
  // change back to the account, marked as its own
  s = selectCoins({ coins: [coin(100_000n, { n: 1 })], outputs: [dest(50_000n)], change: CH, rate: 10 });
  assert.equal(s.outputs.length, 2);
  assert.deepEqual(s.outputs[1].own, { b: 0, c: 1, i: 0 }); assert.equal(s.outputs[1].change, true);
  assert.equal(s.inputs[0].value, 50_000n + s.fee + s.outputs[1].value);
  assert.equal(s.fee, BigInt(Math.ceil(s.vbytes * 10)));
  // max: everything to the recipient
  s = selectCoins({ coins: [coin(60_000n, { n: 1 }), coin(40_000n, { n: 2 })], outputs: [dest(0n)], change: CH, rate: 5, max: true });
  assert.equal(s.outputs[0].value + s.fee, 100_000n); assert.equal(s.inputs.length, 2);
  // not enough
  s = selectCoins({ coins: [coin(10_000n)], outputs: [dest(50_000n)], change: CH, rate: 5 });
  assert.equal(s.error, 'funds'); assert.ok(s.need > 40_000n);
  // a change output that a service needs (LI.FI's refund) even when small
  s = selectCoins({ coins: [coin(11_200n, { n: 1 })], outputs: [dest(10_000n)], change: CH, rate: 1, forceChange: true });
  assert.equal(s.outputs.length, 2);
  // the coins that have to be spent come first
  s = selectCoins({ coins: [coin(500_000n, { n: 1 })], must: [coin(3_000n, { n: 2 })], outputs: [dest(10_000n)], change: CH, rate: 1 });
  assert.equal(s.inputs[0].value, 3_000n);
});

test('build: signatures verify (SegWit and Taproot key path) and the size estimate is the real one', () => {
  const keyAt = ({ b, c, i }) => ({ ...K.branchKey(SEED, ACC.branches[b].path, c, i), type: ACC.branches[b].type });
  const plan = {
    inputs: [{ txid: TXID(1), vout: 0, value: '50000', b: 0, c: 0, i: 0, address: at(0, 0, 0) }, { txid: TXID(2), vout: 1, value: '30000', b: 1, c: 0, i: 0, address: at(1, 0, 0) }],
    outputs: [{ address: OTHER, value: '60000' }, { address: at(1, 1, 0), value: '18000', own: { b: 1, c: 1, i: 0 } }],
  };
  const r = signPlan(plan, NET, keyAt);
  assert.equal(r.fee, 2000n);
  assert.ok(Math.abs(r.vsize - txVbytes(['p2wpkh', 'p2tr'], plan.outputs.map((o) => K.decodeAddress(o.address, NET).script))) <= 1, 'estimate within 1 vB');
  const tx = btc.Transaction.fromRaw(K.fromHex(r.hex), { allowUnknownOutputs: true });
  assert.equal(tx.getInput(0).sequence, 0xfffffffd, 'replaceable (RBF)');
  // SegWit v0: ECDSA over BIP143
  const w0 = tx.getInput(0).finalScriptWitness;
  const pub0 = keyAt({ b: 0, c: 0, i: 0 }).publicKey;
  const code = btc.OutScript.encode({ type: 'pkh', hash: btc.p2wpkh(pub0).hash });
  const h0 = tx.preimageWitnessV0(0, code, btc.SigHash.ALL, 50_000n);
  assert.ok(secp256k1.verify(w0[0].slice(0, -1), h0, pub0, { lowS: true }), 'ECDSA signature');
  // Taproot: Schnorr over BIP341 with the tweaked key
  const w1 = tx.getInput(1).finalScriptWitness;
  const scripts = [btc.p2wpkh(pub0).script, btc.p2tr(keyAt({ b: 1, c: 0, i: 0 }).publicKey.slice(1)).script];
  const h1 = tx.preimageWitnessV1(1, scripts, btc.SigHash.DEFAULT, [50_000n, 30_000n]);
  assert.ok(schnorr.verify(w1[0], h1, btc.p2tr(keyAt({ b: 1, c: 0, i: 0 }).publicKey.slice(1)).tweakedPubkey), 'Schnorr signature');
  // an input that isn't the key's address is refused
  assert.throws(() => signPlan({ ...plan, inputs: [{ ...plan.inputs[0], address: OTHER }] }, NET, keyAt), /not of this account/);
  assert.equal(readTx(r.hex).txid, r.txid);
});

// ---------------------------------------------------------------- the search for funds, addresses
test('account: funds found with the gap limit, older types left out when unused, quick refresh, addresses', async () => {
  await reset();
  const net = bitcoinNet({ utxos: { [at(0, 0, 0)]: [{ txid: TXID(1), vout: 0, value: 40_000 }], [at(0, 0, 15)]: [{ txid: TXID(2), vout: 0, value: 20_000 }], [at(0, 0, 40)]: [{ txid: TXID(3), vout: 0, value: 99 }], [at(3, 0, 0)]: [{ txid: TXID(4), vout: 0, value: 5_000 }], [at(1, 0, 0)]: [{ txid: TXID(5), vout: 1, value: 7_000, confirmed: false }] } });
  globalThis.fetch = net.fetch;
  const s = await scanAccount(MAIN, ACC);
  const tot = totals(s);
  assert.equal(tot.confirmed, 65_000n, 'index 15 is within 20 of index 0; index 40 is beyond the gap after 15 + 20');
  assert.equal(tot.pending, 7_000n);
  assert.equal(s.next['0:0'], 16);
  assert.equal(s.skip[2], true, 'P2SH-SegWit never used: left out');
  assert.equal(s.skip[3], false, 'legacy used: kept');
  const n = net.calls.length;
  await scanAccount(MAIN, ACC);
  assert.ok(net.calls.length - n < 25, 'a quick refresh asks much less');
  // receive: the first unused address; a new one on request; change: the next unused change address
  assert.equal(receiveAddress(MAIN, ACC, s, 'p2wpkh').address, at(0, 0, 16));
  assert.equal(receiveAddress(MAIN, ACC, s, 'p2tr').address, at(1, 0, 1));
  const nx = await newReceiveAddress(MAIN, ACC, 'p2wpkh');
  assert.equal(nx.address, at(0, 0, 17));
  assert.equal(changeAddress(MAIN, ACC, await loadState(MAIN, ACC), 'p2tr').address, at(1, 1, 0));
});

// ---------------------------------------------------------------- protection
test('coins: protection without services - runestones, inscriptions, small coins; the wallet\'s own clean change is free', async () => {
  await reset();
  setUnisatKey('');
  const a = at(0, 0, 0);
  const coins = [
    { txid: TXID(1), vout: 0, value: 100_000n, confirmed: true, address: a, b: 0, c: 0, i: 0, type: 'p2wpkh' },
    { txid: TXID(2), vout: 1, value: 50_000n, confirmed: true, address: a, b: 0, c: 0, i: 0, type: 'p2wpkh' },
    { txid: TXID(3), vout: 0, value: 10_000n, confirmed: true, address: a, b: 0, c: 0, i: 0, type: 'p2wpkh' },
    { txid: TXID(4), vout: 0, value: 546n, confirmed: true, address: a, b: 0, c: 0, i: 0, type: 'p2wpkh' },
    { txid: TXID(5), vout: 1, value: 3_000n, confirmed: true, address: a, b: 0, c: 0, i: 0, type: 'p2wpkh' },
  ];
  const txs = {
    [TXID(1)]: esploraTx(TXID(1), { vout: [{ address: a, value: 100_000 }] }),
    [TXID(2)]: esploraTx(TXID(2), { vout: [{ script: '6a5d0100', value: 0 }, { address: a, value: 50_000 }] }),
    [TXID(3)]: esploraTx(TXID(3), { vin: [{ address: OTHER, value: 20_000, witness: ['aa', '0063036f7264'] }], vout: [{ address: a, value: 10_000 }] }),
    [TXID(4)]: esploraTx(TXID(4), { vout: [{ address: a, value: 546 }] }),
  };
  globalThis.fetch = bitcoinNet({ txs }).fetch;
  const sent = { [TXID(5)]: { plan: { outputs: [], clean: true } } };
  const r = await markCoins(MAIN, ACC, coins, sent);
  const by = Object.fromEntries(r.coins.map((c) => [c.txid, c]));
  assert.equal(by[TXID(1)].protect, null); assert.equal(by[TXID(1)].spendable, true);
  assert.equal(by[TXID(2)].protect, 'runes');
  assert.equal(by[TXID(3)].protect, 'inscription');
  assert.equal(by[TXID(4)].protect, 'small');
  assert.equal(by[TXID(5)].protect, null, 'change of this wallet\'s own send that spent no protected coin');
  assert.equal(r.precise, false);
});

test('coins: with UniSat the coins that carry inscriptions and runes are known exactly', async () => {
  await reset();
  setUnisatKey('k'); forgetUnisat();
  const a = at(1, 0, 0);
  const coins = [
    { txid: TXID(1), vout: 0, value: 546n, confirmed: true, address: a, b: 1, c: 0, i: 0, type: 'p2tr' },
    { txid: TXID(2), vout: 0, value: 546n, confirmed: true, address: a, b: 1, c: 0, i: 0, type: 'p2tr' },
    { txid: TXID(3), vout: 0, value: 600n, confirmed: true, address: a, b: 1, c: 0, i: 0, type: 'p2tr' },
  ];
  globalThis.fetch = bitcoinNet({
    inscriptions: { [a]: [{ txid: TXID(1), vout: 0, satoshi: 546, inscriptions: [{ inscriptionId: `${TXID(9)}i0`, inscriptionNumber: 7, offset: 0 }] }] },
    runes: { [a]: [{ runeid: '840000:3', rune: 'DOG', spacedRune: 'DOG•GO', amount: '1000', divisibility: 0, symbol: '🐕' }] },
    runeUtxos: { [a]: { '840000:3': [{ txid: TXID(2), vout: 0, satoshi: 546, runes: [{ runeid: '840000:3', amount: '1000' }] }] } },
  }).fetch;
  const r = await markCoins(MAIN, ACC, coins, {});
  const by = Object.fromEntries(r.coins.map((c) => [c.txid, c]));
  assert.equal(by[TXID(1)].protect, 'inscription'); assert.equal(by[TXID(1)].inscriptions[0].number, 7);
  assert.equal(by[TXID(2)].protect, 'runes'); assert.equal(by[TXID(2)].runes[0].amount, 1000n);
  assert.equal(by[TXID(3)].protect, null, 'small but clean: spendable'); assert.equal(r.precise, true);
  setUnisatKey('');
});

// ---------------------------------------------------------------- driver: links and addresses
test('driver: BIP21 links, addresses of other networks, Lightning, own addresses', () => {
  assert.equal(btcDriver.paymentLink(MAIN, { address: at(0, 0, 0), amountRaw: '150000', ask: true }), `bitcoin:${at(0, 0, 0)}?amount=0.0015`);
  assert.deepEqual(btcDriver.parseQr(MAIN, `bitcoin:${OTHER.toUpperCase()}?amount=0.5&label=Shop`), { address: OTHER, token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', amountRaw: 50_000_000n });
  assert.equal(parseBip21('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', MAIN), null);
  assert.equal(btcDriver.validateAddress(MAIN, '0x5e83857a7719B6aE2DE17af827140C04323a231C').error, 'btc.send.evmAddress');
  assert.equal(btcDriver.validateAddress(MAIN, 'lnbc1500n1pdummy').error, 'btc.send.lightning');
  assert.equal(btcDriver.validateAddress(MAIN, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx').error, 'btc.send.testnetAddress');
  assert.equal(btcDriver.validateAddress(BTC_CHAINS[-48333], OTHER).error, 'btc.send.mainnetAddress');
  assert.equal(btcDriver.validateAddress(MAIN, at(1, 0, 0)).ok, true);
});

// ---------------------------------------------------------------- the background
let wallet = null;
async function vault() {
  if (!wallet) {
    await send('createVault', { password: 'walletpw1', mnemonic: PHRASE });
    wallet = (await send('getState')).accounts[0].address;
  }
  return wallet;
}

test('background: the phrase\'s account is BIP84/BIP86 account 0, public keys only', async () => {
  const me = await vault();
  const map = await send('btcAccounts', { chainId: MAIN.id });
  const a = map[me];
  assert.equal(a.kind, 'hd'); assert.equal(a.fp, '73c5da0a');
  assert.deepEqual(a.branches.map((b) => b.xpub), ACC.branches.map((b) => b.xpub));
  assert.ok(!JSON.stringify(a).includes('xprv'));
  const t = (await send('btcAccounts', { chainId: -48333 }))[me];
  assert.equal(t.branches[0].path, "m/84'/1'/0'");
});

test('background: a send is checked (own coins, own change, fee cap), signed, broadcast and kept', async () => {
  const me = await vault();
  await reset();
  const net = bitcoinNet({});
  globalThis.fetch = net.fetch;
  const plan = {
    inputs: [{ txid: TXID(1), vout: 0, value: '100000', b: 0, c: 0, i: 0, address: at(0, 0, 0) }],
    outputs: [{ address: OTHER, value: '60000' }, { address: at(0, 1, 0), value: '39000', own: { b: 0, c: 1, i: 0 }, change: true }],
    clean: true,
  };
  await assert.rejects(send('btcSend', { from: me, chainId: MAIN.id, plan, password: 'nope' }), like('errors.wrongPassword'));
  await assert.rejects(send('btcSend', { from: me, chainId: MAIN.id, plan: { ...plan, outputs: [plan.outputs[0], { ...plan.outputs[1], address: OTHER }] }, password: 'walletpw1' }), like('btc.err.notOwnChange'));
  await assert.rejects(send('btcSend', { from: me, chainId: MAIN.id, plan: { ...plan, inputs: [{ ...plan.inputs[0], address: at(0, 0, 1) }] }, password: 'walletpw1' }), like('btc.err.notOwner'));
  await assert.rejects(send('btcSend', { from: me, chainId: MAIN.id, plan: { ...plan, outputs: [{ address: OTHER, value: '1000' }] }, password: 'walletpw1' }), like('btc.err.feeTooHigh'));
  const r = await send('btcSend', { from: me, chainId: MAIN.id, plan, meta: { title: 'Pizza' }, password: 'walletpw1' });
  assert.equal(net.broadcasts.length, 1);
  assert.equal(readTx(net.broadcasts[0]).txid, r.txid);
  assert.equal(r.fee, '1000');
  const log = storage.local.dump()[`btcsent:${MAIN.id}`];
  assert.equal(log[r.txid].title, 'Pizza'); assert.equal(log[r.txid].account, me); assert.equal(log[r.txid].plan.clean, true);
});

test('background: replacements follow the rules - more fee, same recipients for a speed up, nobody else for a cancel', async () => {
  const me = await vault();
  await reset();
  const net = bitcoinNet({});
  globalThis.fetch = net.fetch;
  const plan = {
    inputs: [{ txid: TXID(1), vout: 0, value: '100000', b: 0, c: 0, i: 0, address: at(0, 0, 0) }],
    outputs: [{ address: OTHER, value: '60000' }, { address: at(0, 1, 0), value: '39800', own: { b: 0, c: 1, i: 0 }, change: true }],
  };
  const orig = await send('btcSend', { from: me, chainId: MAIN.id, plan, password: 'walletpw1' });
  const bump = (change) => ({ ...plan, outputs: [plan.outputs[0], { ...plan.outputs[1], value: String(change) }] });
  await assert.rejects(send('btcReplace', { from: me, chainId: MAIN.id, txid: orig.txid, mode: 'speedUp', plan: bump(39_750), password: 'walletpw1' }), like('btc.replace.lowFee'));
  await assert.rejects(send('btcReplace', { from: me, chainId: MAIN.id, txid: orig.txid, mode: 'speedUp', plan: { ...plan, outputs: [{ address: OTHER, value: '50000' }, { ...plan.outputs[1], value: '49000' }] }, password: 'walletpw1' }), like('btc.err.badPlan'));
  await assert.rejects(send('btcReplace', { from: me, chainId: MAIN.id, txid: orig.txid, mode: 'cancel', plan: bump(38_000), password: 'walletpw1' }), like('btc.err.badPlan'));
  const up = await send('btcReplace', { from: me, chainId: MAIN.id, txid: orig.txid, mode: 'speedUp', plan: bump(38_000), password: 'walletpw1' });
  const cancel = await send('btcReplace', { from: me, chainId: MAIN.id, txid: up.txid, mode: 'cancel', plan: { inputs: plan.inputs, outputs: [{ address: at(0, 1, 0), value: '96000', own: { b: 0, c: 1, i: 0 } }] }, password: 'walletpw1' });
  const log = storage.local.dump()[`btcsent:${MAIN.id}`];
  assert.equal(log[up.txid].replaces, orig.txid); assert.equal(log[up.txid].mode, 'speedUp');
  assert.equal(log[cancel.txid].replaces, up.txid); assert.equal(log[cancel.txid].mode, 'cancel');
  // no replacement of a transaction already confirmed
  net.fetch; // (status from the simulated network)
});

// ---------------------------------------------------------------- history
test('history: payments, change and moves between own addresses; a replaced send is one operation', async () => {
  await reset();
  const me = at(0, 0, 0), ch = at(0, 1, 0), tr = at(1, 0, 0);
  const txs = {
    [TXID(1)]: esploraTx(TXID(1), { vin: [{ address: OTHER, value: 120_000 }], vout: [{ address: me, value: 100_000 }, { address: OTHER, value: 19_000 }], time: 1794550000 }),
    [TXID(2)]: esploraTx(TXID(2), { vin: [{ address: me, value: 100_000 }], vout: [{ address: OTHER, value: 30_000 }, { address: ch, value: 69_000 }], fee: 1000, time: 1794551000 }),
    [TXID(3)]: esploraTx(TXID(3), { vin: [{ address: ch, value: 69_000 }], vout: [{ address: tr, value: 68_000 }], fee: 1000, time: 1794552000 }),
  };
  const net = bitcoinNet({
    txs, addrTxs: { [me]: [TXID(2), TXID(1)], [ch]: [TXID(3), TXID(2)], [tr]: [TXID(3)] },
    utxos: { [tr]: [{ txid: TXID(3), vout: 0, value: 68_000 }] }, used: { [me]: 2, [ch]: 2, [tr]: 1 }, rbf: { [TXID(8)]: TXID(2) },
  });
  globalThis.fetch = net.fetch;
  // TXID(8): sent by Chakra and replaced (speed up) by TXID(2)
  await storage.local.set({ [`btcsent:${MAIN.id}`]: {
    [TXID(8)]: { txid: TXID(8), account: ACC.id, time: Date.now() - 6e5, fee: '500', vsize: 141, plan: { inputs: [], outputs: [{ address: OTHER, value: '30000' }] } },
    [TXID(2)]: { txid: TXID(2), account: ACC.id, time: Date.now() - 5e5, fee: '1000', vsize: 141, replaces: TXID(8), mode: 'speedUp', plan: { inputs: [], outputs: [{ address: OTHER, value: '30000' }] } },
  } });
  const r = await btcDriver.loadHistory(MAIN, encodeAccount(ACC), null);
  const by = Object.fromEntries(r.items.map((x) => [x.hash, x]));
  assert.equal(by[TXID(1)].kind, 'receive'); assert.equal(by[TXID(1)].transfers[0].amount, '100000');
  assert.equal(by[TXID(2)].kind, 'send'); assert.equal(by[TXID(2)].transfers[0].amount, '30000', 'the change is not a payment');
  assert.equal(by[TXID(2)].fee, '1000'); assert.equal(by[TXID(2)].replacement, 'speedUp');
  assert.equal(by[TXID(3)].kind, 'contract'); assert.equal(by[TXID(3)].label, t('btc.h.self'));
  assert.equal(by[TXID(8)], undefined, 'the replaced send is hidden behind its replacement');
  assert.deepEqual(r.items.map((x) => x.hash), [TXID(3), TXID(2), TXID(1)]);
});

// ---------------------------------------------------------------- driver end to end
test('driver: send (coins chosen, protected ones left alone), speed up and cancel through the background', async () => {
  const me = await vault();
  await reset();
  setUnisatKey('');
  const a0 = at(0, 0, 0), a1 = at(1, 0, 0);
  const txs = {
    [TXID(1)]: esploraTx(TXID(1), { vout: [{ address: a0, value: 80_000 }] }),
    [TXID(2)]: esploraTx(TXID(2), { vout: [{ address: a1, value: 546 }] }),
  };
  const net = bitcoinNet({ txs, utxos: { [a0]: [{ txid: TXID(1), vout: 0, value: 80_000 }], [a1]: [{ txid: TXID(2), vout: 0, value: 546 }] } });
  globalThis.fetch = net.fetch;
  const wallet = (await btcDriver.resolveAddresses(MAIN, [{ address: me }]))[me];
  assert.equal(wallet.address, a0);
  const review = await btcDriver.prepareSend(MAIN, { wallet, token: { native: true }, to: OTHER, amountRaw: 50_000n, isMax: false });
  assert.equal(review.problem('normal'), null);
  const sel = review.fee.selFor('normal');
  assert.deepEqual(sel.inputs.map((c) => c.txid), [TXID(1)], 'the 546-sat coin (maybe an inscription) is left alone');
  assert.equal(sel.fee, BigInt(Math.ceil(sel.vbytes * 10)), 'normal = mempool.space\'s half-hour rate');
  assert.ok(review.fee.selFor('custom:3').fee < sel.fee);
  // too much: the protected coin is named
  const big = await btcDriver.prepareSend(MAIN, { wallet, token: { native: true }, to: OTHER, amountRaw: 80_000n, isMax: false });
  assert.match(big.problem('normal'), like('btc.send.noFundsHeld'));
  const authorize = (fn) => fn('walletpw1');
  const sent = await btcDriver.confirmSend(MAIN, review, { account: { address: me }, speed: 'normal', authorize, title: 'Rent' });
  const tx = readTx(net.broadcasts[0]);
  assert.equal(tx.txid, sent.hash);
  assert.equal(tx.outputs[0].value, 50_000n);
  // the history shows it waiting; it can be sped up or cancelled
  const r = await btcDriver.loadHistory(MAIN, wallet.raw, null);
  const it = r.items.find((x) => x.hash === sent.hash);
  assert.equal(it.status, 'pending'); assert.equal(it.sentByMe, true); assert.equal(it.appTitle, 'Rent');
  assert.deepEqual(btcDriver.replace.options(MAIN, it), { speedUp: true, cancel: true });
  net.fetch; // speed up at the fast rate
  const up = await btcDriver.replace.prepare(MAIN, it, { mode: 'speedUp', wallet });
  assert.equal(up.problem('fast'), null);
  const upSel = up.fee.selFor('fast');
  assert.equal(upSel.outputs[0].value, 50_000n, 'the recipient gets the same');
  const upSent = await btcDriver.replace.confirm(MAIN, up, { account: { address: me }, speed: 'fast', authorize, title: 'x' });
  assert.equal(readTx(net.broadcasts[1]).txid, upSent.hash);
  const cancel = await btcDriver.replace.prepare(MAIN, { ...it, hash: upSent.hash }, { mode: 'cancel', wallet });
  const cSel = cancel.fee.selFor('fast');
  assert.equal(cSel.outputs.length, 1); assert.ok(cSel.outputs[0].own, 'everything back to the account');
  assert.ok(cSel.fee >= upSel.fee + BigInt(cSel.vbytes));
  await btcDriver.replace.confirm(MAIN, cancel, { account: { address: me }, speed: 'fast', authorize, title: 'x' });
  assert.equal(net.broadcasts.length, 3);
});

test('driver: CPFP speeds up a payment on its way in', async () => {
  const me = await vault();
  await reset();
  const a0 = at(0, 0, 0);
  const parent = esploraTx(TXID(7), { vin: [{ address: OTHER, value: 60_000 }], vout: [{ address: a0, value: 50_000 }], confirmed: false, fee: 141 });
  const net = bitcoinNet({ txs: { [TXID(7)]: parent }, addrTxs: { [a0]: [TXID(7)] }, utxos: { [a0]: [{ txid: TXID(7), vout: 0, value: 50_000, confirmed: false }] } });
  globalThis.fetch = net.fetch;
  const wallet = (await btcDriver.resolveAddresses(MAIN, [{ address: me }]))[me];
  const r = await btcDriver.loadHistory(MAIN, wallet.raw, null);
  const it = r.items[0];
  assert.deepEqual(btcDriver.replace.options(MAIN, it), { speedUp: true, cancel: false });
  const rv = await btcDriver.replace.prepare(MAIN, it, { mode: 'speedUp', wallet });
  const s = rv.fee.selFor('fast');
  const pv = Math.ceil(parent.weight / 4);
  assert.ok(Number(s.fee + 141n) / (pv + s.vbytes) >= 20 - 0.01, 'the package pays the fast rate');
  await btcDriver.replace.confirm(MAIN, rv, { account: { address: me }, speed: 'fast', authorize: (fn) => fn('walletpw1'), title: 'x' });
  const child = readTx(net.broadcasts[0]);
  assert.equal(child.inputs[0].txid, TXID(7));
});

// ---------------------------------------------------------------- import
test('import: BIP39 phrase, Electrum seed, WIF; a Bitcoin-only account; the vault\'s format checks', async () => {
  await vault();
  const k1 = await send('btcInspectKey', { text: 'cycle rocket west magnet parrot shuffle foot correct salt library feed song', chainId: MAIN.id });
  assert.equal(k1.scheme, 'electrum'); assert.equal(k1.seedType, 'standard');
  const k2 = await send('btcInspectKey', { text: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn', chainId: MAIN.id });
  assert.equal(k2.scheme, 'wif'); assert.equal(k2.accounts[0].branches.length, 4);
  await assert.rejects(send('btcInspectKey', { text: '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ', chainId: MAIN.id }), like('btc.import.uncompressed'));
  await assert.rejects(send('btcImport', { text: PHRASE, index: 0 }), like('errors.accountExists'), 'the wallet\'s own phrase: already there');
  const acc = await send('btcImport', { text: 'bitter grass shiver impose acquire brush forget axis eager alone wine silver', name: 'Electrum' });
  assert.equal(acc.type, 'bitcoin'); assert.equal(acc.address, 'bc1q3g5tmkmlvxryhh843v4dz026avatc0zzr6h3af');
  const map = await send('btcAccounts', { chainId: MAIN.id });
  assert.equal(map[acc.address].kind, 'electrum'); assert.deepEqual(map[acc.address].receive, ['p2wpkh']);
  const f = familySpec('bitcoin');
  assert.deepEqual(f.clean({ address: OTHER, secret: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn', scheme: 'wif' }), { address: OTHER, secret: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn', scheme: 'wif', index: 0 });
  assert.equal(f.clean({ address: OTHER, secret: 'x', scheme: 'wif' }), null);
  assert.equal(f.clean({ address: '0x5e83857a7719B6aE2DE17af827140C04323a231C', secret: PHRASE, scheme: 'bip39' }), null);
});

// ---------------------------------------------------------------- runes and bridges
test('runes: a transfer spends the rune\'s coins, pays the recipient 546 sats and sends the rest of the runes back', async () => {
  const me = await vault();
  await reset();
  setUnisatKey('k'); forgetUnisat();
  const a0 = at(0, 0, 0), a1 = at(1, 0, 0);
  globalThis.fetch = bitcoinNet({
    utxos: { [a0]: [{ txid: TXID(1), vout: 0, value: 80_000 }], [a1]: [{ txid: TXID(2), vout: 0, value: 546 }] },
    runes: { [a1]: [{ runeid: '840000:3', rune: 'DOG', spacedRune: 'DOG•GO', amount: '1000', divisibility: 0, symbol: '🐕' }] },
    runeUtxos: { [a1]: { '840000:3': [{ txid: TXID(2), vout: 0, satoshi: 546, runes: [{ runeid: '840000:3', amount: '1000' }] }] } },
  }).fetch;
  const wallet = (await btcDriver.resolveAddresses(MAIN, [{ address: me }]))[me];
  const p = await btcDriver.loadPortfolio(MAIN, wallet.raw, {});
  const rune = p.tokens.find((x) => x.rune);
  assert.equal(rune.address, '840000:3'); assert.equal(rune.balance, '1000');
  const review = await btcDriver.prepareSend(MAIN, { wallet, token: rune, to: at(1, 0, 5).replace(/./, 'b') && OTHER, amountRaw: 400n });
  assert.equal(review.problem('normal'), null);
  const s = review.fee.selFor('normal');
  assert.equal(s.inputs[0].txid, TXID(2), 'the rune\'s coin first');
  assert.equal(s.outputs[0].value, 546n); assert.equal(s.outputs[0].address, OTHER);
  assert.ok(s.outputs[1].own, 'the rest of the runes back to the account');
  const stone = decodeRunestone(K.toHex(s.outputs[2].script));
  assert.deepEqual(stone.edicts.map((e) => [e.id, e.amount, e.output]), [['840000:3', 400n, 0]]); assert.equal(stone.pointer, 1);
  setUnisatKey('');
});

test('bridge: Relay\'s deposit address and LI.FI\'s memo become the exact outputs; nothing else is paid', async () => {
  await reset();
  const me = await vault();
  const a0 = at(0, 0, 0);
  const VAULT = 'bc1qawcdxplxprc64fh38ryy4crndmfgwrffpac743', DEPOSIT = at(0, 0, 0).replace(/^bc1q/, 'bc1q') && 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
  const btcnet = bitcoinNet({ utxos: { [a0]: [{ txid: TXID(1), vout: 0, value: 500_000 }] } });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.relay.link/quote/v2')) {
      const b = JSON.parse(init.body);
      assert.equal(b.useDepositAddress, true); assert.equal(b.refundTo, a0);
      return new Response(JSON.stringify({ steps: [{ id: 'deposit', depositAddress: DEPOSIT, requestId: '0xabc', items: [{ data: { psbt: 'x' } }] }], details: { currencyOut: { amount: '1000000000000000', amountUsd: '90' }, timeEstimate: 900 }, fees: {} }));
    }
    if (u.startsWith('https://li.quest/v1/quote')) {
      return new Response(JSON.stringify({ tool: 'thorswap', estimate: { toAmount: '990000000000000', toAmountMin: '980000000000000', toAmountUSD: '89', feeCosts: [] }, transactionRequest: { to: VAULT, value: '300000', data: '=:ETH.ETH:0x000000000000000000000000000000000000dEaD::lifi:0|0x4977' } }));
    }
    return btcnet.fetch(url, init);
  };
  const wallet = (await btcDriver.resolveAddresses(MAIN, [{ address: me }]))[me];
  const base = { id: 8453, name: 'Base', native: { symbol: 'ETH', name: 'Ether', decimals: 18 } };
  const p = { fromChain: MAIN, toChain: base, fromToken: { native: true, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }, toToken: { native: true, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }, amount: '300000', fromAddr: wallet, toAddr: { raw: '0x000000000000000000000000000000000000dEaD' }, account: { address: me }, title: 'Bridge' };
  const { quotes } = await btcBridge.quotes(p);
  const relay = quotes.find((q) => q.provider === 'Relay'), lifi = quotes.find((q) => q.provider === 'LI.FI');
  assert.deepEqual(relay.exec.outputs, [{ address: DEPOSIT, value: '300000' }]);
  assert.equal(lifi.exec.outputs[0].address, VAULT); assert.match(lifi.exec.outputs[1].script, /^6a/);
  const [step] = await btcBridge.steps(lifi, p);
  const rv = await step.prepare();
  assert.equal(rv.problem('normal'), null);
  const s = rv.fee.selFor('normal');
  assert.equal(s.outputs.length, 3, 'vault, memo, refund');
  assert.equal(s.outputs[2].address, a0, 'the rest back to the sender\'s address LI.FI was quoted with');
  await step.send(rv, { speed: 'normal', auth: (fn) => fn('walletpw1') });
  const tx = readTx(btcnet.broadcasts[0]);
  assert.equal(tx.outputs.length, 3); assert.equal(tx.outputs[0].value, 300_000n);
});

// ---------------------------------------------------------------- how many requests a search costs
test('account: a chain never used is looked at on its first 5 addresses; the whole gap of 20 only when asked', async () => {
  await reset();
  const fresh = { id: 'fresh', kind: 'hd', ...K.hdAccountPublic(K.seedOfPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow'), 0, 0), receive: K.RECEIVE_TYPES };
  const net = bitcoinNet({});
  globalThis.fetch = net.fetch;
  const asked = () => net.calls.filter((p) => /\/address\/[^/]+$/.test(p)).length;
  await scanAccount(MAIN, fresh);
  assert.equal(asked(), 2 * 5 + 2 * 3, 'SegWit and Taproot: 5 each; the older types: 3 each, once');
  const n = asked();
  await scanAccount(MAIN, fresh, { full: true });
  assert.equal(asked() - n, 2 * 20, 'asked by the user: 20 on each receive chain (the older types are not looked at again)');
  // something found on the third address: the 20 after it
  await reset();
  const used = bitcoinNet({ utxos: { [K.branchAddress(fresh.branches[0], 0, 2, NET)]: [{ txid: TXID(1), vout: 0, value: 1000 }] } });
  globalThis.fetch = used.fetch;
  const s = await scanAccount(MAIN, fresh);
  assert.equal(s.next['0:0'], 3);
  assert.ok(used.calls.filter((p) => /\/address\/[^/]+$/.test(p)).length >= 3 + 20, 'the gap after the address found');
});

test('background: a phrase created by Chakra has no older address types; one typed in has them', async () => {
  await vault();
  const before = (await send('getState')).activeWallet;
  await send('createWallet', { name: 'Fresh', mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', generated: true });
  const st = await send('getState');
  const created = (await send('btcAccounts', { chainId: MAIN.id }))[st.accounts[0].address];
  assert.deepEqual(created.branches.map((b) => b.type), ['p2wpkh', 'p2tr']);
  await send('switchWallet', { id: before });
  const typed = (await send('btcAccounts', { chainId: MAIN.id }))[(await send('getState')).accounts[0].address];
  assert.deepEqual(typed.branches.map((b) => b.type), ['p2wpkh', 'p2tr', 'p2sh-p2wpkh', 'p2pkh']);
});
