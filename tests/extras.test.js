// NFTs added by hand (read on-chain: ERC-721 / ERC-1155, shown only while owned), MEV protection (Ethereum
// transactions through the private channel, the nodes when it can't be reached) and TON as a network that can be
// switched off.
import './helpers/chrome.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { customNft, loadCustomNfts } from '../src/shared/nft.js';
import { sendRaw, mevAvailable } from '../src/shared/mev.js';
import { getChain, isChainEnabled, ALWAYS_ON, DEFAULT_ON } from '../src/shared/chains.js';

const ETH = getChain(1), BASE = getChain(8453);
const ME = '0x5e83857a7719b6ae2de17af827140c04323a231c', OTHER = '0x516fbc1ff3b5e9824da622c50caf37b220081e65';
const C721 = '0x1111111111111111111111111111111111111111', C1155 = '0x2222222222222222222222222222222222222222', NOPE = '0x3333333333333333333333333333333333333333';
const I = new Interface([
  'function ownerOf(uint256) view returns (address)', 'function balanceOf(address,uint256) view returns (uint256)',
  'function name() view returns (string)', 'function tokenURI(uint256) view returns (string)', 'function uri(uint256) view returns (string)',
]);
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const meta = (name) => 'data:application/json;base64,' + Buffer.from(JSON.stringify({ name, image: 'ipfs://QmArt', attributes: [{ trait_type: 'Eyes', value: 'Blue' }] })).toString('base64');

/** A node with an ERC-721 (id 7 mine, id 8 someone else's) and an ERC-1155 (3 of id 5); anything else reverts. */
function node() {
  globalThis.fetch = async (url, init = {}) => {
    const { id, method, params } = JSON.parse(init.body);
    if (method !== 'eth_call') return json({ jsonrpc: '2.0', id, result: null });
    const { to, data } = params[0];
    const revert = () => json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } });
    let f; try { f = I.parseTransaction({ data }); } catch { return revert(); }
    const ok = (v) => json({ jsonrpc: '2.0', id, result: I.encodeFunctionResult(f.name, [v]) });
    if (to === C721) {
      if (f.name === 'ownerOf') return ok(f.args[0] === 7n ? ME : OTHER);
      if (f.name === 'name') return ok('Foxes');
      if (f.name === 'tokenURI') return ok(meta(`Fox #${f.args[0]}`));
    }
    if (to === C1155) {
      if (f.name === 'balanceOf') return ok(f.args[1] === 5n && String(f.args[0]).toLowerCase() === ME ? 3n : 0n);
      if (f.name === 'name') return ok('Badges');
      if (f.name === 'uri') return ok(meta('Gold badge'));
    }
    return revert();
  };
}

test('NFT added by hand: ERC-721 owned, someone else\'s, ERC-1155, not an NFT', async () => {
  node();
  const fox = await customNft(ETH, ME, C721.toUpperCase().replace('0X', '0x'), '7');
  assert.equal(fox.standard, 'ERC-721');
  assert.equal(fox.name, 'Fox #7');
  assert.equal(fox.collection, 'Foxes');
  assert.equal(fox.image, 'https://ipfs.io/ipfs/QmArt');
  assert.equal(fox.custom, true); assert.equal(fox.spam, false);
  assert.deepEqual(fox.traits, [{ trait: 'Eyes', value: 'Blue' }]);
  assert.deepEqual(await customNft(ETH, ME, C721, '8'), { notMine: true, standard: 'ERC-721' });
  const badge = await customNft(ETH, ME, C1155, '5');
  assert.equal(badge.standard, 'ERC-1155'); assert.equal(badge.amount, '3'); assert.equal(badge.name, 'Gold badge');
  await assert.rejects(customNft(ETH, ME, NOPE, '1'));
  // at every load: only the ones still owned
  const list = await loadCustomNfts(ETH, ME, [{ contract: C721, tokenId: '7' }, { contract: C721, tokenId: '8' }, { contract: NOPE, tokenId: '1' }]);
  assert.deepEqual(list.map((x) => x.key), [`${C721}:7`]);
});

test('MEV protection: Ethereum through the private channel; its errors stand; unreachable -> the nodes', async () => {
  assert.equal(mevAvailable(1), true);
  assert.equal(mevAvailable(8453), false, 'L2: no public mempool');
  const seen = [];
  let mode = 'ok';
  globalThis.fetch = async (url, init = {}) => {
    const { id } = JSON.parse(init.body); const u = String(url); seen.push(u);
    if (u.includes('flashbots')) {
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === 'nonce') return json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'nonce too low' } }, 400); // as Flashbots answers
      if (mode === 'busy') return json({ jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limited' } }, 429);
      return json({ jsonrpc: '2.0', id, result: '0xprivate' });
    }
    return json({ jsonrpc: '2.0', id, result: '0xpublic' });
  };
  assert.deepEqual(await sendRaw(ETH, '0xsigned'), { hash: '0xprivate', protected: true });
  assert.deepEqual(await sendRaw(ETH, '0xsigned', { protect: false }), { hash: '0xpublic', protected: false });
  assert.deepEqual(await sendRaw(BASE, '0xsigned'), { hash: '0xpublic', protected: false });
  mode = 'down';
  assert.deepEqual(await sendRaw(ETH, '0xsigned'), { hash: '0xpublic', protected: false });
  mode = 'busy';
  assert.deepEqual(await sendRaw(ETH, '0xsigned'), { hash: '0xpublic', protected: false }, 'busy: the nodes');
  mode = 'nonce'; seen.length = 0;
  await assert.rejects(sendRaw(ETH, '0xsigned'), /nonce too low/);
  assert.ok(seen.every((u) => u.includes('flashbots')), 'a real answer is not sent again to the nodes');
});

test('TON can be switched off; Ethereum can\'t; both start on', () => {
  assert.ok(ALWAYS_ON.has(1) && !ALWAYS_ON.has(-239));
  assert.ok(DEFAULT_ON.has(1) && DEFAULT_ON.has(-239));
  assert.equal(isChainEnabled(-239, { disabledChains: [-239] }), false);
  assert.equal(isChainEnabled(1, { disabledChains: [1] }), true);
});
