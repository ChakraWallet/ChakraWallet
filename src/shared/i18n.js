// Localisation: key-based dictionaries, English is the base and the fallback for any missing key.
//   t('send.title')                       -> string
//   t('send.sent', { amount: '1 ETH' })   -> placeholders {name}
//   tn('accounts.count', 3)               -> picks 'accounts.count.one' / 'accounts.count.other', with {n}
// Language preference: 'system' (the device/browser language when the app has it, otherwise English) or a code of LANGUAGES.
import en from './locales/en/index.js';
import it from './locales/it/index.js';

const DICTS = { en, it };
/** Languages of the interface: code, name in the language itself, flag (country code of flag-icons, see ui/language.jsx). */
export const LANGUAGES = [
  { code: 'en', name: 'English', flag: 'gb' },
  { code: 'it', name: 'Italiano', flag: 'it' },
];
export const LANGS = LANGUAGES.map((l) => l.code);
let lang = resolveLang('system');
const subs = new Set();

export function resolveLang(pref) {
  if (LANGS.includes(pref)) return pref;
  // the device's languages in order of preference: the first one the app has, else English
  const nav = [globalThis.navigator?.language, ...(globalThis.navigator?.languages || [])].filter(Boolean).map((x) => String(x).toLowerCase().split('-')[0]);
  return nav.find((x) => LANGS.includes(x)) || 'en';
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
