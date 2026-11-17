// Full-screen QR scanner: live camera preview and a viewfinder that, when a code is found, glides onto it, draws a
// check, then fades out with the camera and hands the text over: onResult(text). Everything that moves is animated
// with transforms and opacity only (smooth on phones). Uses the system BarcodeDetector when available, otherwise
// jsQR on a small frame.
import { useEffect, useRef, useState } from 'preact/hooks';
import jsQR from 'jsqr';
import { Icon } from './components.jsx';
import { startScanField } from './scanField.js';
import { t } from '../shared/i18n.js';

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// From the code found to the result, about 1.5 s: the viewfinder glides onto it (0.45 s), the check opens and is drawn
// (until 0.95 s), stays a moment, then the scanner fades out and the app gets the result.
const RESULT_MS = 1250;
const FADE_MS = 280; // the fade-out (also when closing)

/**
 * The viewfinder at rest: a square in the middle of the screen, a little above the centre. r: the radius of the hole's
 * corners, concentric with the arc of the corner marks (outer radius 1.25rem, 4px thick, set 2px outside the box):
 * the hole's edge runs along the middle of the marks, with no gap.
 */
function restingBox() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const size = Math.min(window.innerWidth * 0.7, 16 * rem);
  return { x: (window.innerWidth - size) / 2, y: window.innerHeight * 0.45 - size / 2, w: size, h: size, r: 1.25 * rem - 2 };
}

export function QrScanner({ onResult, onClose, hint }) {
  const video = useRef(null);
  const stream = useRef(null);
  const timers = useRef([]);
  const fieldCanvas = useRef(null);
  const gridCanvas = useRef(null);
  const field = useRef(null); // the animated field inside the viewfinder (scanField.js)
  const [error, setError] = useState('');
  const [base] = useState(restingBox);
  const [box, setBox] = useState(null); // the code found, on screen (with a margin)
  const [found, setFound] = useState(false);
  const [live, setLive] = useState(false); // the camera's picture has arrived
  const [closing, setClosing] = useState(false);
  const [torch, setTorch] = useState(null); // null = not supported

  const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)); };
  /** Fades the scanner out, then `then()` (the parent removes it). */
  const leave = (then) => { setClosing(true); later(then, FADE_MS); };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    let alive = true, raf = 0, last = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'BarcodeDetector' in globalThis ? new globalThis.BarcodeDetector({ formats: ['qr_code'] }) : null;

    const toScreen = (pts, vw, vh) => { // video pixels -> on-screen box (the video is object-fit: cover), with a margin
      const el = video.current, r = el.getBoundingClientRect();
      const k = Math.max(r.width / vw, r.height / vh);
      const ox = r.left + (r.width - vw * k) / 2, oy = r.top + (r.height - vh * k) / 2;
      const xs = pts.map((p) => ox + p.x * k), ys = pts.map((p) => oy + p.y * k);
      const m = 10;
      return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m, h: Math.max(...ys) - Math.min(...ys) + 2 * m };
    };
    const done = (text, pts, vw, vh) => {
      if (!alive) return;
      alive = false;
      if (pts) setBox(toScreen(pts, vw, vh));
      setFound(true);
      field.current?.fadeOut();
      navigator.vibrate?.(30);
      later(() => leave(() => onResult(text)), RESULT_MS);
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

  useEffect(() => {
    if (error || !fieldCanvas.current) return undefined;
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    field.current = startScanField(fieldCanvas.current, gridCanvas.current, { width: base.w, height: base.h, reduced });
    return () => field.current?.stop();
  }, [error]);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ torch: !torch }] }); setTorch(!torch); } catch { /* not supported */ }
  };

  // The viewfinder keeps its resting place and size; once a code is found it moves onto it, by translations only
  // (nothing is scaled, so no curve or thickness changes on the way): the corner marks, each moved onto the code's
  // corner, and the darkened surround, made of four bands (one per side) and four rounded fillers that travel with
  // the marks. The surround is opaque black inside a translucent group: where bands overlap it isn't any darker.
  const g = box || base;
  const at = (r) => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const move = (dx, dy) => (dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : undefined);
  const left = g.x - base.x, top = g.y - base.y;
  const right = g.x + g.w - (base.x + base.w), bottom = g.y + g.h - (base.y + base.h);
  const corners = { tl: [left, top], tr: [right, top], bl: [left, bottom], br: [right, bottom] };
  const W = 3 * window.innerWidth, H = 3 * window.innerHeight, r = base.r;
  const bands = {
    top: { left: -W / 3, width: W, top: base.y - H, height: H, transform: move(0, top) },
    bottom: { left: -W / 3, width: W, top: base.y + base.h, height: H, transform: move(0, bottom) },
    left: { left: base.x - W, width: W, top: -H / 3, height: H, transform: move(left, 0) },
    right: { left: base.x + base.w, width: W, top: -H / 3, height: H, transform: move(right, 0) },
  };
  // each filler reaches 1px under the bands it meets (no lighter seam where their anti-aliased edges touch); the
  // centre of its curve stays at r from the hole's sides
  const fillers = {
    tl: { left: base.x - 1, top: base.y - 1 }, tr: { left: base.x + base.w - r, top: base.y - 1 },
    bl: { left: base.x - 1, top: base.y + base.h - r }, br: { left: base.x + base.w - r, top: base.y + base.h - r },
  };
  const px = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? `${v}px` : v]));
  return (
    <div class={`scanner ${closing ? 'closing' : ''}`} role="dialog" aria-label={t('scan.title')}>
      {/* transparent poster: hides the WebView's default grey "play" placeholder until the camera starts */}
      <video ref={video} class={live ? 'live' : ''} playsInline muted poster={BLANK} onPlaying={() => setLive(true)} />
      <div class={`scan-dim ${found ? 'found' : ''}`} style={{ '--r': `${r}px` }} aria-hidden="true">
        {Object.entries(bands).map(([k, s]) => <i class={`b ${k}`} style={px(s)} />)}
        {Object.entries(fillers).map(([k, s]) => <i class={`f ${k}`} style={{ ...px(s), transform: move(...corners[k]) }} />)}
      </div>
      {/* the field inside the hole: a grid lit by the scanning beam, with particles (scanField.js) */}
      <div class={`scan-area ${found ? 'found' : ''}`} style={{ ...at(base), '--r': `${r}px` }} aria-hidden="true">
        {!error && <><canvas class="scan-grid" ref={gridCanvas} /><canvas class="scan-field" ref={fieldCanvas} /></>}
      </div>
      <div class={`scan-corners ${found ? 'found' : ''}`} style={at(base)}>
        {Object.entries(corners).map(([k, [dx, dy]]) => <span class={`c ${k}`} style={{ transform: move(dx, dy) }}><i /></span>)}
      </div>
      {found && (
        <svg class="scan-check" style={{ left: `${g.x + g.w / 2}px`, top: `${g.y + g.h / 2}px` }} viewBox="0 0 64 64" aria-hidden="true">
          <circle class="ring" cx="32" cy="32" r="29" />
          <circle class="disc" cx="32" cy="32" r="29" />
          <path class="tick" d="M19.5 33.5 27.5 41.5 45 24" pathLength="1" />
        </svg>
      )}
      <div class="scan-top">
        <button class="scan-btn" onClick={() => leave(onClose)} title={t('common.close')}><Icon name="close" size={22} /></button>
        <span class="scan-title">{t('scan.title')}</span>
        {torch !== null ? <button class={`scan-btn ${torch ? 'on' : ''}`} onClick={toggleTorch} title={t('scan.torch')}><Icon name="flash" size={20} /></button> : <span style={{ width: '2.75rem' }} />}
      </div>
      <div class="scan-hint">{error || hint || t('scan.hint')}</div>
    </div>
  );
}
