import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, Cell, contractAddress, loadStateInit } from '@ton/core';
import {
  CODES, code, knownCode, jettonDeploy, jettonMintBody, jettonChangeAdminBody, jettonBurnBody, nftCollectionDeploy, nftMintBody, nftTransferBody,
  royaltyCell, JETTON_DEPLOY_VALUE, JETTON_MINT_FORWARD, NFT_ITEM_FORWARD,
} from '../src/shared/ton/templates.js';
import { parseContent } from '../src/shared/ton/cells.js';

const ME = Address.parse('0:' + '11'.repeat(32));
const OTHER = Address.parse('0:' + '22'.repeat(32));

// Pinned when the templates were added; they are the code of the most used jetton wallet, of the minter.ton.org
// jettons (github.com/ton-blockchain/minter) and of ~70% of the NFT collections on mainnet.
const EXPECTED = {
  JETTON_MINTER: '9a0f98dd6fbf225eef8165e4e64417ee931f7eea000653439e7b5dcdc0644cd6',
  JETTON_WALLET: 'beb0683ebeb8927fe9fc8ec0a18bc7dd17899689825a121eab46c5a3a860d0ce',
  NFT_COLLECTION: '64bb2d4661b5f2dc1a83bf5cbbe09e92ac0b460a1b879a5519386fca4c348bca',
  NFT_ITEM: 'ba4d975d2b66231c1f0a0ccca6e8ff8f7ba0610c4b7639584b8e98303dc3128c',
};

test('template code is exactly the official one (pinned hashes)', () => {
  assert.deepEqual(Object.keys(CODES).sort(), Object.keys(EXPECTED).sort());
  for (const [k, h] of Object.entries(EXPECTED)) {
    assert.equal(code(k).hash().toString('hex'), h, k);
    assert.equal(CODES[k].hash, h, k);
    assert.equal(knownCode(h.toUpperCase()), k);
  }
  assert.equal(knownCode('00'), null);
});

test('jetton: deploy + mint of the initial supply in one message', () => {
  const j = jettonDeploy({ admin: ME, name: 'Test Token', symbol: 'TST', decimals: 6, image: 'https://x/t.png', description: 'd', supply: 1_000_000n });
  assert.ok(j.address.equals(contractAddress(0, j.init)));
  const m = j.message;
  assert.equal(m.to, j.address.toRawString());
  assert.equal(m.value, String(JETTON_DEPLOY_VALUE));
  assert.equal(m.bounce, false);
  const init = loadStateInit(Cell.fromBase64(m.init).beginParse());
  assert.ok(contractAddress(0, init).equals(j.address));
  assert.equal(init.code.hash().toString('hex'), EXPECTED.JETTON_MINTER);
  // storage: total_supply admin content wallet_code
  const d = init.data.beginParse();
  assert.equal(d.loadCoins(), 0n);
  assert.ok(d.loadAddress().equals(ME));
  assert.deepEqual(parseContent(d.loadRef()), { onchain: { name: 'Test Token', symbol: 'TST', description: 'd', image: 'https://x/t.png', decimals: '6' } });
  assert.equal(d.loadRef().hash().toString('hex'), EXPECTED.JETTON_WALLET);
  // mint (op 21) to the admin, internal transfer with the amount and the admin as response address
  const b = Cell.fromBase64(m.body).beginParse();
  assert.equal(b.loadUint(32), 21);
  assert.equal(b.loadUintBig(64), 0n);
  assert.ok(b.loadAddress().equals(ME));
  assert.equal(b.loadCoins(), JETTON_MINT_FORWARD);
  const tr = b.loadRef().beginParse();
  assert.equal(tr.loadUint(32), 0x178d4519);
  tr.loadUintBig(64);
  assert.equal(tr.loadCoins(), 1_000_000n);
  assert.equal(tr.loadMaybeAddress(), null);
  assert.ok(tr.loadAddress().equals(ME));
  assert.equal(tr.loadCoins(), 0n);
  // no supply: deployment only
  assert.equal(jettonDeploy({ admin: ME, name: 'A', symbol: 'A', supply: 0n }).message.body, undefined);
  // the same data give the same address, a different admin another one
  assert.ok(jettonDeploy({ admin: ME, name: 'A', symbol: 'A' }).address.equals(jettonDeploy({ admin: ME, name: 'A', symbol: 'A' }).address));
  assert.ok(!jettonDeploy({ admin: ME, name: 'A', symbol: 'A' }).address.equals(jettonDeploy({ admin: OTHER, name: 'A', symbol: 'A' }).address));
});

test('jetton admin and holder operations', () => {
  const ch = jettonChangeAdminBody({ admin: OTHER }).beginParse();
  assert.equal(ch.loadUint(32), 3);
  ch.loadUintBig(64);
  assert.ok(ch.loadAddress().equals(OTHER));
  const drop = jettonChangeAdminBody({ admin: null }).beginParse().skip(96);
  assert.equal(drop.loadMaybeAddress(), null);
  const burn = jettonBurnBody({ amount: 5n, response: ME }).beginParse();
  assert.equal(burn.loadUint(32), 0x595f07bc);
  burn.loadUintBig(64);
  assert.equal(burn.loadCoins(), 5n);
  assert.ok(burn.loadAddress().equals(ME));
  assert.equal(burn.loadMaybeRef(), null);
  assert.equal(jettonMintBody({ to: OTHER, amount: 9n, response: ME }).beginParse().loadUint(32), 21);
});

test('NFT collection: storage layout, royalty, mint and transfer bodies', () => {
  const n = nftCollectionDeploy({ owner: ME, name: 'Coll', description: 'D', image: 'https://x/c.png', itemsBase: 'https://x/nft/', royaltyPercent: 5, royaltyTo: OTHER });
  const init = loadStateInit(Cell.fromBase64(n.message.init).beginParse());
  assert.ok(contractAddress(0, init).equals(n.address));
  assert.equal(n.message.body, undefined);
  const d = init.data.beginParse();
  assert.ok(d.loadAddress().equals(ME));
  assert.equal(d.loadUintBig(64), 0n);
  const content = d.loadRef().beginParse();
  assert.deepEqual(parseContent(content.loadRef()), { onchain: { name: 'Coll', description: 'D', image: 'https://x/c.png' } });
  assert.equal(content.loadRef().beginParse().loadStringTail(), 'https://x/nft/');
  assert.equal(d.loadRef().hash().toString('hex'), EXPECTED.NFT_ITEM);
  const r = d.loadRef().beginParse();
  assert.equal(r.loadUint(16), 500);
  assert.equal(r.loadUint(16), 10000);
  assert.ok(r.loadAddress().equals(OTHER));
  assert.throws(() => royaltyCell(51, ME));
  assert.throws(() => royaltyCell(-1, ME));

  const mint = nftMintBody({ index: 3n, owner: OTHER, content: '3.json' }).beginParse();
  assert.equal(mint.loadUint(32), 1);
  mint.loadUintBig(64);
  assert.equal(mint.loadUintBig(64), 3n);
  assert.equal(mint.loadCoins(), NFT_ITEM_FORWARD);
  const item = mint.loadRef().beginParse();
  assert.ok(item.loadAddress().equals(OTHER));
  assert.equal(item.loadRef().beginParse().loadStringTail(), '3.json');

  const tr = nftTransferBody({ to: OTHER, response: ME }).beginParse();
  assert.equal(tr.loadUint(32), 0x5fcc3d14);
  tr.loadUintBig(64);
  assert.ok(tr.loadAddress().equals(OTHER));
  assert.ok(tr.loadAddress().equals(ME));
  assert.equal(tr.loadMaybeRef(), null);
  assert.equal(tr.loadCoins(), 1n);
  assert.equal(tr.loadBit(), false);
});
