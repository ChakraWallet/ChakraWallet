// "Connect with QR": the camera reads the code a dapp shows on another screen (TON Connect today, see connectors.js)
// and the connection starts, with its approval screen. The button only asks; the scanner is drawn once, by the
// host at the top of the app, so it covers the whole screen wherever the button is (e.g. inside the balance card).
import { useEffect, useState } from 'preact/hooks';
import { Icon, useApp } from './components.jsx';
import { QrScanner } from './scanner.jsx';
import { hasConnectors, connectorFor } from './connectors.js';
import { t } from '../shared/i18n.js';

const EVENT = 'ck-connect-qr';

/** The button (nothing when no protocol is registered). children: an optional label next to the icon. */
export function ConnectQrButton({ class: cls = 'iconbtn hero-btn', size = 15, children }) {
  if (!hasConnectors()) return null;
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
