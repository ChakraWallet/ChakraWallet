// Amounts in the display currency: the short symbol in every language, thousands grouped, short forms for tags.
import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtUsdShort } from '../src/shared/format.js';
import { setLang } from '../src/shared/i18n.js';

const nb = (s) => s.replace(/[  ]/g, ' '); // Intl's (narrow) no-break spaces

test('Italian: $ (not USD), thousands grouped, short forms with decimals', () => {
  setLang('it');
  assert.equal(nb(fmtUsd(1433.28)), '1.433,28 $');
  assert.equal(nb(fmtUsd(30564.5)), '30.564,50 $');
  assert.deepEqual([0.5, 14.33, 218.4, 1433.28, 14330, 107520, 2450000].map((v) => nb(fmtUsdShort(v))),
    ['0,50 $', '14,33 $', '218,40 $', '1,43K $', '14,33K $', '107,52K $', '2,45 Mln $']);
  assert.equal(nb(fmtUsdShort(1450)), '1,45K $');
});

test('English: the same in its own way', () => {
  setLang('en');
  assert.equal(fmtUsd(1433.28), '$1,433.28');
  assert.deepEqual([218.4, 1450, 107520, 2450000].map(fmtUsdShort), ['$218.40', '$1.45K', '$107.52K', '$2.45M']);
});
