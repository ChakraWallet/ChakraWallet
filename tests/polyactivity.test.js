// Polymarket history and rebates: activity rows (shapes copied from data-api /v2/activity) and the rebate tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normActivity, placeInTiers, tierTable, TIER_SWITCH, INCOME_TYPES } from '../src/shared/polymarket.js';

const BEFORE = TIER_SWITCH - 1, AFTER = TIER_SWITCH + 1;
const row = (o) => ({ proxy_wallet: '0x5bfd', timestamp: 1794326148, condition_id: '', type: 'TRADE', size: 0, usdc_size: 0, transaction_hash: '0xabc', price: 0, token_id: '', side: '', outcome_index: 999, title: '', slug: '', icon: '', event_slug: '', outcome: '', ...o });

test('activity: a sale brings cash in, a buy takes it out', () => {
  const sell = normActivity(row({ type: 'TRADE', side: 'SELL', size: 10.5, usdc_size: 2.89367, price: 0.29, title: 'Bitcoin Up or Down', event_slug: 'btc-updown-5m-1794326100', slug: 'btc-updown-5m-1794326100', outcome: 'Up' }));
  assert.deepEqual([sell.type, sell.side, sell.flow, sell.usd, sell.shares, sell.price, sell.at], ['TRADE', 'SELL', 1, 2.89367, 10.5, 0.29, 1794326148000]);
  assert.equal(sell.slug, 'btc-updown-5m-1794326100');
  assert.equal(normActivity(row({ condition_id: '0x56e7' })).market, '0x56e7', 'market, to group a day by it');
  assert.equal(sell.income, false);
  assert.equal(normActivity(row({ type: 'TRADE', side: 'BUY', usdc_size: 4.3764 })).flow, -1);
});

test('activity: maker and taker rebates stay apart, as income without a market', () => {
  const maker = normActivity(row({ type: 'MAKER_REBATE', size: 5431.6261, usdc_size: 5431.6261 }));
  const taker = normActivity(row({ type: 'TAKER_REBATE', size: 7500, usdc_size: 7500 }));
  assert.deepEqual([maker.type, maker.flow, maker.usd, maker.income, maker.title, maker.price], ['MAKER_REBATE', 1, 5431.6261, true, '', null]);
  assert.deepEqual([taker.type, taker.flow, taker.usd, taker.income], ['TAKER_REBATE', 1, 7500, true]);
  for (const type of INCOME_TYPES) assert.equal(normActivity(row({ type })).income, true, type);
});

test('activity: deposits in, withdrawals and splits out, conversions move no cash', () => {
  assert.equal(normActivity(row({ type: 'DEPOSIT', usdc_size: 50 })).flow, 1);
  assert.equal(normActivity(row({ type: 'WITHDRAWAL', usdc_size: 50 })).flow, -1);
  assert.equal(normActivity(row({ type: 'SPLIT', usdc_size: 5 })).flow, -1);
  assert.equal(normActivity(row({ type: 'MERGE', usdc_size: 5 })).flow, 1);
  assert.equal(normActivity(row({ type: 'REDEEM', usdc_size: 5 })).flow, 1);
  assert.equal(normActivity(row({ type: 'CONVERSION', usdc_size: 5 })).flow, 0);
  assert.equal(normActivity(row({ timestamp: 1794326148123 })).at, 1794326148123, 'already in ms');
});

test('tiers: the ladder in force before and after the 20 Nov 2026 change', () => {
  assert.deepEqual(tierTable('taker', BEFORE).map((x) => x.name), ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Obsidian']);
  assert.deepEqual(tierTable('taker', AFTER).map((x) => [x.name, x.rate]), [['None', 0], ['Gold', 10], ['Platinum', 25], ['Diamond', 40], ['Obsidian', 50], ['Onyx', 60]]);
  assert.equal(tierTable('maker', BEFORE), null, 'daily pools, no maker tiers yet');
  assert.deepEqual(tierTable('maker', AFTER).map((x) => x.rate), [0, 3, 7, 10, 15]);
});

test('tiers: Polymarket\'s name decides, the table adds rate and next step', () => {
  const zero = placeInTiers(tierTable('taker', BEFORE), { name: 'Tier 0', volume: 620.23 });
  assert.deepEqual([zero.none, zero.rate, zero.next.name, zero.next.min, zero.next.rate], [true, 0, 'Bronze', 2000, 3]);
  const diamond = placeInTiers(tierTable('taker', AFTER), { name: 'Diamond', volume: 4185344 });
  assert.deepEqual([diamond.name, diamond.rate, diamond.next.name], ['Diamond', 40, 'Obsidian']);
  // the volume may lag the tier: the next step follows the tier, not the volume
  assert.equal(placeInTiers(tierTable('taker', AFTER), { name: 'Obsidian', volume: 3345104 }).next.name, 'Onyx');
  assert.equal(placeInTiers(tierTable('taker', AFTER), { name: 'Onyx', volume: 8e7 }).next, null, 'top tier');
  // Bronze is gone after the change: an unknown name is kept as it is, without a rate
  const old = placeInTiers(tierTable('taker', AFTER), { name: 'Bronze', volume: 5000 });
  assert.deepEqual([old.name, old.rate, old.none, old.next.name], ['Bronze', null, false, 'Gold']);
  const maker = placeInTiers(tierTable('maker', AFTER), { name: 'Tier 2', volume: 1.5e6 });
  assert.deepEqual([maker.rate, maker.next.name, maker.next.rate], [7, 'Tier 3', 10]);
  assert.equal(placeInTiers(null, { name: 'Tier 0', volume: 0 }).none, false, 'no ladder: nothing to place on');
});
