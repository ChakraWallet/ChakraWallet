// "Per te" suggestions: a small taste profile kept on the device (one per account) and the ranking of the feed.
// Pure functions (no storage, no network) so they can be unit-tested; the UI loads / saves the profile and feeds it
// the signals (see ui/predictTaste.js).
//
// Profile: interest per Polymarket tag (slug), each score decaying with time (half-life ~2 weeks), plus the events
// already shown (pushed down for a few days). Ranking: popularity + affinity with the profile + a pinch of
// randomness; then the mix: about 1 card in 5 explores other categories, now and then a pure trend, never two cards
// of the same main tag in a row.

export const HALF_LIFE = 14 * 864e5;
const SEEN_FOR = 3 * 864e5;
const MAX_TAGS = 200, MAX_SEEN = 600;

/** How much each interaction tells about the user's taste. */
export const WEIGHTS = {
  trade: 5,       // placed an order on the event
  position: 3,    // the event is in the Polymarket history (open position)
  closed: 2,      // ... or a closed one
  buyTap: 2.5,    // tapped Yes / No (even without buying)
  save: 3,        // saved the event to keep an eye on it
  unsave: -1,     // removed it from the saved ones
  details: 1.5,   // opened the event from the feed
  open: 0.8,      // opened the event from the list / search
  dwell: 0.6,     // stayed on the card for a while
  category: 0.5,  // picked a category on the home
  skip: -0.4,     // swiped it away at once
};

// tags that say nothing about the subject
const NOISE = /^(earn-|recurring$|parent-for|hide|featured$|all$|main-election$|games$|new$|trending$|breaking)/;
export const usefulTags = (ev) => (ev?.tagSlugs || []).filter((s) => s && !NOISE.test(String(s).toLowerCase()));

export const emptyProfile = () => ({ v: 1, tags: {}, labels: {}, seen: {}, seededAt: 0 });

const decayed = (x, now) => (x ? x.s * 0.5 ** ((now - x.t) / HALF_LIFE) : 0);

/** Adds an interaction with an event (or a list of tag slugs) to the profile. Returns a new profile. */
export function bump(profile, evOrTags, weight, now = Date.now()) {
  const p = { ...profile, tags: { ...profile.tags }, labels: { ...profile.labels } };
  const slugs = Array.isArray(evOrTags) ? evOrTags : usefulTags(evOrTags);
  if (!slugs.length) return p;
  if (!Array.isArray(evOrTags)) (evOrTags.tagSlugs || []).forEach((s, i) => { if (evOrTags.tags?.[i]) p.labels[s] = evOrTags.tags[i]; });
  const share = weight / Math.sqrt(slugs.length); // an event with many tags spreads its weight
  for (const s of slugs) {
    const v = Math.max(-5, Math.min(60, decayed(p.tags[s], now) + share));
    p.tags[s] = { s: v, t: now };
  }
  const keys = Object.keys(p.tags);
  if (keys.length > MAX_TAGS) { // keep the strongest
    keys.sort((a, b) => Math.abs(decayed(p.tags[b], now)) - Math.abs(decayed(p.tags[a], now)));
    for (const k of keys.slice(MAX_TAGS)) delete p.tags[k];
  }
  return p;
}

export function markSeen(profile, id, now = Date.now()) {
  const seen = { ...profile.seen, [id]: now };
  for (const [k, t] of Object.entries(seen)) if (now - t > SEEN_FOR) delete seen[k];
  const ids = Object.keys(seen);
  if (ids.length > MAX_SEEN) ids.sort((a, b) => seen[a] - seen[b]).slice(0, ids.length - MAX_SEEN).forEach((k) => delete seen[k]);
  return { ...profile, seen };
}

/** The user's strongest interests: [{ slug, score, label }]. */
export function topTags(profile, n = 3, now = Date.now()) {
  return Object.entries(profile.tags)
    .map(([slug, x]) => ({ slug, score: decayed(x, now), label: profile.labels[slug] || slug }))
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/** Affinity of an event with the profile, 0..1, and the tag that matches best. */
export function affinity(profile, ev, now = Date.now()) {
  let best = null, bestScore = 0, sum = 0;
  for (const s of usefulTags(ev)) {
    const v = decayed(profile.tags[s], now);
    sum += v;
    if (v > bestScore) { bestScore = v; best = s; }
  }
  const raw = bestScore + 0.3 * (sum - bestScore);
  return { value: raw > 0 ? 1 - Math.exp(-raw / 4) : Math.max(-0.5, raw / 10), tag: best };
}

/** Popularity of an event, 0..1 (24h volume, log scale: $10M a day ≈ 1). */
export const popularity = (ev) => Math.max(0, Math.min(1, Math.log10(1 + (ev.volume24h || 0)) / 7));

/** Ranking score: popularity, affinity (once the profile says something), freshness, randomness. */
export function score(profile, ev, now = Date.now(), rnd = Math.random, jitter = 0.12) {
  const hasTaste = topTags(profile, 1, now).length > 0;
  const a = affinity(profile, ev, now).value;
  const seen = profile.seen[ev.id] ? 0.6 : 0;
  return (hasTaste ? 0.4 : 0.85) * popularity(ev) + (hasTaste ? 0.6 : 0) * a + jitter * rnd() - seen;
}

/** The interest to name on a card: the strongest one, but a specific tag (Tennis) beats a broad one (Sports) when close. */
function reasonTag(profile, ev, cats, now) {
  const ranked = usefulTags(ev).map((s) => [s, decayed(profile.tags[s], now)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const close = ranked.filter(([, v]) => v >= ranked[0][1] * 0.8);
  return (close.find(([s]) => !cats.includes(s)) || ranked[0])[0];
}

/** The broad subject of an event (its first category-like tag), to avoid two in a row. */
export const mainTag = (ev, cats = []) => usefulTags(ev).find((s) => cats.includes(s)) || usefulTags(ev)[0] || '';

/**
 * Picks the next `n` cards from the candidates. Each candidate: { ev, source: 'trend' | 'interest' | 'explore' }.
 * Returns [{ ev, reason: { kind: 'interest', tag, label } | { kind: 'trend' } | { kind: 'explore' } }] and leaves the
 * rest. Slots: every 5th card explores, every 7th is the most popular trend; otherwise the best score.
 */
export function pickNext(profile, candidates, n, { start = 0, cats = [], lastTag = '', now = Date.now(), rnd = Math.random, jitter = 0.12 } = {}) {
  const pool = candidates.filter((c) => c.ev && !c.ev.closed && !profile.seen[c.ev.id]);
  const scored = pool.map((c) => ({ ...c, s: score(profile, c.ev, now, rnd, jitter) }));
  const out = [];
  let prev = lastTag;
  for (let k = 0; k < n && scored.length; k++) {
    const pos = start + k;
    const want = pos > 0 && pos % 5 === 4 ? 'explore' : pos % 7 === 3 ? 'trend' : null;
    const order = [...scored].sort((a, b) => (want === 'trend' ? popularity(b.ev) - popularity(a.ev) : b.s - a.s));
    const fits = (c) => mainTag(c.ev, cats) !== prev || !prev;
    const pick = (want && order.find((c) => c.source === want && fits(c))) || order.find(fits) || order[0];
    scored.splice(scored.indexOf(pick), 1);
    prev = mainTag(pick.ev, cats);
    const aff = affinity(profile, pick.ev, now);
    const tag = aff.tag && reasonTag(profile, pick.ev, cats, now);
    const reason = pick.source === 'explore' ? { kind: 'explore' }
      : tag && aff.value > 0.15 ? { kind: 'interest', tag, label: profile.labels[tag] || tag }
        : { kind: 'trend' };
    out.push({ ev: pick.ev, reason });
  }
  return out;
}
