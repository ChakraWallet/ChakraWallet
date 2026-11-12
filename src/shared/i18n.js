// Localisation: key-based dictionaries, English is the base and the fallback for any missing key.
//   t('send.title')                       -> string
//   t('send.sent', { amount: '1 ETH' })   -> placeholders {name}
//   tn('accounts.count', 3)               -> picks 'accounts.count.one' / 'accounts.count.other', with {n}
// Language preference: 'system' (Italian if the device/browser is Italian, otherwise English), 'en', 'it'.
import en from './locales/en/index.js';
import it from './locales/it/index.js';

const DICTS = { en, it };
export const LANGS = ['en', 'it'];
let lang = resolveLang('system');
const subs = new Set();

export function resolveLang(pref) {
  if (LANGS.includes(pref)) return pref;
  const nav = String(globalThis.navigator?.language || 'en').toLowerCase();
  return nav.startsWith('it') ? 'it' : 'en';
}
export function setLang(pref) {
  const l = resolveLang(pref);
  if (l !== lang) { lang = l; subs.forEach((f) => f(l)); }
  return lang;
}
export const getLang = () => lang;
export const onLangChange = (f) => { subs.add(f); return () => subs.delete(f); };
/** BCP 47 locale for numbers and dates */
export const locale = () => (lang === 'it' ? 'it-IT' : 'en-US');

export function t(key, vars) {
  let s = DICTS[lang]?.[key] ?? en[key];
  if (s == null) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}
export const tn = (key, n, vars) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...vars });
/** Always English: for messages sent to websites (dapps expect English, like MetaMask). */
export function tEn(key, vars) {
  let s = en[key];
  if (s == null) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

/** Error whose message is localised and whose `key` lets callers recognise it without comparing text. */
export function i18nError(key, vars, extra) {
  return Object.assign(new Error(t(key, vars)), { key, vars }, extra);
}
