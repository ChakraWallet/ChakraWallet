// Checks localisation keys: every t('key') / tn('key', n) / i18nError('key') used in src must exist in the
// English dictionary (tn keys need '.one' and '.other'); reports keys missing in Italian and unused keys.
// Usage: node scripts/i18n-check.mjs        (exit code 1 if an English key is missing)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const load = async (l) => {
  const dir = path.join(ROOT, 'src', 'shared', 'locales', l);
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f !== 'index.js' && f.endsWith('.js'))) {
    const part = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    for (const k of Object.keys(part)) { if (k in out) console.log(`duplicate key in ${l}: ${k} (${f})`); out[k] = part[k]; }
  }
  return out;
};
const en = await load('en'), it = await load('it');

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

let missing = 0;
for (const [k, f] of used) {
  const keys = plural.has(k) ? [`${k}.one`, `${k}.other`] : [k];
  for (const kk of keys) {
    if (!(kk in en)) { console.log(`MISSING en: ${kk}  (${f})`); missing++; }
    else if (!(kk in it)) console.log(`missing it: ${kk}  (${f})`);
  }
}
const usedAll = new Set([...used.keys()].flatMap((k) => (plural.has(k) ? [`${k}.one`, `${k}.other`] : [k])));
const unused = Object.keys(en).filter((k) => !usedAll.has(k));
if (unused.length) console.log(`unused en keys (${unused.length}): ${unused.join(', ')}`);
const itOnly = Object.keys(it).filter((k) => !(k in en));
if (itOnly.length) console.log(`keys only in it: ${itOnly.join(', ')}`);
console.log(`${used.size} keys used, ${Object.keys(en).length} en, ${Object.keys(it).length} it, ${missing} missing in en`);
process.exit(missing ? 1 : 0);
