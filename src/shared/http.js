// JSON GET for public indexers: one automatic retry on temporary failures (HTTP 5xx / 429, network errors,
// timeouts), so a sporadic error of an overloaded public service doesn't reach the user. 404 -> null.
// With `body` it's a POST of that JSON (read-only queries that take a list, e.g. tiers of several addresses).
const RETRYABLE = (s) => s === 429 || s >= 500;

export async function getJson(url, { timeout = 25000, retries = 1, label = 'HTTP', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, body === undefined
        ? { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) }
        : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      if (res.status === 404) return null;
      if (!res.ok) {
        const e = new Error(`${label} ${res.status}`);
        e.retryable = RETRYABLE(res.status);
        throw e;
      }
      return await res.json();
    } catch (e) {
      const retryable = e.retryable ?? true; // network error / timeout
      if (attempt >= retries || !retryable) throw e.name === 'TimeoutError' ? Object.assign(new Error(`${label} timeout ${timeout / 1000}s`), { retryable: true }) : e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}
