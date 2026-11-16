// Terms of use: accepted in the onboarding (welcome step), readable again from Settings. The text is in the locales
// (terms.*). TERMS_VERSION goes up when it changes in substance: settings.termsAccepted keeps the version accepted,
// and a wallet that hasn't accepted the current one is asked again after unlocking (TermsGate).
import { useState } from 'preact/hooks';
import { Sheet, Btn, TopBar, useApp } from './components.jsx';
import { bg } from '../shared/ext.js';
import { t } from '../shared/i18n.js';

export const TERMS_VERSION = 1;
const SECTIONS = 10;

/** The current version isn't accepted yet. */
export const needsTerms = (settings) => (settings?.termsAccepted?.version || 0) < TERMS_VERSION;
export const acceptTerms = () => bg('saveSettings', { settings: { termsAccepted: { version: TERMS_VERSION, at: Date.now() } } });

function TermsBody() {
  return (
    <div class="terms">
      <p class="tiny muted">{t('terms.updated')}</p>
      <p class="small">{t('terms.intro')}</p>
      {Array.from({ length: SECTIONS }, (_, i) => (
        <section>
          <b class="small">{i + 1}. {t(`terms.${i + 1}.t`)}</b>
          <p class="small muted">{t(`terms.${i + 1}.b`)}</p>
        </section>
      ))}
    </div>
  );
}

export function TermsSheet({ onClose, onAccept }) {
  return (
    <Sheet title={t('terms.title')} onClose={onClose}>
      <TermsBody />
      {onAccept && <Btn onClick={onAccept}>{t('terms.accept')}</Btn>}
    </Sheet>
  );
}

/** Full screen after unlocking, when the current terms aren't accepted (a wallet from before, or new terms). */
export function TermsGate() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <div class="screen">
      <TopBar title={t('terms.title')} onBack={false} />
      <div class="content">
        <div class="info small">{t('terms.gate')}</div>
        <TermsBody />
      </div>
      <div class="footer">
        <Btn loading={busy} onClick={async () => { setBusy(true); await acceptTerms().catch(() => {}); await refresh(); setBusy(false); }}>{t('terms.accept')}</Btn>
      </div>
    </div>
  );
}
