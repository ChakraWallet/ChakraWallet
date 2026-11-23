// Choices of Settings shown as tiles, in a sheet (Settings) or inline (onboarding): display currency and auto-lock.
import { Icon, Sheet } from './components.jsx';
import { t, tn, locale } from '../shared/i18n.js';
import { CURRENCIES } from '../shared/fx.js';
import { SEARCH_ENGINES, searchEngine } from './searchEngines.js';

// ------------------------------------------------------------ currency
export const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CHF: 'Fr.' };

/** Name of a currency in the language of the interface ("Euro", "Dollaro statunitense"), or ''. */
export function currencyName(code) {
  try {
    const n = new Intl.DisplayNames([locale()], { type: 'currency' }).of(code) || '';
    return n && n !== code ? n[0].toLocaleUpperCase(locale()) + n.slice(1) : '';
  } catch { return ''; }
}

/** The currencies as tiles: symbol, code, name. */
export function CurrencyTiles({ value, onPick }) {
  const cur = value || 'USD';
  return (
    <div class="ob-cur" role="radiogroup">
      {CURRENCIES.map((c) => (
        <button class={`ob-choice ob-cur-tile ${cur === c ? 'on' : ''}`} role="radio" aria-checked={cur === c} onClick={() => onPick(c)}>
          <span class="ob-sym">{CURRENCY_SYMBOLS[c] || c}</span>
          <span class="ob-cur-code">{c}</span>
          <span class="ob-cur-name">{currencyName(c)}</span>
        </button>
      ))}
    </div>
  );
}

/** Round badge with the currency symbol (right side of the Settings row). */
export const CurrencyBadge = ({ code }) => <span class="sym-badge">{CURRENCY_SYMBOLS[code || 'USD'] || code}</span>;

export function CurrencySheet({ value, onPick, onClose }) {
  return (
    <Sheet title={t('settings.currency')} onClose={onClose}>
      <span class="small muted">{t('settings.currency.sub')}</span>
      <CurrencyTiles value={value} onPick={(c) => { onPick(c); onClose(); }} />
    </Sheet>
  );
}

// ------------------------------------------------------------ auto-lock
export const AUTO_LOCK = [5, 15, 30, 60, 240, 0]; // minutes, 0 = never

/** "15 min" / "1 h" / "Never" */
export const autoLockLabel = (m) => (!m ? t('settings.autoLock.never') : m >= 60 ? t('settings.autoLock.hours', { n: m / 60 }) : t('settings.autoLock.minutes', { n: m }));

export function AutoLockSheet({ value, onPick, onClose }) {
  const cur = Number(value ?? 15);
  return (
    <Sheet title={t('settings.autoLock')} onClose={onClose}>
      <span class="small muted">{t('settings.autoLock.explain')}</span>
      <div class="ob-cur lock-grid" role="radiogroup">
        {AUTO_LOCK.map((m) => (
          <button class={`ob-choice lock-tile ${cur === m ? 'on' : ''}`} role="radio" aria-checked={cur === m} onClick={() => { onPick(m); onClose(); }}>
            {m ? <span class="lock-num">{m >= 60 ? m / 60 : m}</span> : <span class="lock-num lock-never"><Icon name="lockOpen" size={26} /></span>}
            <span class="lock-unit">{!m ? t('settings.autoLock.never') : m >= 60 ? tn('settings.autoLock.unitHours', m / 60) : t('settings.autoLock.unitMinutes')}</span>
          </button>
        ))}
      </div>
      {cur === 0 && <div class="warn small">{t('settings.autoLock.neverWarn')}</div>}
    </Sheet>
  );
}

// ------------------------------------------------------------ search engine (Android browser)
export function SearchEngineSheet({ value, onPick, onClose }) {
  const cur = searchEngine(value).id;
  return (
    <Sheet title={t('settings.search')} onClose={onClose}>
      <span class="small muted">{t('settings.search.explain')}</span>
      <div class="list lang-list" role="radiogroup">
        {SEARCH_ENGINES.map((e) => (
          <button class={`item lang-item ${cur === e.id ? 'sel' : ''}`} role="radio" aria-checked={cur === e.id} onClick={() => { onPick(e.id); onClose(); }}>
            <div class="grow"><div class="bold">{e.name}</div><div class="small muted">{new URL(e.url).host.replace(/^www\./, '')}</div></div>
            {cur === e.id && <span class="green"><Icon name="check" /></span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
