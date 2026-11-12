// "Per te": the taste profile of each account (kept only on this device) and the feed built from it.
// Signals come from the feed cards, the event page, orders and the categories picked on the home; the Polymarket
// history seeds the profile from day one. The ranking itself is in shared/recommend.js.
import { local } from '../shared/ext.js';
import { CATEGORIES, listEvents, positions, getEvent } from '../shared/polymarket.js';
import { emptyProfile, bump, markSeen, topTags, pickNext, mainTag, WEIGHTS } from '../shared/recommend.js';

const key = (address) => `predictTaste:${String(address || '').toLowerCase()}`;
const cache = new Map(); // address -> profile
const timers = new Map();

async function load(address) {
  const k = key(address);
  if (!cache.has(k)) cache.set(k, { ...emptyProfile(), ...(await local.get(k, null) || {}) });
  return cache.get(k);
}
function save(address, profile) {
  const k = key(address);
  cache.set(k, profile);
  clearTimeout(timers.get(k)); // a few writes per swipe at most: batch them
  timers.set(k, setTimeout(() => local.set(k, profile).catch(() => {}), 1500));
}

/** An interaction with an event: kind is one of WEIGHTS (trade, buyTap, details, open, dwell, skip...). */
export async function signal(address, ev, kind) {
  if (!address || !ev || WEIGHTS[kind] == null) return;
  save(address, bump(await load(address), ev, WEIGHTS[kind]));
}
/** A category chosen on the home (its tag slug). */
export async function signalCategory(address, slug) {
  if (!address || !slug || slug === 'trending' || slug === 'new') return;
  save(address, bump(await load(address), [slug], WEIGHTS.category));
}
export async function seen(address, id) { if (address && id) save(address, markSeen(await load(address), id)); }
export async function resetTaste(address) {
  const k = key(address);
  clearTimeout(timers.get(k));
  cache.set(k, emptyProfile()); // seededAt = 0: history and saved items rebuild the basics at the next opening
  await local.remove(k);
}

const eventCache = new Map();
const eventOf = (slug) => (eventCache.has(slug) ? eventCache.get(slug) : eventCache.set(slug, getEvent(slug).catch(() => null)).get(slug));

/** First taste from the Polymarket history (open and closed positions), refreshed twice a day. */
async function seedFromHistory(address) {
  let p = await load(address);
  if (Date.now() - (p.seededAt || 0) < 12 * 3600e3) return;
  const [open, closed, saved] = await Promise.all([
    positions(address, 'OPEN').catch(() => []), positions(address, 'CLOSED').catch(() => []),
    local.get(`predictSaved:${String(address).toLowerCase()}`, []), // saved items count too (also after a reset)
  ]);
  const slugs = [...new Map([...saved.map((x) => [x.slug, 'save']), ...closed.map((x) => [x.slug, 'closed']), ...open.map((x) => [x.slug, 'position'])].filter(([s]) => s)).entries()].slice(0, 30);
  const events = await Promise.all(slugs.map(([s]) => eventOf(s)));
  p = await load(address); // may have changed meanwhile
  events.forEach((ev, i) => { if (ev) p = bump(p, ev, WEIGHTS[slugs[i][1]]); });
  save(address, { ...p, seededAt: Date.now() });
}

const BROAD = CATEGORIES.filter((c) => c !== 'trending' && c !== 'new');

/**
 * The "Per te" feed of an account: next(n) gives the next n events (each with ev._reason), ranked with the
 * profile as it is at that moment, so what you do on the cards already changes the following ones.
 */
export function createFeed(address) {
  const pool = new Map(); // id -> { ev, source }
  const cursors = {}; // source key -> cursor | null when finished
  let shown = 0, lastTag = '', seeded = null, explored = [];
  const add = (events, source) => events.forEach((ev) => { if (!pool.has(ev.id)) pool.set(ev.id, { ev, source }); });
  const page = async (k, category, source) => {
    if (cursors[k] === null) return;
    const r = await listEvents({ category, cursor: cursors[k] }).catch(() => ({ events: [], next: undefined }));
    cursors[k] = r.next || null;
    add(r.events, source);
  };
  async function refill(profile) {
    const top = topTags(profile, 2);
    if (!explored.length) explored = BROAD.filter((c) => !top.some((x) => x.slug === c)).sort(() => Math.random() - 0.5);
    const cat = explored.shift();
    await Promise.all([
      page('trend', 'trending', 'trend'),
      ...top.map((x) => page(`tag:${x.slug}`, x.slug, 'interest')),
      cat ? page(`cat:${cat}`, cat, 'explore') : null,
    ]);
  }
  return {
    async next(n = 6) {
      seeded ??= Promise.race([seedFromHistory(address).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      await seeded;
      for (let tries = 0; tries < 3; tries++) {
        const profile = await load(address);
        const fresh = [...pool.values()].filter((c) => !profile.seen[c.ev.id]);
        if (fresh.length >= n + 8 || Object.keys(cursors).length && Object.values(cursors).every((c) => c === null)) break;
        await refill(profile);
      }
      const profile = await load(address);
      // a good shake on every opening: each visit starts differently, the profile still leads
      const out = pickNext(profile, [...pool.values()], n, { start: shown, cats: CATEGORIES, lastTag, jitter: 0.3 });
      out.forEach((x) => pool.delete(x.ev.id));
      shown += out.length;
      if (out.length) lastTag = mainTag(out[out.length - 1].ev, CATEGORIES);
      return out.map((x) => ({ ...x.ev, _reason: x.reason }));
    },
  };
}
