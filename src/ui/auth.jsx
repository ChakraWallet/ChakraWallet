// Authorization for anything that signs or moves funds: fingerprint (Android app, when enabled) or wallet password.
// The background re-verifies the password on every signing request, so this is the UI half of the check.
import { useState, useEffect, useCallback } from 'preact/hooks';
import { Sheet, Btn, Icon } from './components.jsx';
import { t } from '../shared/i18n.js';

export const WRONG_PASSWORD = 'errors.wrongPassword'; // error key (see i18nError)
const bio = () => globalThis.__CK_BIO__ || null;

export async function bioStatus() {
  if (!bio()) return { available: false, enabled: false };
  try { return await bio().status(); } catch { return { available: false, enabled: false }; }
}

// Native prompt -> password. Returns null when cancelled / unavailable; throws a readable message when invalidated.
export async function bioPassword(title) {
  try { return (await bio().unlock({ title, negative: t('auth.usePassword') })).password; } catch (e) {
    if (e?.code === 'invalidated') throw new Error(t('auth.bioInvalidated'));
    return null;
  }
}

export const cancelled = () => Object.assign(new Error(t('auth.cancelled')), { cancelled: true });

// Hook used once at the app root: returns [authorize, element].
// authorize(action, title) asks for fingerprint/password, runs action(password) and resolves with its result.
// A wrong password keeps the sheet open; closing it rejects with an error flagged `cancelled`.
export function useAuthorizer() {
  const [req, setReq] = useState(null);
  const authorize = useCallback((action, title = t('auth.confirm')) => new Promise((resolve, reject) => setReq({ action, title, resolve, reject })), []);
  const el = req && <AuthSheet {...req} close={() => setReq(null)} />;
  return [authorize, el];
}

function AuthSheet({ action, title, resolve, reject, close }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [useBio, setUseBio] = useState(false);

  const run = async (password, fromBio) => {
    setLoading(true); setErr('');
    try {
      const r = await action(password);
      close(); resolve(r);
    } catch (e) {
      if (e?.key !== WRONG_PASSWORD) { close(); reject(e); return; }
      if (fromBio) { await bio()?.disable().catch(() => {}); setUseBio(false); setErr(t('auth.bioDisabled')); }
      else setErr(e.message);
      setLoading(false);
    }
  };

  const tryBio = async () => {
    setErr('');
    try {
      const p = await bioPassword(title);
      if (p) await run(p, true);
    } catch (e) { setUseBio(false); setErr(e.message); }
  };

  useEffect(() => {
    bioStatus().then((s) => { if (s.enabled) { setUseBio(true); tryBio(); } });
  }, []);

  const cancel = () => { if (loading) return; close(); reject(cancelled()); };

  return (
    <Sheet title={title} onClose={cancel}>
      {useBio && (
        <Btn kind="secondary" loading={loading} onClick={tryBio}><Icon name="fingerprint" size={20} /> {t('auth.useFingerprint')}</Btn>
      )}
      <div class="field">
        <label>{useBio ? t('auth.orPassword') : t('common.walletPassword')}</label>
        <input class="input" type="password" value={pw} autoFocus={!useBio}
          onInput={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && !loading && run(pw)} />
      </div>
      {err && <div class="error">{err}</div>}
      <Btn loading={loading} disabled={!pw} onClick={() => run(pw)}>{t('auth.authorize')}</Btn>
    </Sheet>
  );
}
