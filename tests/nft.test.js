// NFTs on the home screen: what the indexers answer, turned into the items the screen shows (and the spam it hides).
import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaUrl, spamNft, fakeBrand, hasDomain, traitsOf, fromBlockscout, holdingsFromTransfers } from '../src/shared/nft.js';
import { tonNftItems } from '../src/shared/ton/api.js';

const ME = '0x1111111111111111111111111111111111111111', X = '0x2222222222222222222222222222222222222222';
const C = '0xAbCdEf0000000000000000000000000000000001';

test('media links: https, ipfs, arweave and inline images only', () => {
  assert.equal(mediaUrl('https://a.b/c.png'), 'https://a.b/c.png');
  assert.equal(mediaUrl('ipfs://Qm123/1.png'), 'https://ipfs.io/ipfs/Qm123/1.png');
  assert.equal(mediaUrl('ipfs://ipfs/Qm123'), 'https://ipfs.io/ipfs/Qm123');
  assert.equal(mediaUrl('ar://tx1'), 'https://arweave.net/tx1');
  assert.equal(mediaUrl('data:image/svg+xml;base64,AA'), 'data:image/svg+xml;base64,AA');
  assert.equal(mediaUrl('http://insecure/x.png'), null);
  assert.equal(mediaUrl('javascript:alert(1)'), null);
  assert.equal(mediaUrl(''), null);
});

test('spam NFTs: links and bait words; emoji and other alphabets are fine', () => {
  assert.equal(spamNft('Claim 500 USDT at bonus-site.xyz', ''), true);
  assert.equal(spamNft('Voucher', 'Airdrop'), true);
  assert.equal(spamNft('Котик #12', 'Котики'), false);
  assert.equal(spamNft('🐸 Frog', 'Pond'), false);
  assert.equal(spamNft('vitalik.eth', 'ENS'), false);
});

test('spam NFTs: fear instead of a gift, and text dressed up in fancy letters', () => {
  // seen on Base: a "security warning" that sends to a look-alike of revoke.cash, written in mathematical bold letters
  const desc = '𝗜𝗳 𝘆𝗼𝘂 𝗿𝗲𝗰𝗲𝗶𝘃𝗲𝗱 𝘁𝗵𝗶𝘀 𝗺𝗲𝘀𝘀𝗮𝗴𝗲, 𝘆𝗼𝘂𝗿 𝘁𝗼𝗸𝗲𝗻𝘀 𝗺𝗮𝘆 𝗯𝗲 𝗮𝘁 𝗿𝗶𝘀𝗸.\n\n𝗿𝗲𝘃𝗼𝗸𝗲.𝗳𝗶 — a wallet check for dangerous token approvals.\n\nTo eliminate the threat, go to https://revoke.fi';
  assert.equal(spamNft('Your tokens compromised', 'revoke', { description: desc }), true);
  assert.equal(spamNft('Security notice', 'Wallet', { description: desc }), true, 'from the description alone');
  assert.equal(spamNft('Notice', 'Info', { description: '𝗙𝗿𝗲𝗲 𝗺𝗶𝗻𝘁 at https://x.example' }), true, 'fancy letters with a link');
  assert.equal(spamNft('𝔊𝔬𝔱𝔥𝔦𝔠 #3', 'Blackletter'), false, 'fancy letters alone: an art style');
  assert.equal(spamNft('Sunset #4', 'Skies', { description: 'Painted in 2021. More at https://artist.example' }), false, 'a plain link to the artist');
});

test('Blockscout NFTs -> items', () => {
  const [a, b] = fromBlockscout([
    { id: '7', value: '1', token_type: 'ERC-721', image_url: 'ipfs://Qm/7.png', metadata: { name: 'Thing #7', description: 'd', attributes: [{ trait_type: 'Mood', value: 'calm' }, { trait_type: 'Bad', value: { x: 1 } }] }, token: { address_hash: C, name: 'Things', type: 'ERC-721', reputation: 'ok' } },
    { id: '1', value: '3', token_type: 'ERC-1155', image_url: null, metadata: null, token: { address_hash: X, name: 'Visit claim-now.io', reputation: 'ok' } },
  ]);
  assert.deepEqual(a, { key: `${C.toLowerCase()}:7`, contract: C.toLowerCase(), tokenId: '7', name: 'Thing #7', collection: 'Things', image: 'https://ipfs.io/ipfs/Qm/7.png', description: 'd', traits: [{ trait: 'Mood', value: 'calm' }], standard: 'ERC-721', amount: '1', spam: false });
  assert.equal(b.name, 'Visit claim-now.io #1');
  assert.equal(b.amount, '3');
  assert.equal(b.spam, true);
  assert.equal(fromBlockscout([{ id: '2', token: { address_hash: X, name: 'Ok', reputation: 'scam' } }])[0].spam, true, 'flagged by the indexer');
});

test('Etherscan NFT transfers -> what is still held', () => {
  const tx = (o) => ({ contractAddress: C, tokenName: 'Things', ...o });
  const held = holdingsFromTransfers(ME, [
    tx({ tokenID: '1', from: X, to: ME, timeStamp: '10' }),
    tx({ tokenID: '1', from: ME, to: X, timeStamp: '20' }), // sold
    tx({ tokenID: '2', from: X, to: ME, timeStamp: '30' }),
  ], [
    tx({ tokenID: '9', tokenValue: '5', from: X, to: ME, timeStamp: '40' }),
    tx({ tokenID: '9', tokenValue: '2', from: ME, to: X, timeStamp: '50' }),
  ]);
  assert.deepEqual(held, [
    { contract: C.toLowerCase(), tokenId: '9', collection: 'Things', symbol: '', standard: 'ERC-1155', amount: '3' },
    { contract: C.toLowerCase(), tokenId: '2', collection: 'Things', symbol: '', standard: 'ERC-721', amount: '1' },
  ]);
});

test('TON Center NFTs -> items (indexed metadata, or the collection and index)', () => {
  const items = tonNftItems({
    nft_items: [
      { address: '0:AA', index: '5', collection_address: '0:CC', on_sale: true },
      { address: '0:BB', index: '6', collection_address: '0:CC' },
      { address: '0:DD', index: '0', collection_address: null },
    ],
    metadata: {
      '0:AA': { token_info: [{ type: 'nft_items', name: 'Cat #5', image: 'ipfs://Qm/5.png', description: 'meow' }] },
      '0:CC': { token_info: [{ type: 'nft_collections', name: 'Cats' }] },
      '0:DD': { token_info: [{ type: 'nft_items', name: 'Get 1000 TON reward at t.me/x', is_scam: true }] },
    },
  });
  assert.deepEqual(items[0], { key: '0:AA', address: '0:AA', contract: '0:CC', tokenId: '5', name: 'Cat #5', collection: 'Cats', image: 'https://ipfs.io/ipfs/Qm/5.png', description: 'meow', traits: [], standard: 'TEP-62', amount: '1', spam: false, onSale: true });
  assert.equal(items[1].name, 'Cats #6');
  assert.equal(items[1].image, null);
  assert.equal(items[2].spam, true);
});

test('fakes of famous collections: the name and few holders', () => {
  assert.equal(fakeBrand('BAYC Otherside Land', '3'), true);
  assert.equal(fakeBrand('PATEK PHILIPPE', '0'), true);
  assert.equal(fakeBrand('Bored Ape Yacht Club', '5800'), false, 'the real one');
  assert.equal(fakeBrand('Nintendo', null), true, 'holders unknown: the name is enough');
  assert.equal(fakeBrand('Garbage Friends', '1'), false, 'a small collection is not spam');
  assert.equal(fromBlockscout([{ id: '1', token: { address_hash: X, name: 'Mercedes Benz', holders_count: '37', reputation: 'ok' } }])[0].spam, true);
});

test('traits: OpenSea-style attributes, dates readable, junk left out', () => {
  assert.deepEqual(traitsOf([{ trait_type: 'Expires', display_type: 'date', value: 1801481255 }, { trait_type: 'Eyes', value: 'Laser' }, { value: 3 }, null, { trait_type: 'x', value: [1] }]),
    [{ trait: 'Expires', value: '2027-02-01' }, { trait: 'Eyes', value: 'Laser' }, { trait: '', value: '3' }]);
  assert.deepEqual(traitsOf('nope'), []);
});

// Seen in a real wallet, shown as normal NFTs before (TON item 0:B484…, Polygon 0xca26…, 0x00d1…)
test('spam NFTs seen in a real wallet: domains, $tickers, bait, TonAPI\'s scam list, orphan items', () => {
  assert.equal(spamNft('', '🎁 Bonus at 3eth.us', { symbol: 'Reward at [3eth.us]' }), true, 'a domain the old list missed (.us)');
  assert.equal(spamNft('', 'A PUDGY PENGUIN', { symbol: '$PENGU' }), true, 'a $TICKER, airdropped to thousands');
  assert.equal(spamNft('$HMSTR Reward Holder', ''), true);
  assert.equal(spamNft('Pass #3', 'Club', { description: 'Activate voucher on the website' }), true, 'bait in the description');
  // ... and what must stay: name-service domains, ordinary names, a real link in a description without bait
  assert.equal(hasDomain('vitalik.eth alice.ton x.wei'), false);
  assert.equal(hasDomain('3eth.us'), true);
  assert.equal(spamNft('vitalik.eth', 'ENS: Ethereum Name Service'), false);
  assert.equal(spamNft('vitalik.cloud', 'NamefiNFT'), false, 'a domain-name NFT: the name is the domain');
  assert.equal(spamNft('', 'yearn Gift NFT'), false);
  assert.equal(spamNft('Fox #77', 'Paper Foxes', { symbol: 'FOX', description: 'Made by the studio, see https://foxes.art' }), false);
  assert.equal(spamNft('Pudgy Penguin #12', 'Pudgy Penguins', { symbol: 'PPG' }), false, 'the real collection (its name alone is no spam)');
  const items = tonNftItems(
    { nft_items: [
      { address: '0:B4844691C84C51ADDEB07F3120F7CEFD3547C047174075B8143252AD33FDF8B7', index: '0', collection_address: null },
      { address: '0:AA', index: '1', collection_address: '0:CC' },
      { address: '0:DD', index: '2', collection_address: null },
      { address: '0:EE', index: '3', collection_address: '0:CC' },
    ], metadata: { '0:CC': { token_info: [{ type: 'nft_collections', name: 'Cats' }] } } },
    {
      '0:B4844691C84C51ADDEB07F3120F7CEFD3547C047174075B8143252AD33FDF8B7': { trust: 'blacklist', name: '$HMSTR Reward Holder', description: 'Activate voucher on the website' },
      '0:AA': { trust: 'whitelist', name: 'Cat #1', image: 'https://cache.tonapi.io/x.png' },
      '0:DD': { trust: 'whitelist', name: 'Standalone art' },
      '0:EE': { trust: 'blacklist' },
    },
  );
  assert.deepEqual(items.map((x) => [x.name, x.spam]), [['$HMSTR Reward Holder', true], ['Cat #1', false], ['Standalone art', false], ['Cats #3', true]]);
  assert.equal(items[1].image, 'https://cache.tonapi.io/x.png', 'TonAPI\'s cached preview when TON Center has no image');
  assert.equal(tonNftItems({ nft_items: [{ address: '0:FF', index: '0', collection_address: null }] })[0].spam, true, 'outside any collection, unrated');
});
