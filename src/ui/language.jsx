// Interface language: a round flag of the language in use (chosen, or detected from the device) and the sheet to
// pick it. Flags are the square SVGs of flag-icons (MIT), cut to a circle; adding a language = a row in
// shared/i18n.js LANGUAGES + its flag here.
import { useState } from 'preact/hooks';
import { Icon, Sheet } from './components.jsx';
import { t, LANGUAGES, resolveLang, locale } from '../shared/i18n.js';
import gb from 'flag-icons/flags/1x1/gb.svg';
import it from 'flag-icons/flags/1x1/it.svg';

const FLAGS = { gb, it };
const SEARCH_FROM = 8; // a search field once the list gets long

export const langInfo = (code) => LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];

/** Name of a language in the language of the interface ("Italian" / "inglese"), or ''. */
function localName(code) {
  try {
    const n = new Intl.DisplayNames([locale()], { type: 'language' }).of(code) || '';
    return n ? n[0].toLocaleUpperCase(locale()) + n.slice(1) : '';
  } catch { return ''; }
}

/** Round flag of a language code. */
export function Flag({ code, size = 28 }) {
  const src = FLAGS[langInfo(code).flag];
  return <span class="flag" style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }}>{src ? <img src={src} alt="" /> : <Icon name="globe" size={size * 0.6} />}</span>;
}

/** What the current preference means: { code (language in use), auto, label } */
export function languageState(pref) {
  const auto = !pref || pref === 'system';
  const code = resolveLang(auto ? 'system' : pref);
  const name = langInfo(code).name;
  return { code, auto, label: auto ? `${t('settings.language.system')} · ${name}` : name };
}

/** Sheet to choose the language: automatic (device) first, then every language with its flag. */
export function LanguageSheet({ value, onPick, onClose }) {
  const [q, setQ] = useState('');
  const pref = value || 'system';
  const detected = resolveLang('system');
  const pick = (v) => { onPick(v); onClose(); };
  const query = q.trim().toLowerCase();
  const list = LANGUAGES.map((l) => ({ ...l, local: localName(l.code) }))
    .filter((l) => !query || [l.name, l.local, l.code].some((x) => x.toLowerCase().includes(query)));
  return (
    <Sheet title={t('settings.language')} onClose={onClose}>
      {LANGUAGES.length >= SEARCH_FROM && (
        <div class="lang-search">
          <Icon name="search" size={16} />
          <input class="input" value={q} placeholder={t('settings.language.search')} spellcheck={false} autocapitalize="off" onInput={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div class="list lang-list" role="radiogroup">
        {!query && (
          <button class={`item lang-item ${pref === 'system' ? 'sel' : ''}`} role="radio" aria-checked={pref === 'system'} onClick={() => pick('system')}>
            <span class="lang-auto"><Flag code={detected} size={32} /><span class="lang-auto-badge"><Icon name="refresh" size={10} stroke={3} /></span></span>
            <div class="grow"><div class="bold">{t('settings.language.system')}</div><div class="small muted">{t('settings.language.detected', { name: langInfo(detected).name })}</div></div>
            {pref === 'system' && <span class="green"><Icon name="check" /></span>}
          </button>
        )}
        {list.map((l) => (
          <button class={`item lang-item ${pref === l.code ? 'sel' : ''}`} role="radio" aria-checked={pref === l.code} onClick={() => pick(l.code)}>
            <Flag code={l.code} size={32} />
            <div class="grow"><div class="bold">{l.name}</div>{l.local && l.local.toLowerCase() !== l.name.toLowerCase() && <div class="small muted">{l.local}</div>}</div>
            {pref === l.code && <span class="green"><Icon name="check" /></span>}
          </button>
        ))}
        {!list.length && <div class="small muted" style={{ padding: '.75rem' }}>{t('settings.language.none')}</div>}
      </div>
    </Sheet>
  );
}
