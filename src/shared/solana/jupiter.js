// Jupiter's free API (token list, prices, swaps) allows 5 requests every 10 seconds from one address: every call of
// the app goes through here, a few at a time, and a refused one ("too many requests") waits for the next window
// (the answer says when: x-ratelimit-reset, in seconds) and is tried again.
import { ENDPOINTS } from '../endpoints.js';

const PER_WINDOW = 5, WINDOW = 10_000;
const sent = []; // times of the latest requests
let chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a free place in the window (requests leave in order). */
function slot() {
  const next = chain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sent.length && now - sent[0] >= WINDOW) sent.shift();
      if (sent.length < PER_WINDOW) { sent.push(now); return; }
      await sleep(sent[0] + WINDOW - now + 50);
    }
  });
  chain = next.catch(() => {});
  return next;
}

/** fetch() of a Jupiter path, within the limit; throws after a few refusals in a row. */
export async function jupFetch(path, init = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await slot();
    const res = await fetch(`${ENDPOINTS.jupiter}${path}`, { ...init, signal: AbortSignal.timeout(20000) });
    if (res.status !== 429) return res;
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    // the window is full (others' requests count too): no more from here until it resets
    const wait = reset > Date.now() ? reset - Date.now() + 300 : 2000 * (attempt + 1);
    const until = Date.now() + Math.min(wait, WINDOW + 1000);
    for (let i = 0; i < PER_WINDOW; i++) sent.push(until - WINDOW);
    sent.sort((a, b) => a - b);
  }
  throw new Error('Jupiter: too many requests, try again shortly');
}
