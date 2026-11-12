// JSON GET for public indexers: one automatic retry on temporary failures (HTTP 5xx / 429, network errors,
// timeouts), so a sporadic error of an overloaded public service doesn't reach the user. 404 -> null.
const RETRYABLE = (s) => s === 429 || s >= 500;

export async function getJson(url, { timeout = 25000, retries = 1, label = 'HTTP' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
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
