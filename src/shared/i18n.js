// Localisation: key-based dictionaries, English is the base and the fallback for any missing key.
//   t('send.title')                       -> string
//   t('send.sent', { amount: '1 ETH' })   -> placeholders {name}
//   tn('accounts.count', 3)               -> picks the plural form of the language ('accounts.count.one' / '.few' /
//                                            '.many' / '.other', by Intl.PluralRules; '.other' if missing), with {n}
// Language preference: 'system' (the device/browser language when the app has it, otherwise English) or a code of LANGUAGES.
import en from './locales/en/index.js';
import it from './locales/it/index.js';
import es from './locales/es/index.js';
import fr from './locales/fr/index.js';
import de from './locales/de/index.js';
import ru from './locales/ru/index.js';
import zh from './locales/zh/index.js';

/** Languages of the interface: code, name in the language itself, flag (country code of flag-icons, see
 *  ui/language.jsx), BCP 47 locale for numbers, dates and plural rules, dictionary. A language is listed only when
 *  its dictionary is complete (scripts/i18n-check.mjs fails otherwise). */
export const LANGUAGES = [
  { code: 'en', name: 'English', flag: 'gb', locale: 'en-US', dict: en },
  { code: 'it', name: 'Italiano', flag: 'it', locale: 'it-IT', dict: it },
  { code: 'es', name: 'Español', flag: 'es', locale: 'es-ES', dict: es },
  { code: 'fr', name: 'Français', flag: 'fr', locale: 'fr-FR', dict: fr },
  { code: 'de', name: 'Deutsch', flag: 'de', locale: 'de-DE', dict: de },
  { code: 'ru', name: 'Русский', flag: 'ru', locale: 'ru-RU', dict: ru },
  { code: 'zh', name: '简体中文', flag: 'cn', locale: 'zh-CN', dict: zh },
];
const DICTS = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.dict]));
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
export const locale = () => LANGUAGES.find((l) => l.code === lang)?.locale || 'en-US';

export function t(key, vars) {
  let s = DICTS[lang]?.[key] ?? en[key];
  if (s == null) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}
const rules = new Map(); // language -> Intl.PluralRules
const pluralOf = (n) => {
  if (!rules.has(lang)) rules.set(lang, new Intl.PluralRules(locale()));
  return rules.get(lang).select(n);
};
/** Plural: the form of the current language for n ('one', 'few', 'many', 'other'), else '.other'; a key the language
 *  doesn't have at all falls back to English (one / other). */
export function tn(key, n, vars) {
  const d = DICTS[lang] || en;
  const k = [`${key}.${pluralOf(n)}`, `${key}.other`].find((x) => d[x] != null) || `${key}.${n === 1 ? 'one' : 'other'}`;
  return t(k, { n, ...vars });
}
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
