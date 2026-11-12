// Cross-browser extension API access (Chrome "chrome.*", Firefox "browser.*" - both promise-based in MV3).
import { t } from './i18n.js';

export const ext = globalThis.browser ?? globalThis.chrome;

export const local = {
  async get(key, def) { const r = await ext.storage.local.get(key); return r[key] ?? def; },
  set(key, value) { return ext.storage.local.set({ [key]: value }); },
  async update(key, def, fn) { const v = await local.get(key, def); const n = fn(v); await local.set(key, n); return n; },
};

export const session = {
  async get(key, def) { const r = await ext.storage.session.get(key); return r[key] ?? def; },
  set(key, value) { return ext.storage.session.set({ [key]: value }); },
  clear() { return ext.storage.session.clear(); },
};

export const DEFAULT_SETTINGS = {
  autoLockMin: 15,
  metamaskCompat: true,
  etherscanKey: '',
  showUnpriced: false,
  allowEthSign: false, // advanced: raw-hash signing (dangerous, disabled by default)
  theme: 'system', // 'system' | 'light' | 'dark'
  language: 'system', // 'system' | 'en' | 'it'
  currency: 'USD', // display currency: USD | EUR | GBP | CHF
  disabledChains: [], // chain ids switched off in Settings > Networks (not scanned, not listed)
  notifications: true, // Android: funds received / sent and bridges, while the app is closed
};

/** UI -> background call. */
export async function bg(type, payload = {}) {
  const res = await ext.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error(t('common.noWalletResponse'));
  if (!res.ok) { const e = new Error(res.error || t('common.error')); e.code = res.code; e.key = res.key; throw e; }
  return res.result;
}
