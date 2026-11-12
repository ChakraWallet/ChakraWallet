import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { tonJettons, llamaKey } from '../src/shared/ton/api.js';

const HMSTR = Address.parse('EQAJ8uWd7EBqsmpSWaRdf_I-8R8-XHwh3gsNKhy-UrdrPcUo');
const USDT = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
const raw = (a) => a.toRawString().toUpperCase(); // TON Center's form
const json = (o) => new Response(JSON.stringify(o), { status: 200 });

test('jetton without a STON.fi price (HMSTR) takes the DefiLlama one', async () => {
  const llamaCalls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/v3/jetton/wallets')) {
      return json({ jetton_wallets: [
        { address: '0:' + 'AA'.repeat(32), balance: '5000000000000', jetton: raw(HMSTR) },
        { address: '0:' + 'BB'.repeat(32), balance: '2500000', jetton: raw(USDT) },
      ] });
    }
    if (u.includes('/api/v3/metadata')) {
      return json({
        [raw(HMSTR)]: { token_info: [{ type: 'jetton_masters', name: 'Hamster Kombat', symbol: 'HMSTR', extra: { decimals: '9' } }] },
        [raw(USDT)]: { token_info: [{ type: 'jetton_masters', name: 'Tether USD', symbol: 'USD₮', extra: { decimals: '6' } }] },
      });
    }
    if (u.includes('api.ston.fi/v1/assets/')) {
      const isHmstr = u.endsWith(HMSTR.toString({ urlSafe: true, bounceable: true }));
      return json({ asset: isHmstr
        ? { symbol: 'HMSTR', decimals: 9, dex_usd_price: null, third_party_usd_price: null, tags: ['low_liquidity'] }
        : { symbol: 'USD₮', decimals: 6, dex_usd_price: '1.0' } });
    }
    if (u.includes('coins.llama.fi/prices/current/')) {
      llamaCalls.push(u);
      return json({ coins: { [llamaKey(raw(HMSTR))]: { price: 0.000134, confidence: 0.99 } } });
    }
    throw new Error(`unexpected ${u}`);
  };
  try {
    const list = await tonJettons({ id: -239, api: 'https://toncenter.com', testnet: false }, '0:' + '11'.repeat(32));
    const h = list.find((j) => j.symbol === 'HMSTR'), u = list.find((j) => j.symbol === 'USD₮');
    assert.equal(h.price, 0.000134);
    assert.ok(Math.abs(h.usd - 5000 * 0.000134) < 1e-9);
    assert.equal(u.price, 1);
    assert.equal(u.usd, 2.5);
    // only the jetton STON.fi couldn't price goes to DefiLlama, with the key it recognises
    assert.equal(llamaCalls.length, 1);
    assert.ok(llamaCalls[0].includes(encodeURI(`ton:${HMSTR.toString({ urlSafe: true, bounceable: true })}`)) || llamaCalls[0].includes(`ton:${HMSTR.toString({ urlSafe: true, bounceable: true })}`));
    assert.ok(!llamaCalls[0].includes(USDT.toString({ urlSafe: true, bounceable: true })));
  } finally {
    globalThis.fetch = orig;
  }
});
