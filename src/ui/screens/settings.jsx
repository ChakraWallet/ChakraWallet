import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { bg, ext } from '../../shared/ext.js';
import { BUILTIN_CHAINS, normalizeCustom, isChainEnabled, builtinNetworks, ALWAYS_ON } from '../../shared/chains.js';
import { shortAddr, fmtDateTime } from '../../shared/format.js';
import { TopBar, Icon, Btn, Sheet, Switch, ChainIcon, useApp, Empty, SecureScreen, CopyBtn, CopyPhrase } from '../components.jsx';
import { BackupFile } from './onboarding.jsx';
import { bioStatus } from '../auth.jsx';
import { resetTaste } from '../predictTaste.js';
import { t, tn } from '../../shared/i18n.js';
import { Flag, LanguageSheet, languageState } from '../language.jsx';
import { CurrencySheet, CurrencyBadge, currencyName, AutoLockSheet, autoLockLabel, SearchEngineSheet } from '../pickers.jsx';
import { searchEngine } from '../searchEngines.js';
import { TermsSheet, PRIVACY_URL } from '../terms.jsx';
import { CrashList } from '../crash.jsx';
import { crashLog } from '../../shared/crash.js';
import { ApiKeys, keysCount } from './apikeys.jsx';
import { ConnectQrButton, ConnectLinkField } from '../connectQr.jsx';

function Row({ icon, title, sub, onClick, right }) {
  return (
    <button class="item" onClick={onClick}>
      <div class="tx-icon" style={{ background: 'var(--card-2)', color: 'var(--primary)' }}><Icon name={icon} /></div>
      <div class="grow" style={{ textAlign: 'left' }}><div class="bold">{title}</div>{sub && <div class="small muted">{sub}</div>}</div>
      {right}
    </button>
  );
}

function PasswordPrompt({ title, warning, action, onClose, danger, children }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const run = async () => {
    setLoading(true); setErr('');
    try { setResult(await action(pw)); } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  return (
    <Sheet title={title} onClose={onClose}>
      {result != null && children ? children(result) : (
        <>
          {warning && <div class={danger ? 'error small' : 'warn small'}>{warning}</div>}
          <div class="field"><label>{t('common.password')}</label><input class="input" type="password" value={pw} onInput={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && run()} autoFocus /></div>
          {err && <div class="error">{err}</div>}
          <Btn kind={danger ? 'danger' : 'primary'} loading={loading} disabled={!pw} onClick={run}>{t('common.confirm')}</Btn>
        </>
      )}
    </Sheet>
  );
}

function ChangePassword({ onClose }) {
  const { toast } = useApp();
  const [o, setO] = useState(''); const [n, setN] = useState(''); const [n2, setN2] = useState('');
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false);
  const go = async () => {
    setLoading(true); setErr('');
    try {
      await bg('changePassword', { oldPassword: o, newPassword: n });
      if ((await bioStatus()).enabled) {
        try { await globalThis.__CK_BIO__.enable({ password: n, title: t('settings.pw.bioTitle') }); toast(t('settings.pw.updated')); } catch {
          await globalThis.__CK_BIO__.disable().catch(() => {});
          toast(t('settings.pw.updatedBioOff'));
        }
      } else toast(t('settings.pw.updated'));
      onClose();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  return (
    <Sheet title={t('settings.pw.title')} onClose={onClose}>
      <div class="field"><label>{t('settings.pw.current')}</label><input class="input" type="password" value={o} onInput={(e) => setO(e.target.value)} /></div>
      <div class="field"><label>{t('settings.pw.new')}</label><input class="input" type="password" value={n} onInput={(e) => setN(e.target.value)} /></div>
      <div class="field"><label>{t('settings.pw.confirmNew')}</label><input class="input" type="password" value={n2} onInput={(e) => setN2(e.target.value)} /></div>
      {n2 && n !== n2 && <span class="small red">{t('common.passwordsDontMatch')}</span>}
      {err && <div class="error">{err}</div>}
      <Btn loading={loading} disabled={!o || n.length < 8 || n !== n2} onClick={go}>{t('settings.pw.update')}</Btn>
    </Sheet>
  );
}

function ExportBackup({ onClose }) {
  const { state } = useApp();
  const [pw, setPw] = useState(''); const [b, setB] = useState(''); const [b2, setB2] = useState('');
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false);
  const [text, setText] = useState(null);
  const go = async () => {
    setLoading(true); setErr('');
    try { setText(await bg('exportBackup', { password: pw, backupPassword: b })); } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  const save = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    a.download = `chakra-backup-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if (text) {
    return (
      <Sheet title={t('settings.export.readyTitle')} onClose={onClose}>
        <SecureScreen />
        <div class="warn small">{t('settings.export.readyWarn')} <b>{t('settings.export.readyWarnBold')}</b></div>
        <textarea class="input mono tiny" rows={6} readOnly value={text} onFocus={(e) => e.target.select()} />
        <div class="row">
          <CopyBtn text={text} label={' ' + t('common.copy')} />
          {!globalThis.__CK_MOBILE__ && <button class="btn secondary sm" onClick={save}><Icon name="fileDown" size={16} /> {t('settings.export.saveTxt')}</button>}
        </div>
        <Btn kind="secondary" onClick={onClose}>{t('common.close')}</Btn>
      </Sheet>
    );
  }
  return (
    <Sheet title={t('settings.export.title')} onClose={onClose}>
      <div class="info small">{t('settings.export.infoPre')} <b>{t('settings.export.infoBold', { name: state.wallets.find((w) => w.id === state.activeWallet)?.name })}</b>{t('settings.export.infoPost')}</div>
      <div class="field"><label>{t('common.walletPassword')}</label><input class="input" type="password" value={pw} onInput={(e) => setPw(e.target.value)} autoFocus /></div>
      <div class="field"><label>{t('settings.export.backupPwMin')}</label><input class="input" type="password" value={b} onInput={(e) => setB(e.target.value)} /></div>
      <div class="field"><label>{t('settings.export.backupPwConfirm')}</label><input class="input" type="password" value={b2} onInput={(e) => setB2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && b.length >= 8 && b === b2 && go()} /></div>
      {b2 && b !== b2 && <span class="small red">{t('common.passwordsDontMatch')}</span>}
      {err && <div class="error">{err}</div>}
      <Btn loading={loading} disabled={!pw || b.length < 8 || b !== b2} onClick={go}>{t('settings.export.create')}</Btn>
    </Sheet>
  );
}

function ImportBackup({ onClose }) {
  const { toast, refresh } = useApp();
  const [text, setText] = useState(''); const [b, setB] = useState('');
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false);
  const go = async () => {
    setLoading(true); setErr('');
    try {
      const r = await bg('importBackup', { backup: text, backupPassword: b });
      await refresh();
      toast(!r.added ? t('settings.import.allPresent')
        : tn('settings.import.added', r.added, { where: r.created ? tn('settings.import.inNew', r.created) : '' }));
      onClose();
    } catch (e) { setErr(e.message); setLoading(false); }
  };
  return (
    <Sheet title={t('settings.import.title')} onClose={onClose}>
      <div class="small muted">{t('settings.import.info')}</div>
      <div class="field">
        <label>{t('settings.import.text')}</label>
        <textarea class="input mono" rows={4} value={text} onInput={(e) => setText(e.target.value)} placeholder="CHAKRA-BACKUP-1:…" spellcheck={false} autoCapitalize="off" />
        {!globalThis.__CK_MOBILE__ && <BackupFile onLoad={setText} />}
      </div>
      <div class="field"><label>{t('settings.import.backupPw')}</label><input class="input" type="password" value={b} onInput={(e) => setB(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text && b && go()} /></div>
      {err && <div class="error">{err}</div>}
      <Btn loading={loading} disabled={!text.trim() || !b} onClick={go}>{t('common.import')}</Btn>
    </Sheet>
  );
}

function Networks() {
  const { state, toast, refresh } = useApp();
  const [f, setF] = useState({ name: '', rpc: '', id: '', symbol: '', explorer: '' });
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const disabled = state.settings.disabledChains || [];
  const toggle = async (id, on) => {
    await bg('saveSettings', { settings: { disabledChains: on ? disabled.filter((x) => x !== id) : [...new Set([...disabled, id])] } });
    await refresh();
  };
  const sw = (c) => <Switch on={isChainEnabled(c.id, state.settings)} onChange={(v) => !ALWAYS_ON.has(c.id) && toggle(c.id, v)} />;
  const add = async () => {
    setLoading(true); setErr('');
    try {
      const id = Number(f.id);
      if (!id) throw new Error(t('settings.networks.badId'));
      if (BUILTIN_CHAINS.some((c) => c.id === id)) throw new Error(t('settings.networks.alreadyIncluded'));
      if (!/^https:\/\//.test(f.rpc)) throw new Error(t('settings.networks.rpcHttps'));
      const chain = normalizeCustom({ id, name: f.name || `Chain ${id}`, rpc: [f.rpc.trim()], explorer: f.explorer.trim().replace(/\/$/, ''), native: { symbol: f.symbol || 'ETH', name: f.symbol || 'ETH', decimals: 18, priceId: null } });
      await bg('addCustomChain', { chain });
      await refresh(); toast(t('settings.networks.added')); setF({ name: '', rpc: '', id: '', symbol: '', explorer: '' });
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  return (
    <>
      <div class="small muted">{t('settings.networks.toggleHint')}</div>
      <div class="section-title">{t('settings.networks.builtin')}</div>
      <div class="card" style={{ padding: '0.375rem' }}>
        {builtinNetworks().map((c) => ( // Ethereum, TON, Solana, Tron, Bitcoin right below, then the others
          <div class={`item ${isChainEnabled(c.id, state.settings) ? '' : 'net-off'}`}>
            <ChainIcon chain={c} size={24} />
            <div class="grow"><div>{c.name}</div><div class="tiny muted">{c.kind ? c.native.symbol : `ID ${c.id}`}{ALWAYS_ON.has(c.id) ? ` · ${t('settings.networks.alwaysOn')}` : ''}</div></div>
            {ALWAYS_ON.has(c.id) ? <span class="net-lock"><Switch on onChange={() => {}} /></span> : sw(c)}
          </div>
        ))}
      </div>
      <div class="section-title">{t('settings.networks.custom')}</div>
      <div class="card" style={{ padding: '0.375rem' }}>
        {!state.customChains.length && <Empty>{t('settings.networks.noCustom')}</Empty>}
        {state.customChains.map((c) => (
          <div class="item">
            <ChainIcon chain={c} size={24} />
            <div class={`grow ${isChainEnabled(c.id, state.settings) ? '' : 'net-off'}`}><div class="bold">{c.name}</div><div class="tiny muted">ID {c.id} · {c.rpc[0]}</div></div>
            <button class="iconbtn" onClick={async () => { await bg('removeCustomChain', { chainId: c.id }); refresh(); }}><Icon name="trash" size={16} /></button>
            {sw(c)}
          </div>
        ))}
      </div>
      <div class="section-title">{t('settings.networks.add')}</div>
      <div class="card col" style={{ gap: '0.5rem' }}>
        <input class="input" placeholder={t('settings.networks.name')} value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} />
        <input class="input" placeholder={t('settings.networks.rpc')} value={f.rpc} onInput={(e) => setF({ ...f, rpc: e.target.value })} />
        <div class="row">
          <input class="input" placeholder="Chain ID" value={f.id} onInput={(e) => setF({ ...f, id: e.target.value })} />
          <input class="input" placeholder={t('settings.networks.symbol')} value={f.symbol} onInput={(e) => setF({ ...f, symbol: e.target.value })} />
        </div>
        <input class="input" placeholder={t('settings.networks.explorer')} value={f.explorer} onInput={(e) => setF({ ...f, explorer: e.target.value })} />
        {err && <div class="error">{err}</div>}
        <Btn loading={loading} disabled={!f.rpc || !f.id} onClick={add}>{t('settings.networks.add')}</Btn>
      </div>
    </>
  );
}

/**
 * Sites connected to Ethereum accounts and / or to a TON account (TON Connect), a Solana one or (Android app) a Tron one,
 * and the dapps connected through WalletConnect (Android app: "wc:<topic>").
 */
const connectedSites = (state) => [...new Set([...Object.keys(state.permissions || {}), ...Object.keys(state.tonSites || {}), ...Object.keys(state.solSites || {}), ...Object.keys(state.tronSites || {}), ...Object.keys(state.wcSites || {})])];

function Sites() {
  const { state, refresh } = useApp();
  const origins = connectedSites(state);
  return (
    <>
      {/* a dapp on another screen (e.g. a computer) shows a QR code: connect it (WalletConnect, TON Connect) */}
      <ConnectQrButton class="btn secondary" size={18}> {t('connect.qr.title')}</ConnectQrButton>
      <ConnectLinkField />
      <div class="card" style={{ padding: '0.375rem' }}>
        {!origins.length && <Empty>{t('settings.sites.none')}</Empty>}
        {origins.map((origin) => {
          const p = state.permissions?.[origin], ton = state.tonSites?.[origin], sol = state.solSites?.[origin], tron = state.tronSites?.[origin], wc = state.wcSites?.[origin];
          const who = [...(p?.accounts || []).map((a) => shortAddr(a)), ...(ton ? [`TON ${shortAddr(ton.display, 6)}`] : []), ...(sol ? [`Solana ${shortAddr(sol.address, 6)}`] : []), ...(tron ? [`Tron ${shortAddr(tron.address, 6)}`] : []), ...(wc?.addresses || []).map((a) => shortAddr(a, 6))].join(', ');
          // through a bridge or a relay (QR code or link) the site is what the dapp declares: its name and address
          const remote = ton?.remote || !!wc;
          const title = wc ? wc.host || wc.name : ton?.remote ? ton.host || ton.name : origin.replace(/^https?:\/\//, '');
          return (
            <div class="item">
              <div class="tx-icon" style={{ background: 'var(--card-2)' }}><Icon name={remote ? 'qr' : 'globe'} /></div>
              <div class="grow" style={{ minWidth: 0 }}>
                <div class="bold ellipsis">{title}</div>
                <div class="tiny muted">{wc ? `${t('settings.sites.viaWc')} · ` : ton?.remote ? `${t('settings.sites.viaLink')} · ` : ''}{who} · {t('settings.sites.since', { date: fmtDateTime(p?.since || ton?.since || sol?.since || tron?.since || wc?.since) })}</div>
              </div>
              <button class="btn sm secondary" onClick={async () => { await bg('disconnectSite', { origin }); refresh(); }}>{t('settings.sites.disconnect')}</button>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function Settings({ section, focus }) {
  const { state, refresh, toast, nav, account } = useApp();
  const [view, setView] = useState(section || 'main');
  const [sheet, setSheet] = useState(null);
  // build number: the installed APK's versionCode on Android, the CI run number in the extension
  const [build, setBuild] = useState(__BUILD__);
  useEffect(() => { globalThis.__CK_appInfo?.().then((i) => i?.build && setBuild(String(i.build))).catch(() => {}); }, []);
  const [crashCount, setCrashCount] = useState(0); // errors saved on this device (Help > Report a problem)
  useEffect(() => { crashLog().then((l) => setCrashCount(l.length)).catch(() => {}); }, []);
  // the main list is rebuilt when coming back from a sub-page: it returns to where it was
  const mainRef = useRef(null), mainTop = useRef(0);
  const openView = (v) => { mainTop.current = mainRef.current?.scrollTop || 0; setView(v); };
  useLayoutEffect(() => { if (view === 'main' && mainRef.current) mainRef.current.scrollTop = mainTop.current; }, [view]);
  // Android back on a sub-page returns to the settings list (opened directly on a section: leaves as usual)
  useEffect(() => {
    globalThis.__CK_screenBack = () => { if (view === 'main' || section) return false; setView('main'); return true; };
    return () => { globalThis.__CK_screenBack = null; };
  }, [view, section]);
  const s = state.settings;
  const save = async (patch) => { await bg('saveSettings', { settings: patch }); await refresh(); toast(t('common.settingsSaved')); };
  const toggleNotif = async (on) => {
    if (on) {
      const r = await globalThis.__CK_NOTIFY__.requestPermission().catch(() => ({ granted: false }));
      if (!r.granted) { toast(t('settings.notifications.denied'), 'warn'); return; }
    }
    save({ notifications: on });
  };
  const [bio, setBio] = useState({ available: false, enabled: false });
  const loadBio = () => bioStatus().then(setBio);
  useEffect(() => { loadBio(); }, []);

  if (view === 'networks') return <div class="screen" key="networks"><TopBar title={t('settings.networks.title')} onBack={section ? undefined : () => setView('main')} /><div class="content"><Networks /></div></div>;
  if (view === 'keys') return <div class="screen" key="keys"><TopBar title={t('keys.title')} onBack={section ? undefined : () => setView('main')} /><div class="content"><ApiKeys focus={focus} /></div></div>;
  if (view === 'sites') return <div class="screen" key="sites"><TopBar title={t('settings.sites.title')} onBack={() => setView('main')} /><div class="content"><Sites /></div></div>;

  return (
    // keyed views: switching view must not reuse the list's scrolled container
    <div class="screen" key="main">
      <TopBar title={t('settings.title')} />
      <div class="content" ref={mainRef}>
        <div class="section-title">{t('settings.general')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          <Row icon="globe" title={t('settings.metamask')} sub={t('settings.metamask.sub')} right={<Switch on={s.metamaskCompat} onChange={(v) => save({ metamaskCompat: v })} />} onClick={() => save({ metamaskCompat: !s.metamaskCompat })} />
          <div class="item col-item">
            <div class="row" style={{ width: '100%', gap: '0.625rem' }}>
              <div class="tx-icon" style={{ background: 'var(--card-2)', color: 'var(--primary)' }}><Icon name="eye" /></div>
              <div class="grow"><div class="bold">{t('settings.theme')}</div><div class="small muted">{t('settings.theme.sub')}</div></div>
            </div>
            <div class="seg seg-full" role="radiogroup">
              {[['system', t('settings.theme.system')], ['light', t('settings.theme.light')], ['dark', t('settings.theme.dark')]].map(([v, l]) => (
                <button class={(s.theme || 'system') === v ? 'on' : ''} role="radio" aria-checked={(s.theme || 'system') === v} onClick={() => save({ theme: v })}>{l}</button>
              ))}
            </div>
          </div>
          <Row icon="globe" title={t('settings.language')} sub={languageState(s.language).label} onClick={() => setSheet('language')}
            right={<Flag code={languageState(s.language).code} size={30} />} />
          <Row icon="coins" title={t('settings.currency')} sub={`${s.currency || 'USD'} · ${currencyName(s.currency || 'USD')}`} onClick={() => setSheet('currency')}
            right={<CurrencyBadge code={s.currency} />} />
          {globalThis.__CK_NOTIFY__ && (
            <Row icon="bell" title={t('settings.notifications')} sub={t('settings.notifications.sub')}
              right={<Switch on={s.notifications !== false} onChange={toggleNotif} />} onClick={() => toggleNotif(s.notifications === false)} />
          )}
          <Row icon="lock" title={t('settings.autoLock')} sub={t('settings.autoLock.sub')} onClick={() => setSheet('autoLock')}
            right={<span class="value-pill">{autoLockLabel(s.autoLockMin ?? 15)}</span>} />
          <Row icon="eye" title={t('settings.showUnpriced')} sub={t('settings.showUnpriced.sub')} right={<Switch on={s.showUnpriced} onChange={(v) => save({ showUnpriced: v })} />} onClick={() => save({ showUnpriced: !s.showUnpriced })} />
          <Row icon="globe" title={t('settings.networks.title')} sub={tn('settings.networks.count', [...builtinNetworks(), ...state.customChains].filter((c) => isChainEnabled(c.id, s)).length)} onClick={() => openView('networks')} right={<span class="muted"><Icon name="forward" /></span>} />
          <Row icon="wallet" title={t('settings.wallets')} sub={tn('settings.wallets.sub', state.wallets.length, { name: state.wallets.find((w) => w.id === state.activeWallet)?.name })} onClick={() => nav('wallets')} right={<span class="muted"><Icon name="forward" /></span>} />
          {globalThis.__CK_MOBILE__ && ( // the in-app browser exists only in the Android app
            <Row icon="search" title={t('settings.search')} sub={t('settings.search.sub')} onClick={() => setSheet('search')}
              right={<span class="value-pill">{searchEngine(s.searchEngine).name}</span>} />
          )}
          <Row icon="contract" title={t('settings.sites.title')} sub={tn('settings.sites.count', connectedSites(state).length)} onClick={() => openView('sites')} right={<span class="muted"><Icon name="forward" /></span>} />
        </div>

        <div class="section-title">{t('settings.security')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          {state.wallets.find((w) => w.id === state.activeWallet)?.hasSeed && <Row icon="phrase" title={t('settings.seed.show')} sub={t('settings.seed.sub', { name: state.wallets.find((w) => w.id === state.activeWallet)?.name })} onClick={() => setSheet('seed')} />}
          {globalThis.__CK_BIO__ && (
            <Row icon="fingerprint" title={t('settings.bio')} sub={bio.available ? t('settings.bio.sub') : t('settings.bio.none')}
              right={<Switch on={bio.enabled} onChange={async (v) => (v ? bio.available && setSheet('bio') : (await globalThis.__CK_BIO__.disable(), loadBio(), toast(t('settings.bio.disabled'))))} />}
              onClick={async () => (bio.enabled ? (await globalThis.__CK_BIO__.disable(), loadBio(), toast(t('settings.bio.disabled'))) : bio.available && setSheet('bio'))} />
          )}
          <Row icon="eyeOff" title={t('settings.privacy')} sub={t('settings.privacy.sub')} right={<Switch on={!!s.privacyMode} onChange={(v) => save({ privacyMode: v })} />} onClick={() => save({ privacyMode: !s.privacyMode })} />
          <Row icon="approve" title={t('settings.mev')} sub={t('settings.mev.sub')} right={<Switch on={s.mevProtect !== false} onChange={(v) => save({ mevProtect: v })} />} onClick={() => save({ mevProtect: s.mevProtect === false })} />
          <Row icon="lock" title={t('settings.pw.title')} onClick={() => setSheet('pw')} />
          <Row icon="fileUp" title={t('settings.export.title')} sub={t('settings.export.sub')} onClick={() => setSheet('exportBackup')} />
          <Row icon="fileDown" title={t('settings.import.title')} sub={t('settings.import.sub')} onClick={() => setSheet('importBackup')} />
        </div>

        <div class="section-title">{t('settings.advanced')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          <Row icon="warn" title={t('settings.ethSign')} sub={s.allowEthSign ? t('settings.ethSign.subOn') : t('settings.ethSign.subOff')}
            right={<Switch on={s.allowEthSign} onChange={(v) => (v ? setSheet('ethsign') : save({ allowEthSign: false }))} />}
            onClick={() => (s.allowEthSign ? save({ allowEthSign: false }) : setSheet('ethsign'))} />
        </div>

        <div class="section-title">{t('settings.data')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          <Row icon="key" title={t('keys.title')} sub={t('keys.row', keysCount(s))} onClick={() => openView('keys')} right={<span class="muted"><Icon name="forward" /></span>} />
        </div>
        {globalThis.__CK_NOTIFY__ && ( // Android: the Predictions tab and its "Per te" suggestions
          <div class="card" style={{ padding: '0.375rem' }}>
            <Row icon="predict" title={t('settings.taste.reset')} sub={t('settings.taste.sub')} onClick={() => setSheet('resetTaste')} />
          </div>
        )}

        <div class="section-title">{t('crash.help')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          <Row icon="warn" title={t('crash.settings.title')} sub={crashCount ? t('crash.settings.sub', { n: crashCount }) : t('crash.settings.none')}
            onClick={() => setSheet('crashes')} right={<span class="muted"><Icon name="forward" /></span>} />
        </div>

        <div class="section-title red">{t('settings.danger')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          <Row icon="trash" title={t('settings.reset')} sub={t('settings.reset.sub')} onClick={() => setSheet('reset')} />
        </div>
        <div class="tiny muted center">Chakra v{__VERSION__}{build ? ` (${build})` : ''} · <button class="link tiny" onClick={() => setSheet('terms')}>{t('terms.read')}</button> · <a class="link tiny" href={PRIVACY_URL} target="_blank" rel="noopener" data-external>{t('terms.privacy')}</a></div>
      </div>

      {sheet === 'pw' && <ChangePassword onClose={() => setSheet(null)} />}
      {sheet === 'bio' && (
        <PasswordPrompt title={t('settings.bio')} onClose={() => { setSheet(null); loadBio(); }}
          warning={t('settings.bio.warning')}
          action={async (pw) => {
            await bg('checkPassword', { password: pw });
            await globalThis.__CK_BIO__.enable({ password: pw });
            await loadBio(); toast(t('settings.bio.enabled')); setSheet(null);
            return true;
          }} />
      )}
      {sheet === 'exportBackup' && <ExportBackup onClose={() => setSheet(null)} />}
      {sheet === 'terms' && <TermsSheet onClose={() => setSheet(null)} />}
      {sheet === 'crashes' && <CrashList onClose={() => { setSheet(null); crashLog().then((l) => setCrashCount(l.length)).catch(() => {}); }} />}
      {sheet === 'importBackup' && <ImportBackup onClose={() => setSheet(null)} />}
      {sheet === 'language' && <LanguageSheet value={s.language} onPick={(v) => save({ language: v })} onClose={() => setSheet(null)} />}
      {sheet === 'resetTaste' && (
        <Sheet title={t('settings.taste.confirmTitle')} onClose={() => setSheet(null)}>
          <span class="small">{t('settings.taste.confirmBody', { name: account.name })}</span>
          <div class="row" style={{ gap: '.5rem' }}>
            <Btn kind="secondary" class="grow" onClick={() => setSheet(null)}>{t('common.cancel')}</Btn>
            <Btn kind="danger" class="grow" onClick={async () => { await resetTaste(account.address); setSheet(null); toast(t('settings.taste.done')); }}>{t('settings.taste.confirm')}</Btn>
          </div>
        </Sheet>
      )}
      {sheet === 'currency' && <CurrencySheet value={s.currency} onPick={(v) => save({ currency: v })} onClose={() => setSheet(null)} />}
      {sheet === 'search' && <SearchEngineSheet value={s.searchEngine} onPick={(v) => save({ searchEngine: v })} onClose={() => setSheet(null)} />}
      {sheet === 'autoLock' && <AutoLockSheet value={s.autoLockMin} onPick={(v) => save({ autoLockMin: v })} onClose={() => setSheet(null)} />}
      {sheet === 'ethsign' && (
        <Sheet title={t('settings.ethSign.sheetTitle')} onClose={() => setSheet(null)}>
          <div class="error small">
            {t('settings.ethSign.warnPre')} <b>eth_sign</b> {t('settings.ethSign.warnPost')}
          </div>
          <div class="small muted">{t('settings.ethSign.note')}</div>
          <div class="row">
            <Btn kind="secondary" class="grow" onClick={() => setSheet(null)}>{t('common.cancel')}</Btn>
            <Btn kind="danger" class="grow" onClick={async () => { await save({ allowEthSign: true }); setSheet(null); }}>{t('settings.ethSign.enable')}</Btn>
          </div>
        </Sheet>
      )}
      {sheet === 'seed' && (
        <PasswordPrompt title={t('settings.seed.title')} onClose={() => setSheet(null)} action={(pw) => bg('revealMnemonic', { password: pw })}
          warning={t('settings.seed.warning')}>
          {(m) => (
            <>
              <SecureScreen />
              <div class="seed-grid">{m.split(' ').map((w, i) => <div class="seed-word"><span>{i + 1}.</span>{w}</div>)}</div>
              <CopyPhrase phrase={m} />
              <Btn kind="secondary" onClick={() => setSheet(null)}>{t('common.close')}</Btn>
            </>
          )}
        </PasswordPrompt>
      )}
      {sheet === 'reset' && (
        <PasswordPrompt title={t('settings.reset')} danger onClose={() => setSheet(null)} action={async (pw) => { await bg('resetWallet', { password: pw }); await globalThis.__CK_BIO__?.disable().catch(() => {}); await refresh(); return true; }}
          warning={t('settings.reset.warning')} />
      )}
    </div>
  );
}
