// Import a wallet from another Bitcoin app (Sparrow, BlueWallet, Electrum, Ledger Live's phrase…): a BIP39 phrase
// (one of its first accounts), an Electrum seed, or a WIF private key. The first addresses of every type are looked up
// on the network, so the account holding the funds can be picked. A phrase imported here is a Bitcoin account only;
// the same phrase imported from Wallets becomes a whole Chakra wallet (every network).
import { useState } from 'preact/hooks';
import { Btn, Spinner, useApp } from '../components.jsx';
import { bg } from '../../shared/ext.js';
import { fmtAmount } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { BTC_CHAINS, BTC_MAINNET } from '../../shared/btc/networks.js';
import { addressStats } from '../../shared/btc/esplora.js';
import { TYPES, branchAddress, addressOf, fromHex } from '../../shared/btc/keys.js';

const MAINNET = BTC_CHAINS[BTC_MAINNET];
const PROBE = 3; // first receive addresses of each type looked at

/** Balance and use of an account's first addresses: { balance (bigint), used }. */
async function probe(acc) {
  let balance = 0n, used = false;
  const jobs = [];
  for (const br of acc.branches) {
    const n = br.single ? 1 : PROBE;
    for (let i = 0; i < n; i++) jobs.push(br.single ? addressOf(br.type, fromHex(br.pub), MAINNET.net) : branchAddress(br, 0, i, MAINNET.net));
  }
  await Promise.all(jobs.map(async (address) => {
    const s = await addressStats(MAINNET, address).catch(() => null);
    if (s) { balance += s.balance + s.pending; used ||= s.txs > 0; }
  }));
  return { balance, used };
}

export function ImportBitcoin({ onBack, onDone }) {
  const { refresh, state } = useApp();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState(null); // { scheme, seedType, accounts: [{ index, path, balance, used }] }
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inspect = async () => {
    setErr(''); setBusy(true); setFound(null);
    try {
      const k = await bg('btcInspectKey', { text: text.trim(), chainId: BTC_MAINNET });
      const accounts = [];
      for (const acc of k.accounts) accounts.push({ index: acc.index, path: acc.branches[0].path || null, single: !!acc.branches[0].single, ...(await probe(acc)) });
      setFound({ scheme: k.scheme, seedType: k.seedType, accounts });
      setPick((accounts.find((x) => x.balance > 0n) || accounts.find((x) => x.used) || accounts[0]).index);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const doImport = async () => {
    setErr(''); setBusy(true);
    try {
      const acc = await bg('btcImport', { text: text.trim(), index: pick, name: name.trim() || undefined });
      await bg('selectAccount', { address: acc.address });
      const off = state.settings.disabledChains || [];
      if (off.includes(BTC_MAINNET)) await bg('saveSettings', { settings: { disabledChains: off.filter((x) => x !== BTC_MAINNET) } });
      await bg('setChain', { chainId: BTC_MAINNET });
      await refresh();
      onDone(acc);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const label = (r) => {
    if (found.scheme === 'wif') return t('btc.import.key');
    if (found.scheme === 'electrum') return t(found.seedType === 'segwit' ? 'btc.import.electrumSegwit' : 'btc.import.electrumStandard');
    return t('btc.import.account', { n: r.index + 1 });
  };
  return (
    <>
      <div class="field"><label>{t('common.nameOptional')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('accounts.add.namePlaceholder')} /></div>
      <div class="field">
        <label>{t('btc.import.label')}</label>
        <textarea class="input mono" rows={3} value={text} spellcheck={false} autocapitalize="off" placeholder={t('btc.import.placeholder')} onInput={(e) => { setText(e.target.value); setFound(null); }} />
        <span class="tiny muted">{t('btc.import.hint')}</span>
      </div>
      {found && (
        <div class="card" style={{ padding: '0.375rem' }}>
          <div class="small muted" style={{ padding: '0.375rem' }}>{t('btc.import.pick')}</div>
          {found.accounts.map((r) => (
            <label class={`item ${r.index === pick ? 'sel' : ''}`} style={{ cursor: 'pointer' }}>
              <input type="radio" name="btcacc" checked={r.index === pick} onChange={() => setPick(r.index)} />
              <div class="grow">
                <div class="bold small">{label(r)}</div>
                <div class="tiny muted mono">{found.scheme === 'bip39' ? `m/84'/0'/${r.index}' · m/86'/0'/${r.index}'` : r.path || Object.values(TYPES).filter((x) => x.receive).map((x) => x.label).join(' · ')}</div>
              </div>
              <span class="small">{r.balance > 0n ? `${fmtAmount(r.balance, 8, 8)} BTC` : r.used ? t('btc.import.usedEmpty') : '—'}</span>
            </label>
          ))}
          {found.scheme === 'bip39' && <div class="tiny muted" style={{ padding: '0.375rem' }}>{t('btc.import.phraseNote')}</div>}
        </div>
      )}
      {err && <div class="error">{err}</div>}
      <div class="row">
        <Btn kind="secondary" class="grow" onClick={onBack}>{t('common.back')}</Btn>
        {!found ? <Btn class="grow" loading={busy} disabled={!text.trim()} onClick={inspect}>{t('common.continue')}</Btn>
          : <Btn class="grow" loading={busy} onClick={doImport}>{t('btc.import.do')}</Btn>}
      </div>
      {busy && !found && <div class="row small muted" style={{ justifyContent: 'center' }}><Spinner /> {t('btc.import.checking')}</div>}
    </>
  );
}
