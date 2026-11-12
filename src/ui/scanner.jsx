// Full-screen QR scanner: live camera preview, an animated viewfinder that locks onto the code when found,
// then onResult(text). Uses the system BarcodeDetector when available, otherwise jsQR on a small frame.
import { useEffect, useRef, useState } from 'preact/hooks';
import jsQR from 'jsqr';
import { Icon } from './components.jsx';
import { t } from '../shared/i18n.js';

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function QrScanner({ onResult, onClose, hint }) {
  const video = useRef(null);
  const [error, setError] = useState('');
  const [box, setBox] = useState(null);       // detected code, in screen coordinates
  const [found, setFound] = useState(false);
  const [torch, setTorch] = useState(null);   // null = not supported
  const stream = useRef(null);

  useEffect(() => {
    let alive = true, raf = 0, last = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'BarcodeDetector' in globalThis ? new globalThis.BarcodeDetector({ formats: ['qr_code'] }) : null;

    const toScreen = (pts, vw, vh) => { // video pixels -> on-screen box (the video is object-fit: cover)
      const el = video.current, r = el.getBoundingClientRect();
      const k = Math.max(r.width / vw, r.height / vh);
      const ox = r.left + (r.width - vw * k) / 2, oy = r.top + (r.height - vh * k) / 2;
      const xs = pts.map((p) => ox + p.x * k), ys = pts.map((p) => oy + p.y * k);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    const done = (text, pts, vw, vh) => {
      if (!alive) return;
      alive = false;
      if (pts) setBox(toScreen(pts, vw, vh));
      setFound(true);
      navigator.vibrate?.(30);
      setTimeout(() => onResult(text), 420); // let the viewfinder lock on first
    };
    const tick = async (now) => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      const v = video.current;
      if (!v || v.readyState < 2 || now - last < 120) return;
      last = now;
      try {
        if (detector) {
          const [c] = await detector.detect(v);
          if (c?.rawValue) done(c.rawValue, c.cornerPoints, v.videoWidth, v.videoHeight);
          return;
        }
        const k = Math.min(1, 640 / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * k); canvas.height = Math.round(v.videoHeight * k);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
          const l = code.location;
          done(code.data, [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner].map((p) => ({ x: p.x / k, y: p.y / k })), v.videoWidth, v.videoHeight);
        }
      } catch { /* next frame */ }
    };
    (async () => {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (!alive) { stream.current.getTracks().forEach((x) => x.stop()); return; }
        video.current.srcObject = stream.current;
        await video.current.play().catch(() => {});
        const track = stream.current.getVideoTracks()[0];
        if (track?.getCapabilities?.().torch) setTorch(false);
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setError(e?.name === 'NotAllowedError' ? t('scan.denied') : t('scan.noCamera'));
      }
    })();
    return () => { alive = false; cancelAnimationFrame(raf); stream.current?.getTracks().forEach((x) => x.stop()); };
  }, []);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ torch: !torch }] }); setTorch(!torch); } catch { /* not supported */ }
  };

  // viewfinder: centered square, or the detected code once found
  const vf = box ? { left: `${box.x - 10}px`, top: `${box.y - 10}px`, width: `${box.w + 20}px`, height: `${box.h + 20}px` } : null;
  return (
    <div class="scanner" role="dialog" aria-label={t('scan.title')}>
      {/* transparent poster: hides the WebView's default grey "play" placeholder until the camera starts */}
      <video ref={video} playsInline muted poster={BLANK} />
      <div class={`scan-frame ${found ? 'found' : ''} ${vf ? 'locked' : ''}`} style={vf || undefined}>
        <span class="c tl" /><span class="c tr" /><span class="c bl" /><span class="c br" />
        {!found && <span class="scan-laser" />}
        {found && <span class="scan-ok"><Icon name="check" size={28} stroke={3} /></span>}
      </div>
      <div class="scan-top">
        <button class="scan-btn" onClick={onClose} title={t('common.close')}><Icon name="close" size={22} /></button>
        <span class="scan-title">{t('scan.title')}</span>
        {torch !== null ? <button class={`scan-btn ${torch ? 'on' : ''}`} onClick={toggleTorch} title={t('scan.torch')}><Icon name="flash" size={20} /></button> : <span style={{ width: '2.75rem' }} />}
      </div>
      <div class="scan-hint">{error || hint || t('scan.hint')}</div>
    </div>
  );
}
