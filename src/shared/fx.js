// Display currency. Prices stay in USD inside the app; only what is shown is converted, with the daily
// reference rates of the European Central Bank (frankfurter.dev, free, no key), cached for a day.
import { local } from './ext.js';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF'];
let current = { code: 'USD', rate: 1 };
export const displayCurrency = () => current;

export async function setDisplayCurrency(code) {
  if (!CURRENCIES.includes(code) || code === 'USD') { current = { code: 'USD', rate: 1 }; return current; }
  let cache = await local.get('fxRates', null);
  if (!cache || Date.now() - cache.t > 12 * 3600e3 || !cache.rates?.[code]) {
    try {
      const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${CURRENCIES.filter((c) => c !== 'USD').join(',')}`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j.rates) { cache = { t: Date.now(), rates: j.rates }; await local.set('fxRates', cache); }
    } catch { /* keep the cached rates if any */ }
  }
  const rate = cache?.rates?.[code];
  current = rate ? { code, rate } : { code: 'USD', rate: 1 }; // no rate yet (offline on first use): stay in USD
  return current;
}
