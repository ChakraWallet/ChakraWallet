// Checks localisation keys: every t('key') / tn('key', n) / i18nError('key') used in src must exist in the
// English dictionary (tn keys need '.one' and '.other'); then, for every other language in src/shared/locales:
//   - missing keys (plural keys need the forms of that language: Russian one / few / many, Chinese other, ...);
//   - placeholders {name} different from English (a dropped {amount} would hide the amount), or <b> / <m> tags;
//   - keys that English doesn't have.
// A language listed in LANGUAGES (src/shared/i18n.js) must be complete; one still being translated only gets a report.
// Usage: node scripts/i18n-check.mjs        (exit code 1 on an English key missing, a placeholder or tag mismatch,
//                                            or an incomplete language listed in LANGUAGES)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOCALES = path.join(ROOT, 'src', 'shared', 'locales');
const SHOW = 25; // missing keys listed per language, then a count
let errors = 0;
const error = (s) => { console.log(s); errors++; };

const load = async (l) => {
  const dir = path.join(LOCALES, l);
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f !== 'index.js' && f.endsWith('.js'))) {
    const part = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    for (const k of Object.keys(part)) { if (k in out) console.log(`duplicate key in ${l}: ${k} (${f})`); out[k] = part[k]; }
  }
  return out;
};
const en = await load('en');
const { LANGUAGES } = await import(pathToFileURL(path.join(ROOT, 'src', 'shared', 'i18n.js')).href);

// ---------------------------------------------------------------- keys used in the code
const used = new Map(); // key -> file
const plural = new Set();
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { if (f !== 'locales') walk(p); continue; }
    if (!/\.(jsx?|mjs)$/.test(f) || f === 'i18n.js') continue; // i18n.js only has examples in comments
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/\b(t|tn|i18nError)\(\s*'([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.-]+)'/g)) {
      used.set(m[2], path.relative(ROOT, p));
      if (m[1] === 'tn') plural.add(m[2]);
    }
    // dynamic keys, e.g. t(`browser.err.${kind}.title`): every dictionary key matching the pattern counts as used
    for (const m of src.matchAll(/\b(?:t|tn)\(\s*`([a-z][^`]*\$\{[^`]*)`/g)) {
      const re = new RegExp('^' + m[1].split(/\$\{[^}]*\}/).map((x) => x.replace(/[.*+?^()|[\]\\]/g, '\\$&')).join('[\\w]+') + '$');
      for (const k of Object.keys(en)) if (re.test(k)) used.set(k, path.relative(ROOT, p));
    }
    // keys referenced as data, e.g. { label: 'speed.slow' } -> marked with  // i18n keys
    for (const m of src.matchAll(/'([a-z]+\.[a-zA-Z0-9_.]+)'/g)) if (m[1] in en) used.set(m[1], path.relative(ROOT, p));
  }
};
walk(path.join(ROOT, 'src'));

let missingEn = 0;
for (const [k, f] of used) {
  for (const kk of plural.has(k) ? [`${k}.one`, `${k}.other`] : [k]) {
    if (!(kk in en)) { error(`MISSING en: ${kk}  (${f})`); missingEn++; }
  }
}
const usedAll = new Set([...used.keys()].flatMap((k) => (plural.has(k) ? [`${k}.one`, `${k}.other`] : [k])));
const unused = Object.keys(en).filter((k) => !usedAll.has(k));
if (unused.length) console.log(`unused en keys (${unused.length}): ${unused.join(', ')}`);
console.log(`${used.size} keys used, ${Object.keys(en).length} en, ${missingEn} missing in en`);

// ---------------------------------------------------------------- the other languages
// plural keys: English has both 'x.one' and 'x.other'
const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const bases = new Set(Object.keys(en).filter((k) => k.endsWith('.one') && `${k.slice(0, -4)}.other` in en).map((k) => k.slice(0, -4)));
const formOf = (k) => { const i = k.lastIndexOf('.'); return bases.has(k.slice(0, i)) && FORMS.includes(k.slice(i + 1)) ? [k.slice(0, i), k.slice(i + 1)] : null; };
const vars = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const tags = (s) => (String(s).match(/<\/?[bm]>/g) || []).sort().join(''); // markup the UI renders (<name> in a path is text)
const list = (s) => [...s].map((x) => `{${x}}`).join(' ') || '-';

for (const code of fs.readdirSync(LOCALES).filter((d) => d !== 'en' && fs.statSync(path.join(LOCALES, d)).isDirectory()).sort()) {
  const d = await load(code);
  const listed = LANGUAGES.find((l) => l.code === code);
  const rules = new Intl.PluralRules(listed?.locale || code);
  const ints = Array.from({ length: 201 }, (_, n) => n);
  const needed = [...new Set(ints.map((n) => rules.select(n)))]; // forms whole numbers need: ru one/few/many, zh other
  const known = new Set([...rules.resolvedOptions().pluralCategories, 'other']);
  const oneIsOne = ints.filter((n) => rules.select(n) === 'one').join() === '1'; // else 'one' needs {n} too (ru 21, fr 0)
  const missing = [];
  const issues = [];

  for (const k of Object.keys(en)) {
    const f = formOf(k);
    if (f) continue; // plural keys below
    if (!(k in d)) { missing.push(k); continue; }
    if (!same(vars(d[k]), vars(en[k]))) issues.push(`${k}: ${list(vars(d[k]))} instead of ${list(vars(en[k]))}`);
    if (tags(d[k]) !== tags(en[k])) issues.push(`${k}: tags ${tags(d[k]) || '-'} instead of ${tags(en[k]) || '-'}`);
  }
  for (const b of bases) {
    const enVars = new Set([...vars(en[`${b}.one`]), ...vars(en[`${b}.other`])]);
    const needsN = vars(en[`${b}.other`]).has('n');
    for (const form of needed) {
      const k = `${b}.${form}`;
      if (!(k in d)) { missing.push(k); continue; }
      const v = vars(d[k]);
      const rest = new Set([...v].filter((x) => x !== 'n'));
      if (!same(rest, new Set([...enVars].filter((x) => x !== 'n')))) issues.push(`${k}: ${list(v)} instead of ${list(enVars)}`);
      if (needsN && !v.has('n') && (form !== 'one' || !oneIsOne)) issues.push(`${k}: {n} needed (this form is not only for 1)`);
      if (tags(d[k]) !== tags(en[`${b}.other`])) issues.push(`${k}: tags ${tags(d[k]) || '-'} instead of ${tags(en[`${b}.other`]) || '-'}`);
    }
  }
  const extra = Object.keys(d).filter((k) => { const f = formOf(k); return f ? !known.has(f[1]) : !(k in en); });

  const total = Object.keys(en).length;
  console.log(`\n${code}${listed ? '' : ' (not listed in LANGUAGES yet)'}: ${Object.keys(d).length} keys, ${missing.length} missing, ${issues.length} placeholder problems${extra.length ? `, ${extra.length} unknown` : ''}  (en: ${total}; plural forms: ${needed.join('/')})`);
  for (const s of issues) error(`  placeholders ${code}: ${s}`);
  if (extra.length) console.log(`  keys not in en: ${extra.join(', ')}`);
  if (missing.length) {
    const lines = missing.slice(0, SHOW).map((k) => `  missing ${code}: ${k}`);
    if (missing.length > SHOW) lines.push(`  ... and ${missing.length - SHOW} more`);
    if (listed) { error(`  ${code} is listed in LANGUAGES but incomplete:`); lines.forEach((s) => console.log(s)); } else lines.forEach((s) => console.log(s));
  }
  if (listed && Object.keys(listed.dict).length !== Object.keys(d).length) error(`  ${code}: locales/${code}/index.js doesn't include every file (${Object.keys(listed.dict).length} keys of ${Object.keys(d).length})`);
}
for (const l of LANGUAGES) if (l.code !== 'en' && !fs.existsSync(path.join(LOCALES, l.code))) error(`${l.code} is listed in LANGUAGES but has no folder in src/shared/locales`);

process.exit(errors ? 1 : 0);
