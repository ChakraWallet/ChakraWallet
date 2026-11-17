// Import a wallet from another TON app (Tonkeeper, MyTonWallet, the Telegram wallet...): its 24-word TON phrase or
// its private key. The same key gives a different address for each wallet contract version: the versions are
// looked up on the network and the one in use is suggested.
import { useState } from 'preact/hooks';
import { Mnemonic } from 'ethers';
import { Btn, Spinner, useApp } from '../components.jsx';
import { bg } from '../../shared/ext.js';
import { fmtNum, shortAddr } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { TON_CHAINS, tonAccount } from '../../shared/ton/api.js';

const MAINNET = TON_CHAINS[-239];
const VERSION_NAME = { v5r1: 'W5', v4r2: 'v4R2', v3r2: 'v3R2' };

/** The import form, inside the "Add account" sheet. onDone(account) after the import. */
export function ImportTon({ onBack, onDone }) {
  const { refresh, state } = useApp();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState(null); // [{ version, address, balance, status }]
  const [version, setVersion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = () => {
    const s = text.trim();
    return s.split(/\s+/).length >= 12 ? { phrase: s } : { secret: s };
  };
  const inspect = async () => {
    setErr(''); setBusy(true); setFound(null);
    try {
      const inp = input();
      // a recovery phrase of the multichain standard (BIP-39) is not a TON phrase: it goes in as a wallet, which gives
      // both its Ethereum and its TON addresses
      const bip39 = inp.phrase && Mnemonic.isValidMnemonic(inp.phrase.toLowerCase().split(/\s+/).join(' '));
      const k = await bg('tonInspectKey', inp).catch((e) => { throw bip39 ? new Error(t('ton.import.bip39')) : e; });
      const rows = [];
      for (const v of k.versions) {
        const a = await tonAccount(MAINNET, v.mainnet.raw).catch(() => null);
        rows.push({ version: v.version, address: v.mainnet.friendly, balance: a?.balance ?? null, status: a?.status || 'unknown' });
      }
      setFound(rows);
      setVersion((rows.find((r) => r.status === 'active' && r.balance > 0n) || rows.find((r) => r.status === 'active') || rows[0]).version);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const doImport = async () => {
    setErr(''); setBusy(true);
    try {
      const acc = await bg('tonImport', { ...input(), version, name: name.trim() || undefined });
      await bg('selectAccount', { address: acc.address });
      // TON switched off in Settings: an account imported from a TON app turns it back on
      const off = state.settings.disabledChains || [];
      if (off.includes(-239)) await bg('saveSettings', { settings: { disabledChains: off.filter((x) => x !== -239) } });
      await bg('setChain', { chainId: -239 });
      await refresh();
      onDone(acc);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <div class="field"><label>{t('common.nameOptional')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('accounts.add.namePlaceholder')} /></div>
      <div class="field">
        <label>{t('ton.import.label')}</label>
        <textarea class="input mono" rows={3} value={text} spellcheck={false} autocapitalize="off" placeholder={t('ton.import.placeholder')} onInput={(e) => { setText(e.target.value); setFound(null); }} />
        <span class="tiny muted">{t('ton.import.hint')}</span>
      </div>
      {found && (
        <div class="card" style={{ padding: '0.375rem' }}>
          <div class="small muted" style={{ padding: '0.375rem' }}>{t('ton.import.pick')}</div>
          {found.map((r) => (
            <label class={`item ${r.version === version ? 'sel' : ''}`} style={{ cursor: 'pointer' }}>
              <input type="radio" name="tonver" checked={r.version === version} onChange={() => setVersion(r.version)} />
              <div class="grow">
                <div class="bold">{VERSION_NAME[r.version]}{r.status === 'active' ? ` · ${t('ton.import.inUse')}` : ''}</div>
                <div class="tiny muted mono">{shortAddr(r.address, 6)}</div>
              </div>
              <span class="small">{r.balance != null ? `${fmtNum(Number(r.balance) / 1e9)} GRAM` : '—'}</span>
            </label>
          ))}
        </div>
      )}
      {err && <div class="error">{err}</div>}
      <div class="row">
        <Btn kind="secondary" class="grow" onClick={onBack}>{t('common.back')}</Btn>
        {!found ? <Btn class="grow" loading={busy} disabled={!text.trim()} onClick={inspect}>{t('common.continue')}</Btn>
          : <Btn class="grow" loading={busy} disabled={!version} onClick={doImport}>{t('ton.import.do')}</Btn>}
      </div>
      {busy && !found && <div class="row small muted" style={{ justifyContent: 'center' }}><Spinner /> {t('ton.import.checking')}</div>}
    </>
  );
}
