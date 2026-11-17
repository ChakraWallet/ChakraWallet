// Settings > Service keys: the optional API keys of the public services the wallet reads (Etherscan, OpenSea, and the
// ones of other families' drivers: TON Center, TonAPI, Symbiosis, Getgems). One row per service with its state, and a
// sheet with what the key unlocks, what it costs, a short how-to with a link to the service, and the key itself.
// Keys stay on the device and go only to their own service.
import { useState } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { Icon, Btn, Sheet, Switch, useApp } from '../components.jsx';
import { allDrivers } from '../chains/index.js';
import { t } from '../../shared/i18n.js';

/**
 * A service key: { key (settings field), name, unlocks (i18n), price: 'free' | 'freemium' | 'paid', url, site (shown),
 * steps: [i18n keys], family? }. The drivers add their own in ui.settings (same shape; label / hint as before).
 */
const CORE = [
  {
    key: 'etherscanKey', name: 'Etherscan', unlocks: 'keys.etherscan.unlocks', price: 'freemium',
    url: 'https://etherscan.io/apidashboard', site: 'etherscan.io',
    steps: ['keys.etherscan.1', 'keys.etherscan.2', 'keys.etherscan.3', 'keys.etherscan.4'], note: 'keys.etherscan.note',
  },
  {
    key: 'openseaKey', name: 'OpenSea', unlocks: 'keys.opensea.unlocks', price: 'free',
    url: 'https://opensea.io/settings/developer', site: 'opensea.io',
    steps: ['keys.opensea.1', 'keys.opensea.2', 'keys.opensea.3', 'keys.opensea.4'], auto: 'nftHistory',
  },
];

/** Every key the app can use on this platform (TON's ones only in the Android app, where TON is). */
export const serviceKeys = () => [...CORE, ...allDrivers().flatMap((d) => (d.ui?.settings || []).map((f) => ({ ...f, family: d.kind })))];
const isSet = (s, k) => !!String(s[k.key] || '').trim();
const autoOn = (s, k) => k.auto && s[k.auto] === 'auto' && !isSet(s, k);

const PRICE = { free: ['green', 'keys.price.free'], freemium: ['primary', 'keys.price.freemium'], paid: ['amber', 'keys.price.paid'] };

function KeySheet({ k, onClose }) {
  const { state, refresh, toast } = useApp();
  const s = state.settings;
  const [v, setV] = useState(s[k.key] || '');
  const [show, setShow] = useState(false);
  const save = async (patch, msg) => { await bg('saveSettings', { settings: patch }); await refresh(); toast(t(msg)); };
  const [pc, pl] = PRICE[k.price] || PRICE.free;
  return (
    <Sheet title={k.name} onClose={onClose}>
      <div class="key-head">
        <span class="small">{t(k.unlocks || k.hint)}</span>
        <span class={`badge ${pc}`}>{t(pl)}</span>
      </div>
      {k.steps?.length > 0 && (
        <div class="card flat key-how">
          <b class="small">{t('keys.how')}</b>
          <ol>{k.steps.map((x) => <li>{t(x)}</li>)}</ol>
          {k.note && <div class="tiny muted">{t(k.note)}</div>}
          {k.url && <a class="btn secondary sm" href={k.url} target="_blank" rel="noopener" data-external><Icon name="external" size={14} /> {t('keys.open', { site: k.site })}</a>}
        </div>
      )}
      {k.auto && ( // OpenSea: a free key the app gets and renews by itself, when there is none of one's own
        <label class="row small key-auto">
          <span class="grow">{t('settings.openseaAuto')}<br /><span class="tiny muted">{t('settings.openseaAuto.sub')}</span></span>
          <Switch on={s[k.auto] === 'auto'} onChange={(on) => save({ [k.auto]: on ? 'auto' : 'local' }, 'common.settingsSaved')} />
        </label>
      )}
      <div class="field">
        <label>{t('keys.yours', { name: k.name })}</label>
        <div class="row">
          <input class="input mono grow" type={show ? 'text' : 'password'} placeholder="API key" autocomplete="off" spellcheck={false} value={v} onInput={(e) => setV(e.target.value.trim())} />
          <button class="iconbtn" title={t(show ? 'keys.hide' : 'keys.show')} onClick={() => setShow(!show)}><Icon name={show ? 'eyeOff' : 'eye'} size={16} /></button>
        </div>
      </div>
      <div class="tiny muted">{t('keys.private', { site: k.site || k.name })}</div>
      <div class="row" style={{ gap: '.5rem' }}>
        {isSet(s, k) && <Btn kind="secondary" class="grow" onClick={async () => { await save({ [k.key]: '' }, 'keys.removed'); setV(''); }}>{t('keys.remove')}</Btn>}
        <Btn class="grow" disabled={v === (s[k.key] || '')} onClick={async () => { await save({ [k.key]: v }, v ? 'keys.saved' : 'keys.removed'); onClose(); }}>{t('common.save')}</Btn>
      </div>
    </Sheet>
  );
}

/** The list (Settings > Service keys). focus: a key's field to open right away (e.g. from "needs a key" notes). */
export function ApiKeys({ focus }) {
  const { state } = useApp();
  const s = state.settings;
  const keys = serviceKeys();
  const [open, setOpen] = useState(() => keys.find((k) => k.key === focus) || null);
  const groups = [['evm', keys.filter((k) => !k.family || k.family === 'evm')], ...[...new Set(keys.map((k) => k.family).filter((f) => f && f !== 'evm'))].map((f) => [f, keys.filter((k) => k.family === f)])];
  return (
    <>
      <div class="small muted">{t('keys.intro')}</div>
      {groups.map(([fam, list]) => (
        <>
          <div class="section-title">{t(`keys.group.${fam}`)}</div>
          <div class="card" style={{ padding: '0.375rem' }}>
            {list.map((k) => (
              <button class="item key-row" onClick={() => setOpen(k)}>
                <span class="key-ic">{k.name.slice(0, 1)}</span>
                <div class="grow" style={{ minWidth: 0 }}>
                  <div class="bold">{k.name}</div>
                  <div class="small muted key-sub">{t(k.unlocks || k.hint)}</div>
                </div>
                {isSet(s, k) ? <span class="badge green">{t('keys.set')}</span> : autoOn(s, k) ? <span class="badge primary">{t('keys.auto')}</span> : <span class="badge">{t('keys.none')}</span>}
              </button>
            ))}
          </div>
        </>
      ))}
      <div class="tiny muted">{t('settings.sources')}</div>
      {open && <KeySheet k={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** "3 of 6 set": the row in Settings. */
export const keysCount = (s) => { const k = serviceKeys(); return { set: k.filter((x) => isSet(s, x) || autoOn(s, x)).length, total: k.length }; };
