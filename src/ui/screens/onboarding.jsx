// First run: welcome, preferences (look, currency, notifications), password, then create / import / restore.
// A mandala of rosettes rises from the bottom and draws one more ring at every step; it is complete at the end.
import { useState, useMemo, useEffect, useRef } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { AppIcon, Btn, Icon, Switch, ChainIcon, useApp, SecureScreen, rich, richText, CopyPhrase, mandalaRings } from '../components.jsx';
import { isChainEnabled, builtinNetworks, ALWAYS_ON, DEFAULT_ON } from '../../shared/chains.js';
import { bioStatus } from '../auth.jsx';
import { t, tn } from '../../shared/i18n.js';
import { Flag, LanguageSheet, languageState } from '../language.jsx';
import { CurrencyTiles } from '../pickers.jsx';
import { TermsSheet, acceptTerms } from '../terms.jsx';

function strength(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}
const LABELS = ['onboarding.strength.0', 'onboarding.strength.1', 'onboarding.strength.2', 'onboarding.strength.3', 'onboarding.strength.4']; // i18n keys
const COLORS = ['var(--red)', 'var(--red)', 'var(--amber)', 'var(--green)', 'var(--green)'];

const hasNotify = () => !!globalThis.__CK_NOTIFY__;
// main track (dots + mandala); seed / verify / import / backup all count as 'setup'
const track = () => ['welcome', 'look', 'currency', 'networks', ...(hasNotify() ? ['notify'] : []), 'password', 'choose', 'setup', 'done'];
const PREV = { look: 'welcome', currency: 'look', networks: 'currency', notify: 'networks', choose: 'password', seed: 'choose', verify: 'seed', import: 'choose', backup: 'choose' };
const prevOf = (step) => (step === 'password' ? (hasNotify() ? 'notify' : 'networks') : PREV[step]);

function Mandala({ level, total }) {
  const rings = mandalaRings();
  const done = level >= total - 1;
  const shown = done ? rings.length : 2 + Math.round((level / (total - 1)) * (rings.length - 3));
  return (
    <svg class={`ob-mandala ${done ? 'done' : ''}`} viewBox="0 0 100 100" aria-hidden="true"
      style={{ '--rise': `${(level / (total - 1)) * 20}%`, '--turn': `${level * 12}deg` }}>
      <g>{rings.map((d, i) => <path d={d} pathLength="1" class={rings.length - 1 - i < shown ? 'on' : ''} style={{ transitionDelay: `${(i % 3) * 0.12}s` }} />)}</g>
    </svg>
  );
}

function Step({ title, sub, center, children, foot }) {
  return (
    <>
      <div class={`ob-body ${center ? 'center' : ''}`}>
        {(title || sub) && <div class="ob-head">{title && <h1 class="ob-title">{title}</h1>}{sub && <p class="ob-sub">{sub}</p>}</div>}
        {children}
      </div>
      {foot && <div class="ob-foot">{foot}</div>}
    </>
  );
}

const Mock = () => <><i class="n" /><i class="a" /><i class="b" /><i class="c" /></>;

export function Onboarding({ onActive }) {
  const { refresh, state, toast } = useApp();
  const [step, setStep] = useState('welcome');
  const [dir, setDir] = useState('fwd');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [importText, setImportText] = useState('');
  const [backup, setBackup] = useState('');
  const [backupPw, setBackupPw] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [answers, setAnswers] = useState({});
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [langSheet, setLangSheet] = useState(false);
  const [bio, setBio] = useState({ available: false, enabled: false });
  const [agreed, setAgreed] = useState(false); // terms of use
  const [terms, setTerms] = useState(false);
  const pwInput = useRef(null);
  const s = state?.settings || {};

  const go = (to, d = 'fwd') => { setErr(''); setDir(d); setStep(to); };
  const goBack = () => { const p = prevOf(step); if (p) go(p, 'back'); return !!p; };

  // keep this screen up until "Open your wallet", even after the vault exists (the app would switch away)
  useEffect(() => { onActive?.(true); }, []);
  // Android back button: previous step
  useEffect(() => { globalThis.__CK_obBack = goBack; return () => { delete globalThis.__CK_obBack; }; }, [step]);
  useEffect(() => { if (step === 'done') bioStatus().then(setBio); }, [step]);
  // focus the password only after the slide-in, without scrolling (autofocus mid-animation shifted the screen)
  // first setup: the optional networks start switched off (the user adds the ones they use); once per visit of the
  // screen, and only while nothing was chosen yet (an empty list), so going back and forth keeps the choices
  const netsDefault = useRef(false);
  useEffect(() => {
    if (step !== 'networks' || netsDefault.current || state?.initialized) return;
    netsDefault.current = true;
    if ((s.disabledChains || []).length) return;
    const off = builtinNetworks().filter((c) => !c.testnet && !DEFAULT_ON.has(c.id)).map((c) => c.id);
    if (off.length) save({ disabledChains: off });
  }, [step]);
  useEffect(() => { if (step !== 'password') return; const id = setTimeout(() => pwInput.current?.focus({ preventScroll: true }), 520); return () => clearTimeout(id); }, [step]);

  const save = async (patch) => { await bg('saveSettings', { settings: patch }); await refresh(); };

  const words = mnemonic.split(' ');
  const quiz = useMemo(() => {
    if (!mnemonic) return [];
    const idx = new Set();
    while (idx.size < 3) idx.add(Math.floor(Math.random() * 12));
    return [...idx].sort((a, b) => a - b);
  }, [mnemonic]);

  const finish = async (phrase) => {
    setLoading(true); setErr('');
    try { await bg('createVault', { password: pw, mnemonic: phrase }); go('done'); } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  const restore = async () => {
    setLoading(true); setErr('');
    try { await bg('restoreBackup', { password: pw, backup, backupPassword: backupPw }); go('done'); } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  const enableNotify = async () => {
    const r = await globalThis.__CK_NOTIFY__.requestPermission().catch(() => ({ granted: false }));
    await save({ notifications: !!r.granted });
    if (!r.granted) toast(t('settings.notifications.denied'), 'warn');
    go('password');
  };
  const toggleBio = async (on) => {
    try {
      if (on) { await globalThis.__CK_BIO__.enable({ password: pw, title: t('settings.bio') }); toast(t('settings.bio.enabled')); }
      else { await globalThis.__CK_BIO__.disable(); }
    } catch { /* cancelled */ }
    setBio(await bioStatus());
  };
  const open = async () => { onActive?.(false); await refresh(); };

  let body;
  if (step === 'welcome') {
    body = (
      <Step center foot={<>
        <label class="ack row small ob-terms">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>{richText(t('terms.agree'), { terms: <button class="link" onClick={(e) => { e.preventDefault(); setTerms(true); }}>{t('terms.link')}</button> })}</span>
        </label>
        <Btn disabled={!agreed} onClick={async () => { await acceptTerms().catch(() => {}); go('look'); }}>{t('onboarding.welcome.start')}</Btn>
      </>}>
        <AppIcon size={104} class="ob-hero-icon" />
        <div class="ob-head">
          <h1 class="ob-title">{t('onboarding.welcome.title')}</h1>
          <p class="ob-sub">{t('onboarding.welcome.tagline')}<br />{t('onboarding.welcome.keysLocal')}</p>
        </div>
        <div class="ob-feats">
          {[['wallet', 'onboarding.welcome.featAccounts'], ['swap', 'onboarding.welcome.featSwap'], ['eye', 'onboarding.welcome.featFees']].map(([i, k]) => (
            <div class="ob-feat"><span class="ob-feat-ic"><Icon name={i} size={18} /></span><span>{t(k)}</span></div>
          ))}
        </div>
      </Step>
    );
  } else if (step === 'look') {
    const theme = s.theme || 'system', lang = s.language || 'system';
    body = (
      <Step title={t('onboarding.look.title')} sub={t('onboarding.look.sub')} foot={<Btn onClick={() => go('currency')}>{t('common.continue')}</Btn>}>
        <div class="ob-label">{t('settings.theme')}</div>
        <div class="ob-themes" role="radiogroup">
          {[['system', t('settings.theme.system')], ['light', t('settings.theme.light')], ['dark', t('settings.theme.dark')]].map(([v, l]) => (
            <button class={`ob-choice ${theme === v ? 'on' : ''}`} role="radio" aria-checked={theme === v} onClick={() => save({ theme: v })}>
              <span class={`ob-mock ${v === 'dark' ? 'dark' : 'light'}`}><Mock />{v === 'system' && <span class="ob-mock dark half"><Mock /></span>}</span>
              <span>{l}</span>
            </button>
          ))}
        </div>
        <div class="ob-label">{t('settings.language')}</div>
        <button class="ob-choice ob-lang" onClick={() => setLangSheet(true)}>
          <span class="grow">{languageState(lang).label}</span>
          <Flag code={languageState(lang).code} size={30} />
          <Icon name="chevron" size={16} />
        </button>
      </Step>
    );
  } else if (step === 'currency') {
    body = (
      <Step title={t('onboarding.currency.title')} sub={t('settings.currency.sub')}
        foot={<Btn onClick={() => go('networks')}>{t('common.continue')}</Btn>}>
        <CurrencyTiles value={s.currency} onPick={(c) => save({ currency: c })} />
      </Step>
    );
  } else if (step === 'networks') {
    // built-in mainnets only (custom networks are added later, from Settings or by a site). The always-on one
    // (Ethereum) stands apart; TON (in the app) starts on, the others off, and the user adds the ones they use.
    const mainnets = builtinNetworks().filter((c) => !c.testnet);
    const fixed = mainnets.filter((c) => ALWAYS_ON.has(c.id)), optional = mainnets.filter((c) => !ALWAYS_ON.has(c.id));
    const disabled = s.disabledChains || [];
    const toggle = (id) => save({ disabledChains: disabled.includes(id) ? disabled.filter((x) => x !== id) : [...disabled, id] });
    body = (
      <Step title={t('onboarding.networks.title')} sub={t('onboarding.networks.sub')}
        foot={<Btn onClick={() => go(hasNotify() ? 'notify' : 'password')}>{t('common.continue')}</Btn>}>
        <div class="ob-pinned" title={t('onboarding.networks.lockedHint')}>
          <span class="ob-pinned-k"><Icon name="lock" size={13} /> {tn('onboarding.networks.always', fixed.length)}</span>
          <span class="ob-pins">{fixed.map((c) => <span class="ob-pin"><ChainIcon chain={c} size={20} />{c.name}</span>)}</span>
        </div>
        <div class="ob-label">{t('onboarding.networks.add')}</div>
        <div class="ob-nets" role="group">
          {optional.map((c) => {
            const on = isChainEnabled(c.id, s);
            return (
              <button class={`ob-choice ob-net ${on ? 'on' : ''}`} role="checkbox" aria-checked={on} onClick={() => toggle(c.id)}>
                <ChainIcon chain={c} size={28} />
                <span class="grow">{c.name}</span>
                <span class="ob-net-tick">{on && <Icon name="check" size={14} stroke={3} />}</span>
              </button>
            );
          })}
        </div>
        <div class="small muted">{t('onboarding.networks.note')}</div>
      </Step>
    );
  } else if (step === 'notify') {
    body = (
      <Step title={t('onboarding.notify.title')} sub={t('onboarding.notify.sub')}
        foot={<><Btn onClick={enableNotify}>{t('onboarding.notify.enable')}</Btn><Btn kind="secondary" onClick={async () => { await save({ notifications: false }); go('password'); }}>{t('onboarding.notify.later')}</Btn></>}>
        <div class="ob-notifs" aria-hidden="true">
          {[[t('onboarding.notify.sampleTitle'), t('onboarding.notify.sampleWhere')], [t('onboarding.notify.sampleBridge'), t('onboarding.notify.sampleBridgeBody')]].map(([a, b]) => (
            <div class="ob-notif">
              <AppIcon size={36} />
              <div class="grow">
                <div class="ob-notif-app">Chakra · {t('onboarding.notify.now')}</div>
                <div class="bold">{a}</div>
                <div class="small muted">{b}</div>
              </div>
            </div>
          ))}
        </div>
      </Step>
    );
  } else if (step === 'password') {
    const st = strength(pw);
    const ok = pw.length >= 8 && pw === pw2;
    body = (
      <Step title={t('onboarding.password.title')} foot={<Btn disabled={!ok} onClick={() => go('choose')}>{t('common.continue')}</Btn>}>
        <div class="info small">{rich('onboarding.password.info', { notRecoverable: <b>{t('onboarding.password.notRecoverable')}</b> })}</div>
        <div class="field">
          <label>{t('onboarding.password.new')}</label>
          <input ref={pwInput} class="input" type="password" value={pw} onInput={(e) => setPw(e.target.value)} autoComplete="new-password" />
          {pw && (
            <div class="row small">
              <div class="ob-meter"><div style={{ width: `${(st + 1) * 20}%`, background: COLORS[st] }} /></div>
              <span style={{ color: COLORS[st] }}>{t(LABELS[st])}</span>
            </div>
          )}
        </div>
        <div class="field">
          <label>{t('onboarding.password.confirm')}</label>
          <input class="input" type="password" value={pw2} onInput={(e) => setPw2(e.target.value)} autoComplete="new-password" onKeyDown={(e) => e.key === 'Enter' && ok && go('choose')} />
          {pw2 && pw !== pw2 && <span class="small red">{t('common.passwordsDontMatch')}</span>}
        </div>
      </Step>
    );
  } else if (step === 'choose') {
    const opt = (icon, title, sub, onClick) => (
      <button class="ob-option" onClick={onClick}>
        <span class="ob-feat-ic"><Icon name={icon} size={20} /></span>
        <span class="grow"><span class="bold">{title}</span><span class="small muted">{sub}</span></span>
        <Icon name="chevron" size={18} />
      </button>
    );
    body = (
      <Step title={t('onboarding.choose.title')} sub={t('onboarding.choose.sub')}>
        {opt('plus', t('onboarding.choose.create'), t('onboarding.choose.createSub'), async () => { setMnemonic(await bg('generateMnemonic')); setRevealed(false); setAnswers({}); go('seed'); })}
        {opt('phrase', t('onboarding.choose.import'), t('onboarding.choose.importSub'), () => go('import'))}
        {opt('lock', t('onboarding.choose.restore'), t('onboarding.choose.restoreSub'), () => go('backup'))}
      </Step>
    );
  } else if (step === 'seed') {
    body = (
      <Step title={t('onboarding.seed.title')} foot={<Btn disabled={!revealed} onClick={() => go('verify')}>{t('onboarding.seed.saved')}</Btn>}>
        <div class="warn small"><b>{t('onboarding.seed.warnTitle')}</b> {t('onboarding.seed.warnBody')}</div>
        <SecureScreen />
        <div class={`seed-grid ${revealed ? '' : 'blur'}`} onClick={() => setRevealed(true)}>
          {words.map((w, i) => <div class="seed-word"><span>{i + 1}.</span>{w}</div>)}
        </div>
        {!revealed && <Btn kind="secondary" onClick={() => setRevealed(true)}><Icon name="eye" /> {t('onboarding.seed.reveal')}</Btn>}
        {revealed && <CopyPhrase phrase={mnemonic} />}
      </Step>
    );
  } else if (step === 'verify') {
    const ok = quiz.every((i) => (answers[i] || '').trim().toLowerCase() === words[i]);
    body = (
      <Step title={t('onboarding.verify.title')} sub={t('onboarding.verify.prompt')}
        foot={<Btn disabled={!ok} loading={loading} onClick={() => finish(mnemonic)}>{t('onboarding.verify.create')}</Btn>}>
        {quiz.map((i) => (
          <div class="field">
            <label>{t('onboarding.verify.word', { n: i + 1 })}</label>
            <input class="input" value={answers[i] || ''} onInput={(e) => setAnswers({ ...answers, [i]: e.target.value })} autoCapitalize="off" spellcheck={false} />
          </div>
        ))}
        {err && <div class="error">{err}</div>}
      </Step>
    );
  } else if (step === 'backup') {
    body = (
      <Step title={t('onboarding.backup.title')} foot={<Btn disabled={!backup.trim() || !backupPw} loading={loading} onClick={restore}>{t('onboarding.backup.restore')}</Btn>}>
        <div class="field">
          <label>{t('onboarding.backup.text')}</label>
          <textarea class="input mono" rows={5} value={backup} onInput={(e) => setBackup(e.target.value)} placeholder="CHAKRA-BACKUP-2:…" spellcheck={false} autoCapitalize="off" />
          <BackupFile onLoad={setBackup} />
        </div>
        <div class="field">
          <label>{t('onboarding.backup.password')}</label>
          <input class="input" type="password" value={backupPw} onInput={(e) => setBackupPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && backup && backupPw && restore()} />
        </div>
        <div class="small muted">{t('onboarding.backup.note')}</div>
        {err && <div class="error">{err}</div>}
      </Step>
    );
  } else if (step === 'import') {
    const count = importText.trim().split(/\s+/).filter(Boolean).length;
    body = (
      <Step title={t('onboarding.import.title')} foot={<Btn disabled={![12, 15, 18, 21, 24].includes(count)} loading={loading} onClick={() => finish(importText)}>{t('common.import')}</Btn>}>
        <div class="field">
          <label>{t('onboarding.import.phrase')}</label>
          <textarea class="input mono" rows={4} value={importText} onInput={(e) => setImportText(e.target.value)} placeholder={t('onboarding.import.placeholder')} spellcheck={false} />
          <span class="small muted">{tn('onboarding.import.words', count)}</span>
        </div>
        <div class="small muted">{t('onboarding.import.note')}</div>
        {err && <div class="error">{err}</div>}
      </Step>
    );
  } else { // done
    body = (
      <Step center foot={<Btn onClick={open}>{t('onboarding.done.open')}</Btn>}>
        <span class="ob-done-badge"><AppIcon size={104} class="ob-hero-icon" /><span class="ob-check"><Icon name="check" size={20} stroke={3} /></span></span>
        <div class="ob-head">
          <h1 class="ob-title">{t('onboarding.done.title')}</h1>
          <p class="ob-sub">{t('onboarding.done.sub')}</p>
        </div>
        {bio.available && (
          <div class="ob-option ob-bio">
            <span class="ob-feat-ic"><Icon name="fingerprint" size={20} /></span>
            <span class="grow"><span class="bold">{t('settings.bio')}</span><span class="small muted">{t('settings.bio.sub')}</span></span>
            <Switch on={bio.enabled} onChange={toggleBio} />
          </div>
        )}
      </Step>
    );
  }

  const tr = track();
  const pos = tr.indexOf(['seed', 'verify', 'import', 'backup'].includes(step) ? 'setup' : step);
  const dots = tr.slice(1, -1); // no dot for the welcome and final screens
  return (
    <div class="screen ob" onScroll={(e) => { e.currentTarget.scrollLeft = 0; e.currentTarget.scrollTop = 0; }}>
      <div class="ob-bg"><Mandala level={pos} total={tr.length} /></div>
      <div class="ob-top">
        {prevOf(step) ? <button class="iconbtn" onClick={goBack} title={t('common.back')}><Icon name="back" /></button> : <span class="ob-top-gap" />}
        {step !== 'welcome' && step !== 'done' && (
          <div class="ob-dots" aria-hidden="true">{dots.map((_, i) => <i class={i + 1 === pos ? 'on' : i + 1 < pos ? 'past' : ''} />)}</div>
        )}
        <span class="ob-top-gap" />
      </div>
      <div class={`ob-stage ${dir}`} key={step}>{body}</div>
      {langSheet && <LanguageSheet value={s.language} onPick={(v) => save({ language: v })} onClose={() => setLangSheet(false)} />}
      {terms && <TermsSheet onClose={() => setTerms(false)} onAccept={() => { setAgreed(true); setTerms(false); }} />}
    </div>
  );
}

// Loads a backup .txt file into the textarea (paste works everywhere; this is a convenience)
export function BackupFile({ onLoad }) {
  return (
    <label class="link small" style={{ cursor: 'pointer' }}>
      {t('onboarding.backup.loadFile')}
      <input type="file" accept=".txt,text/plain" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) onLoad((await f.text()).trim()); e.target.value = ''; }} />
    </label>
  );
}
