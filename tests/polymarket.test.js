// Polymarket markets from Gamma: outcome ids of CTF (v1) and Protocol V2 markets (shapes copied from gamma-api /markets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normMarket } from '../src/shared/polymarket.js';
import { isV3Token, exchangeFor, positionsContractFor, C } from '../src/shared/polytrade.js';

// a Protocol V2 test market published on Gamma (NYC highest temperature)
const V2_YES = '944412068274729391445398613530435636018762177453597551650732970930727813120';
const V2_NO = '944412068274729391445398613530435636018762177453597551650732970930727813121';
const CTF_UP = '64207968034670138199358745593924972090421434716355841357045163316543862811393';
const CTF_DOWN = '55418511080416011078269734223992964142248251554828599457839875517681155989937';

test('v1 market: outcome ids from clobTokenIds (JSON text)', () => {
  const m = normMarket({ id: 1, version: 'v1', outcomes: '["Up", "Down"]', outcomePrices: '["0.5", "0.5"]', clobTokenIds: JSON.stringify([CTF_UP, CTF_DOWN]) });
  assert.deepEqual(m.outcomes.map((o) => o.token), [CTF_UP, CTF_DOWN]);
});

test('v2 market: outcome ids from positionIds, even when clobTokenIds is there too', () => {
  const m = normMarket({ id: 2, version: 'v2', outcomes: '["Yes", "No"]', outcomePrices: '["0.3", "0.7"]', positionIds: [V2_YES, V2_NO], clobTokenIds: JSON.stringify(['1', '2']) });
  assert.deepEqual(m.outcomes.map((o) => o.token), [V2_YES, V2_NO]);
  // and these ids route to the V2 contracts: ExchangeV3 (also for neg-risk markets) and PositionManager
  assert.equal(isV3Token(m.outcomes[0].token), true);
  assert.equal(exchangeFor(m.outcomes[0].token, true), C.exchangeV3);
  assert.equal(positionsContractFor(m.outcomes[1].token), C.positionManager);
});

test('v2 market without positionIds falls back to clobTokenIds; markets without a version are v1', () => {
  assert.deepEqual(normMarket({ id: 3, version: 'v2', outcomes: '["Yes", "No"]', clobTokenIds: JSON.stringify([V2_YES, V2_NO]) }).outcomes.map((o) => o.token), [V2_YES, V2_NO]);
  assert.deepEqual(normMarket({ id: 4, outcomes: '["Yes", "No"]', positionIds: [V2_YES, V2_NO], clobTokenIds: JSON.stringify([CTF_UP, CTF_DOWN]) }).outcomes.map((o) => o.token), [CTF_UP, CTF_DOWN]);
});
