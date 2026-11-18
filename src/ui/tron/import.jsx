// Import a wallet from another Tron app (TronLink, Trust Wallet, Ledger Live, TokenPocket…): its recovery phrase or its
// private key. A phrase gives one address per account on TronLink's path: the first ones are looked up on the network
// and the ones holding TRX are suggested.
import { useState } from 'preact/hooks';
import { Btn, Spinner, useApp } from '../components.jsx';
import { bg } from '../../shared/ext.js';
import { fmtNum, shortAddr } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { TRON_CHAINS, TRON_MAINNET, getAccount } from '../../shared/tron/api.js';

const MAINNET = TRON_CHAINS[TRON_MAINNET];

/** The import form, inside the "Add account" sheet. onDone(account) after the import. */
export function ImportTron({ onBack, onDone }) {
  const { refresh, state } = useApp();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState(null); // [{ index, path, address, balance (bigint | null) }]
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = () => {
    const s = text.trim();
    return s.split(/\s+/).length >= 12 ? { phrase: s } : { secret: s };
  };
  const inspect = async () => {
    setErr(''); setBusy(true); setFound(null);
    try {
      const k = await bg('tronInspectKey', input());
      const rows = [];
      for (const x of k.found) { // one at a time: TronGrid without a key allows few requests a second
        const acc = await getAccount(MAINNET, x.address).catch(() => undefined);
        rows.push({ ...x, balance: acc === undefined ? null : BigInt(acc?.balance || 0), used: !!acc && Object.keys(acc).length > 0 });
      }
      // the accounts in use, and the first one (where every app starts)
      const shown = rows.filter((r) => r.index === 0 || r.used);
      setFound(shown);
      const best = shown.find((r) => r.used) || shown[0];
      setPick(best.index);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const doImport = async () => {
    setErr(''); setBusy(true);
    try {
      const acc = await bg('tronImport', { ...input(), index: pick, name: name.trim() || undefined });
      await bg('selectAccount', { address: acc.address });
      const off = state.settings.disabledChains || [];
      if (off.includes(TRON_MAINNET)) await bg('saveSettings', { settings: { disabledChains: off.filter((x) => x !== TRON_MAINNET) } });
      await bg('setChain', { chainId: TRON_MAINNET });
      await refresh();
      onDone(acc);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <div class="field"><label>{t('common.nameOptional')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('accounts.add.namePlaceholder')} /></div>
      <div class="field">
        <label>{t('tron.import.label')}</label>
        <textarea class="input mono" rows={3} value={text} spellcheck={false} autocapitalize="off" placeholder={t('tron.import.placeholder')} onInput={(e) => { setText(e.target.value); setFound(null); }} />
        <span class="tiny muted">{t('tron.import.hint')}</span>
      </div>
      {found && (
        <div class="card" style={{ padding: '0.375rem' }}>
          <div class="small muted" style={{ padding: '0.375rem' }}>{t('tron.import.pick')}</div>
          {found.map((r) => (
            <label class={`item ${r.index === pick ? 'sel' : ''}`} style={{ cursor: 'pointer' }}>
              <input type="radio" name="tronpath" checked={r.index === pick} onChange={() => setPick(r.index)} />
              <div class="grow">
                <div class="bold mono small">{r.path || t('tron.import.key')}</div>
                <div class="tiny muted mono">{shortAddr(r.address, 6)}</div>
              </div>
              <span class="small">{r.balance != null ? `${fmtNum(Number(r.balance) / 1e6)} TRX` : '—'}</span>
            </label>
          ))}
        </div>
      )}
      {err && <div class="error">{err}</div>}
      <div class="row">
        <Btn kind="secondary" class="grow" onClick={onBack}>{t('common.back')}</Btn>
        {!found ? <Btn class="grow" loading={busy} disabled={!text.trim()} onClick={inspect}>{t('common.continue')}</Btn>
          : <Btn class="grow" loading={busy} disabled={pick == null} onClick={doImport}>{t('tron.import.do')}</Btn>}
      </div>
      {busy && !found && <div class="row small muted" style={{ justifyContent: 'center' }}><Spinner /> {t('tron.import.checking')}</div>}
    </>
  );
}
