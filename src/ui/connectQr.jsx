// "Connect with QR": the camera reads the code a dapp shows on another screen (WalletConnect, TON Connect: see
// connectors.js) and the connection starts, with its approval screen. A dapp on the phone itself gives a link to copy
// instead: it can be pasted in Settings > Connected sites (ConnectLinkField). The button only asks; the scanner is drawn once, by the
// host at the top of the app, so it covers the whole screen wherever the button is (e.g. inside the balance card).
import { useEffect, useState } from 'preact/hooks';
import { Btn, Icon, useApp } from './components.jsx';
import { QrScanner } from './scanner.jsx';
import { hasConnectors, connectorFor } from './connectors.js';
import { t } from '../shared/i18n.js';

const EVENT = 'ck-connect-qr';

/**
 * The button (nothing when no protocol is registered). family: only when a protocol connects that family's networks
 * (the wallet card: TON Connect on TON, not on the others). children: an optional label next to the icon.
 */
export function ConnectQrButton({ class: cls = 'iconbtn hero-btn', size = 15, family, children }) {
  if (!hasConnectors(family)) return null;
  return (
    <button class={cls} title={t('connect.qr.title')} onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event(EVENT)); }}>
      <Icon name="qr" size={size} />{children}
    </button>
  );
}

/** The scanner, opened by any ConnectQrButton. */
export function ConnectQrHost() {
  const { toast } = useApp();
  const [scan, setScan] = useState(false);
  useEffect(() => {
    const open = () => setScan(true);
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);
  if (!scan || !hasConnectors()) return null;
  const onResult = (text) => {
    setScan(false);
    const c = connectorFor(text);
    if (!c) { toast(t('connect.qr.unknown'), 'warn'); return; }
    c.open(text).catch((e) => toast(e.message, 'warn'));
  };
  return <QrScanner onResult={onResult} onClose={() => setScan(false)} hint={t('connect.qr.hint')} />;
}

/** A connection link pasted (a dapp on this same phone: "copy link"), for any registered protocol. */
export function ConnectLinkField() {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!hasConnectors()) return null;
  const go = async () => {
    const link = text.trim();
    const c = connectorFor(link);
    if (!c) { toast(t('connect.qr.unknown'), 'warn'); return; }
    setBusy(true);
    try { await c.open(link); setText(''); } catch (e) { toast(e.message, 'warn'); } finally { setBusy(false); }
  };
  return (
    <div class="row" style={{ gap: '.5rem' }}>
      <input class="input grow" placeholder={t('connect.link.placeholder')} value={text} onInput={(e) => setText(e.target.value)} autocomplete="off" autocapitalize="off" spellcheck={false} />
      <Btn kind="secondary" loading={busy} disabled={!text.trim()} onClick={go}>{t('connect.link.button')}</Btn>
    </div>
  );
}
