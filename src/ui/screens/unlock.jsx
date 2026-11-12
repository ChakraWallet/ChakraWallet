import { useState, useEffect, useRef } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { AppIcon, Icon, Spinner, useApp, appIconRings } from '../components.jsx';
import { bioStatus, bioPassword, WRONG_PASSWORD } from '../auth.jsx';
import { t, tn } from '../../shared/i18n.js';

export function Unlock() {
  const { refresh, mode, state } = useApp();
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [shake, setShake] = useState(0);
  const [loading, setLoading] = useState(false);
  const [bio, setBio] = useState(false);
  const input = useRef(null);

  const submit = async (password = pw, fromBio = false) => {
    if (!password || loading) return;
    setLoading(true); setErr('');
    try { await bg('unlock', { password }); await refresh(); } catch (e) {
      if (fromBio && e.key === WRONG_PASSWORD) {
        await globalThis.__CK_BIO__?.disable().catch(() => {}); setBio(false);
        setErr(t('auth.bioDisabled'));
      } else {
        setErr(e.message);
        if (e.key === WRONG_PASSWORD) { setShake((n) => n + 1); setPw(''); input.current?.focus(); }
      }
      setLoading(false);
    }
  };

  const tryBio = async () => {
    setErr('');
    try { const p = await bioPassword(t('unlock.bioTitle')); if (p) await submit(p, true); } catch (e) { setBio(false); setErr(e.message); }
  };

  useEffect(() => { bioStatus().then((s) => { if (s.enabled) { setBio(true); tryBio(); } }); }, []);

  return (
    <div class="screen unlock">
      <svg class="unlock-bg" viewBox="0 0 100 100" aria-hidden="true">
        {appIconRings().map((r) => <path d={r.d} fill="none" stroke="currentColor" stroke-width=".18" />)}
      </svg>
      <div class="unlock-main">
        <AppIcon size={92} class="unlock-icon" />
        <div class="unlock-text">
          <h1>{t('unlock.title')}</h1>
          <p class="muted">{mode === 'approve' ? t('unlock.promptSite') : t('unlock.prompt')}</p>
        </div>
        {state?.pending > 0 && <div class="unlock-pending"><Icon name="warn" size={14} />{tn('unlock.pending', state.pending)}</div>}

        <form class={`pw-field ${err ? 'has-err' : ''} ${shake ? 'shake' : ''}`} key={shake} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <span class="pw-lead"><Icon name="lock" size={18} /></span>
          <input ref={input} type={show ? 'text' : 'password'} placeholder={t('common.password')} value={pw} autoFocus={!bio}
            autoComplete="current-password" onInput={(e) => { setPw(e.target.value); if (err) setErr(''); }} />
          <button type="button" class="pw-eye" onClick={() => setShow(!show)} title={show ? t('common.hide') : t('common.show')}><Icon name={show ? 'eyeOff' : 'eye'} size={18} /></button>
          <button type="submit" class="pw-go" disabled={!pw || loading} title={t('unlock.unlock')}>{loading ? <Spinner /> : <Icon name="send" size={18} stroke={2.4} />}</button>
        </form>
        {err && <div class="unlock-err">{err}</div>}

        {bio && (
          <button class="bio-btn" disabled={loading} onClick={tryBio}>
            <span class="bio-ring"><Icon name="fingerprint" size={30} stroke={1.7} /></span>
            <span>{t('auth.useFingerprint')}</span>
          </button>
        )}
      </div>
      <div class="unlock-foot">{t('unlock.forgot')}</div>
    </div>
  );
}
