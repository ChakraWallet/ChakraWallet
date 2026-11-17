// Import a wallet from another Solana app (Phantom, Solflare, Backpack, Trust Wallet, solana-keygen…): its recovery
// phrase or its private key. A phrase gives different addresses on each app's derivation path: the addresses are
// looked up on the network and the ones holding SOL are suggested.
import { useState } from 'preact/hooks';
import { Btn, Spinner, useApp } from '../components.jsx';
import { bg } from '../../shared/ext.js';
import { fmtNum, shortAddr } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { SOL_CHAINS, SOL_MAINNET, multipleAccounts } from '../../shared/solana/api.js';

const MAINNET = SOL_CHAINS[SOL_MAINNET];

/** The import form, inside the "Add account" sheet. onDone(account) after the import. */
export function ImportSolana({ onBack, onDone }) {
  const { refresh, state } = useApp();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState(null); // [{ scheme, index, path, address, balance (bigint | null) }]
  const [pick, setPick] = useState(null); // `${scheme}:${index}`
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = () => {
    const s = text.trim();
    return s.split(/\s+/).length >= 12 ? { phrase: s } : { secret: s };
  };
  const inspect = async () => {
    setErr(''); setBusy(true); setFound(null);
    try {
      const k = await bg('solanaInspectKey', input());
      const accs = await multipleAccounts(MAINNET, k.found.map((x) => x.address)).catch(() => k.found.map(() => undefined));
      const rows = k.found.map((x, i) => ({ ...x, balance: accs[i] === undefined ? null : accs[i]?.lamports ?? 0n }));
      // the accounts holding SOL, and the first account of each path (where every app starts)
      const shown = rows.filter((r) => r.index === 0 || (r.balance != null && r.balance > 0n));
      setFound(shown);
      const best = shown.find((r) => r.balance != null && r.balance > 0n) || shown[0];
      setPick(`${best.scheme}:${best.index}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const doImport = async () => {
    setErr(''); setBusy(true);
    try {
      const [scheme, index] = pick.split(':');
      const acc = await bg('solanaImport', { ...input(), scheme, index: Number(index), name: name.trim() || undefined });
      await bg('selectAccount', { address: acc.address });
      const off = state.settings.disabledChains || [];
      if (off.includes(SOL_MAINNET)) await bg('saveSettings', { settings: { disabledChains: off.filter((x) => x !== SOL_MAINNET) } });
      await bg('setChain', { chainId: SOL_MAINNET });
      await refresh();
      onDone(acc);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const label = (r) => (r.scheme === 'key' ? t('sol.import.key') : r.scheme === 'cli' ? t('sol.import.cli') : r.path);
  return (
    <>
      <div class="field"><label>{t('common.nameOptional')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('accounts.add.namePlaceholder')} /></div>
      <div class="field">
        <label>{t('sol.import.label')}</label>
        <textarea class="input mono" rows={3} value={text} spellcheck={false} autocapitalize="off" placeholder={t('sol.import.placeholder')} onInput={(e) => { setText(e.target.value); setFound(null); }} />
        <span class="tiny muted">{t('sol.import.hint')}</span>
      </div>
      {found && (
        <div class="card" style={{ padding: '0.375rem' }}>
          <div class="small muted" style={{ padding: '0.375rem' }}>{t('sol.import.pick')}</div>
          {found.map((r) => {
            const id = `${r.scheme}:${r.index}`;
            return (
              <label class={`item ${id === pick ? 'sel' : ''}`} style={{ cursor: 'pointer' }}>
                <input type="radio" name="solpath" checked={id === pick} onChange={() => setPick(id)} />
                <div class="grow">
                  <div class="bold mono small">{label(r)}</div>
                  <div class="tiny muted mono">{shortAddr(r.address, 6)}</div>
                </div>
                <span class="small">{r.balance != null ? `${fmtNum(Number(r.balance) / 1e9)} SOL` : '—'}</span>
              </label>
            );
          })}
        </div>
      )}
      {err && <div class="error">{err}</div>}
      <div class="row">
        <Btn kind="secondary" class="grow" onClick={onBack}>{t('common.back')}</Btn>
        {!found ? <Btn class="grow" loading={busy} disabled={!text.trim()} onClick={inspect}>{t('common.continue')}</Btn>
          : <Btn class="grow" loading={busy} disabled={!pick} onClick={doImport}>{t('sol.import.do')}</Btn>}
      </div>
      {busy && !found && <div class="row small muted" style={{ justifyContent: 'center' }}><Spinner /> {t('sol.import.checking')}</div>}
    </>
  );
}
