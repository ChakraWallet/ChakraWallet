// "Per te" ranking: the taste profile and the mix of the feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile, bump, markSeen, topTags, affinity, pickNext, usefulTags, WEIGHTS, HALF_LIFE } from '../src/shared/recommend.js';

const ev = (id, tagSlugs, vol = 1e5) => ({ id: String(id), tagSlugs, tags: tagSlugs.map((s) => s.toUpperCase()), volume24h: vol });
const DAY = 864e5, now = 1_800_000_000_000;

test('noise tags are ignored', () => {
  assert.deepEqual(usefulTags(ev(1, ['sports', 'recurring', 'earn-4', 'nba', 'games', 'parent-for-derivative'])), ['sports', 'nba']);
});

test('interactions build interests that fade with time', () => {
  let p = emptyProfile();
  p = bump(p, ev(1, ['sports', 'tennis']), WEIGHTS.trade, now);
  p = bump(p, ev(2, ['politics']), WEIGHTS.dwell, now);
  const top = topTags(p, 3, now);
  assert.deepEqual(top.map((x) => x.slug).slice(0, 2).sort(), ['sports', 'tennis']);
  assert.equal(top[0].label, top[0].slug.toUpperCase()); // readable label kept
  const later = topTags(p, 3, now + HALF_LIFE);
  assert.ok(Math.abs(later[0].score - top[0].score / 2) < 1e-9, 'half after the half-life');
  // a quick skip lowers the interest
  const before = affinity(p, ev(9, ['tennis']), now).value;
  const after = affinity(bump(p, ev(3, ['tennis']), WEIGHTS.skip, now), ev(9, ['tennis']), now).value;
  assert.ok(after < before);
});

test('feed mix: interests first, exploration every 5th card, no same subject twice in a row, no repeats', () => {
  let p = emptyProfile();
  for (let i = 0; i < 4; i++) p = bump(p, ev(100 + i, ['sports', 'tennis']), WEIGHTS.details, now);
  const cands = [
    ...[1, 2, 3, 4, 5, 6].map((i) => ({ ev: ev(i, ['sports', 'tennis'], 2e4), source: 'interest' })),
    ...[11, 12, 13, 14].map((i) => ({ ev: ev(i, ['politics', 'elections'], 5e6), source: 'trend' })),
    ...[21, 22].map((i) => ({ ev: ev(i, ['crypto'], 1e5), source: 'explore' })),
  ];
  const cats = ['sports', 'politics', 'crypto'];
  const out = pickNext(p, cands, 8, { cats, now, rnd: () => 0.5 });
  assert.equal(out.length, 8);
  assert.equal(out[0].reason.kind, 'interest');
  assert.equal(out[0].reason.label, 'TENNIS');
  assert.equal(out[4].reason.kind, 'explore');
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1].ev.tagSlugs[0], b = out[i].ev.tagSlugs[0];
    assert.ok(a !== b, `cards ${i - 1} and ${i} share "${a}"`);
  }
  assert.equal(new Set(out.map((x) => x.ev.id)).size, 8);
  // shown events are skipped next time
  const seen = out.reduce((q, x) => markSeen(q, x.ev.id, now), p);
  assert.ok(pickNext(seen, cands, 10, { cats, now }).every((x) => !out.some((o) => o.ev.id === x.ev.id)));
});

test('empty profile: trends, mixed', () => {
  const cands = [1, 2, 3].map((i) => ({ ev: ev(i, ['sports'], 10 ** (i + 3)), source: 'trend' })).concat([{ ev: ev(9, ['tech'], 1e3), source: 'explore' }]);
  const out = pickNext(emptyProfile(), cands, 3, { cats: ['sports', 'tech'], now, rnd: () => 0 });
  assert.equal(out[0].ev.id, '3'); // the most traded first
  assert.equal(out[0].reason.kind, 'trend');
  assert.equal(out[1].ev.tagSlugs[0], 'tech'); // then something else, not sports twice
});
