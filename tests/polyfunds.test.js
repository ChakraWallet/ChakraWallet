// Polymarket funds shown in the wallet: strict reading (any failure -> nothing) and no double counting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openValueOf } from '../src/shared/polymarket.js';
import { polyFundsOf } from '../src/ui/polyBalance.js';

const OWN = '0x1111111111111111111111111111111111111111';
const PROXY = '0x2222222222222222222222222222222222222222';
const pos = (value, size = 10) => ({ current_value: value, current_size: size, token_id: 't' + value });

/** routes: { profile: status | body, [user]: status | positions[] } */
function mockPolymarket(routes) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const key = u.pathname.includes('public-profile') ? 'profile' : u.searchParams.get('user');
    seen.push(key);
    const r = routes[key];
    if (typeof r === 'number') return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  return seen;
}

test('separate Polymarket account: positions of both, proxy returned for its cash', async () => {
  const seen = mockPolymarket({ profile: { proxyWallet: PROXY.toUpperCase().replace('0X', '0x') }, [OWN]: [pos(3)], [PROXY]: [pos(10), pos(2.5), pos(7, 0)] });
  const r = await openValueOf(OWN);
  assert.equal(r.proxy, PROXY);
  assert.equal(r.value, 15.5, 'positions with size 0 are not counted');
  assert.deepEqual(seen.sort(), [OWN, PROXY, 'profile'].sort());
});

test('no Polymarket account (404): only the address itself, no proxy', async () => {
  const seen = mockPolymarket({ profile: 404, [OWN]: [pos(4)] });
  assert.deepEqual(await openValueOf(OWN), { proxy: null, value: 4 });
  assert.deepEqual(seen, ['profile', OWN]);
});

test('profile pointing to the address itself: no separate account', async () => {
  mockPolymarket({ profile: { proxyWallet: OWN }, [OWN]: [] });
  assert.deepEqual(await openValueOf(OWN), { proxy: null, value: 0 });
});

test('strict: a blocked or failing request rejects instead of giving a partial figure', async () => {
  mockPolymarket({ profile: 403 });
  await assert.rejects(openValueOf(OWN), /Polymarket 403/);
  mockPolymarket({ profile: { proxyWallet: PROXY }, [OWN]: [pos(1)], [PROXY]: 403 });
  await assert.rejects(openValueOf(OWN), /Polymarket 403/);
});

test('what is shown: cash + positions, nothing below a cent', () => {
  assert.deepEqual(polyFundsOf(12.5, 7.5), { cash: 12.5, positions: 7.5, total: 20 });
  assert.deepEqual(polyFundsOf(0, 3), { cash: 0, positions: 3, total: 3 });
  assert.equal(polyFundsOf(0, 0), null);
  assert.equal(polyFundsOf(0.004, 0.004), null);
  assert.equal(polyFundsOf(NaN, -1), null);
});
