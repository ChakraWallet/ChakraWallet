import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChainEnabled } from '../src/shared/chains.js';

test('networks switched off in Settings; Ethereum is always on', () => {
  const s = { disabledChains: [137, 1] };
  assert.equal(isChainEnabled(137, s), false);
  assert.equal(isChainEnabled('137', s), false);
  assert.equal(isChainEnabled(8453, s), true);
  assert.equal(isChainEnabled(1, s), true);
  assert.equal(isChainEnabled(137, {}), true);
  assert.equal(isChainEnabled(137, undefined), true);
});
