import { useEffect, useState, useContext, useRef, useMemo } from 'preact/hooks';
import { createContext } from 'preact';
import QRCode from 'qrcode';
import { fmtAmount, fmtUsd, toFloat, shortAddr } from '../shared/format.js';
import { SPEEDS } from '../shared/tx.js';
import { ext } from '../shared/ext.js';
import { t } from '../shared/i18n.js';
import { MARK, ringPaths, sparkPoints } from '../shared/mandala.js';
import { ChainLogo, hasChainLogo, symbolLogoId } from './logos.jsx';

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// ---- privacy mode: balances hidden ("••••") until the eye is tapped; hidden again at every opening when the
// setting is on (src/ui/app.jsx). m(text) masks an amount the user holds (prices and quotes are not masked).
export const MASK = '••••';
const noPrivacy = { hidden: false, toggle: () => {}, m: (x) => x };
export const usePrivacy = () => useContext(AppCtx)?.privacy || noPrivacy;
/** The eye on a balance card: shows / hides the amounts. */
export function PrivacyBtn({ class: cls = 'iconbtn hero-btn' }) {
  const { hidden, toggle } = usePrivacy();
  return <button class={cls} title={t(hidden ? 'privacy.show' : 'privacy.hide')} aria-pressed={hidden} onClick={(e) => { e.stopPropagation(); toggle(); }}><Icon name={hidden ? 'eyeOff' : 'eye'} size={15} /></button>;
}

// ------------------------------------------------------------ icons (stroke style)
const P = {
  send: 'M5 12h14M13 6l6 6-6 6',
  receive: 'M12 5v14M6 13l6 6 6-6',
  swap: 'M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4',
  history: 'M12 8v4l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  lockOpen: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.75-1.4',
  fileUp: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 18v-6M9 15l3-3 3 3',
  fileDown: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 12v6M9 15l3 3 3-3',
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z',
  close: 'M18 6L6 18M6 6l12 12',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M20 6L9 17l-5-5',
  chevron: 'M6 9l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z',
  eyeOff: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20', // Lucide eye-off (ISC)
  key: 'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4zM16.5 7.5h.01', // Lucide key-round (ISC)
  phrase: 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  wifiOff: 'M12 20h.01M8.5 16.429a5 5 0 0 1 7 0M5 12.859a10 10 0 0 1 5.17-2.69M19 12.859a10 10 0 0 0-2.007-1.523M2 8.82a15 15 0 0 1 4.177-2.643M22 8.82a15 15 0 0 0-11.288-3.764M2 2l20 20', // Lucide wifi-off (ISC)
  signal: 'M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16', // Lucide signal (ISC): Tron's bandwidth
  timer: 'M10 2h4M12 14l3-3M20 14a8 8 0 1 1-16 0 8 8 0 0 1 16 0', // Lucide timer (ISC)
  vote: 'M9 12l2 2 4-4M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12H5zM22 19H2', // Lucide vote (ISC)
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4', // Lucide shield-check (ISC)
  share: 'M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M8.59 13.51l6.83 3.98M15.41 7.51l-6.82 3.98', // Lucide share-2 (ISC)
  flash: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z', // Lucide zap (ISC)
  camera: 'M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4zM9 13a3 3 0 1 0 6 0a3 3 0 1 0-6 0', // Lucide camera (ISC)
  mic: 'M12 19v3M19 10v2a7 7 0 0 1-14 0v-2M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z', // Lucide mic (ISC)
  mapPin: 'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0M9 10a3 3 0 1 0 6 0a3 3 0 1 0-6 0', // Lucide map-pin (ISC)
  bell: 'M10.268 21a2 2 0 0 0 3.464 0M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326', // Lucide bell (ISC)
  route: 'M3 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M15 5a3 3 0 1 0 6 0a3 3 0 1 0-6 0', // Lucide route (ISC)
  fingerprint: 'M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88M17.29 21.02c.12-.6.43-2.3.5-3.02M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .131-5.354 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2M8.65 22c.21-.66.45-1.32.57-2M9 6.8a6 6 0 0 1 9 5.2v2',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  mail: 'M3.5 5.5h17v13h-17zM4 6.5l8 6 8-6',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  chart: 'M4 4v16h16M7 15l4-5 3 3 5-6',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  globe: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20', // Lucide globe (ISC)
  approve: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4', // Lucide shield-check (ISC)
  contract: 'M8 6l-6 6 6 6M16 6l6 6-6 6',
  warn: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h12v3M16 13h.01',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  search: 'M21 21l-4.34-4.34M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0', // Lucide search (ISC)
  predict: 'M4.5 10.5a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0-15 0M7 16.1 5 21h14l-2-4.9M8.5 10a3.5 3.5 0 0 1 3.5-3.5', // crystal ball on its stand, with a highlight
  code: 'm18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16', // Lucide code-xml (ISC)
  heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z', // Lucide heart (ISC)
  // Predictions categories and feed: Lucide icons (ISC), shapes merged into one path
  flame: 'M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4', // Lucide flame
  sparkle: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594zM20 2v4M22 4h-4M2 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', // Lucide sparkles
  landmark: 'M10 18v-7M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949zM14 18v-7M18 18v-7M3 22h18M6 18v-7', // Lucide landmark
  trophy: 'M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3M4 22h16M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1zM6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3', // Lucide trophy
  grid: 'M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1zM15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1zM15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1zM4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1z', // Lucide layout-grid
  bitcoin: 'M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727', // Lucide bitcoin
  bars: 'M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3', // Lucide chart-column
  flag: 'M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528', // Lucide flag
  chip: 'M12 20v2M12 2v2M17 20v2M17 2v2M2 12h2M2 17h2M2 7h2M20 12h2M20 17h2M20 7h2M7 20v2M7 2v2M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2zM9 8h6a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z', // Lucide cpu
  film: 'm12.296 3.464 3.02 3.956M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3zM3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm6.18 5.276 3.1 3.899', // Lucide clapperboard
  coins: 'M13.744 17.736a6 6 0 1 1-7.48-7.48M15 6h1v4M6.134 14.768l.866-.5 2 3.464M10 8a6 6 0 1 0 12 0a6 6 0 1 0 -12 0', // Lucide coins
  bookmark: 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z', // Lucide bookmark
  arrowUp: 'm5 12 7-7 7 7M12 19V5', // Lucide arrow-up
  card: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20M6 15h4', // Lucide credit-card
};
// sizes are design px at 16px/rem: they scale with the root font size (larger in the app)
export const rem = (px) => `${px / 16}rem`;

export function Icon({ name, size = 18, stroke = 2 }) {
  return (
    <svg viewBox="0 0 24 24" style={{ width: rem(size), height: rem(size), flex: 'none' }} fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round">
      <path d={P[name]} />
    </svg>
  );
}

// The app icon (same design as the launcher icon rendered by scripts/icon.mjs), as crisp SVG at any size.
const ICON_RINGS = [[13, 5, 0.62, 0.47, 0.36], [13, 5, 0.62, 0.55, 0.36], [13, 5, 0.62, 0.63, 0.36], [7, 2, 0.44, 0.7, 0.22]];
let iconPaths = null;
export const appIconRings = () => (iconPaths ??= ICON_RINGS.map(([p, q, rad, dk, a]) => ({ d: rosette({ p, q, d: (q / p) * dk * 1.6, cx: 50, cy: 50, size: rad * 100, rot: 0 }), a })));
// Onboarding background: concentric rosettes from the icon outwards, drawn one by one as the steps advance.
const MANDALA = [[7, 2, 0.16, 0.7], [13, 5, 0.27, 0.47], [13, 5, 0.27, 0.63], [11, 4, 0.38, 0.55], [17, 6, 0.5, 0.5], [17, 6, 0.5, 0.62], [19, 7, 0.63, 0.5], [23, 8, 0.76, 0.46], [29, 10, 0.9, 0.5], [29, 10, 0.99, 0.58]];
let mandalaPaths = null;
export const mandalaRings = () => (mandalaPaths ??= MANDALA.map(([p, q, rad, dk]) => rosette({ p, q, d: (q / p) * dk * 1.6, cx: 50, cy: 50, size: rad * 49, rot: 0 })));
let shapes = null;
const markShapes = () => (shapes ??= { outer: ringPaths(MARK.outer), inner: ringPaths(MARK.inner), sparks: sparkPoints() });
export function AppIcon({ size = 72, class: cls = '' }) {
  return (
    <svg class={`app-icon ${cls}`} viewBox="0 0 100 100" style={{ width: rem(size), height: rem(size) }} aria-hidden="true">
      <defs>
        <linearGradient id="ck-ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#245CEE" /><stop offset="1" stop-color="#0D288C" /></linearGradient>
        <radialGradient id="ck-glow" cx=".25" cy=".2" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".16" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></radialGradient>
        <clipPath id="ck-clip"><rect width="100" height="100" rx="22.5" /></clipPath>
      </defs>
      <g clip-path="url(#ck-clip)">
        <rect width="100" height="100" fill="url(#ck-ink)" />
        <rect width="100" height="100" fill="url(#ck-glow)" />
        {appIconRings().map((r) => <path d={r.d} fill="none" stroke="#fff" stroke-width=".55" opacity={r.a} />)}
      </g>
      {/* the mandala: same geometry as the launcher icon (src/shared/mandala.js) */}
      {markShapes().sparks.map(([x, y]) => <circle cx={x} cy={y} r={MARK.sparks.size * 100} fill="#fff" opacity=".85" />)}
      {markShapes().outer.map((d) => <path d={d} fill="#C4D6FF" opacity={MARK.outer.alpha} />)}
      {markShapes().inner.map((d) => <path d={d} fill="#fff" />)}
      <circle cx="50" cy="50" r={MARK.core * 100} fill="#0F2E9E" stroke="#fff" stroke-width={MARK.ring * 100} />
      <circle cx="50" cy="50" r={MARK.bindu * 100} fill="#fff" />
    </svg>
  );
}
export function Logo() { return <AppIcon size={72} class="logo-icon" />; }

// ------------------------------------------------------------ card look from the address
// Security-print guilloche (hypotrochoid rosettes, like the line work on banknotes) and card colours are
// derived deterministically from the address: same account -> always the same card, different accounts -> different cards.
function seeded(str) {
  let h = 2166136261 >>> 0;
  for (const c of String(str || '').toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { // mulberry32
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// R/r = p/q in lowest terms: the curve closes after q turns and has p lobes
const RATIOS = [[5, 2], [7, 2], [7, 3], [8, 3], [9, 2], [9, 4], [10, 3], [11, 3], [11, 4], [12, 5], [13, 3], [13, 4], [13, 5], [15, 4], [17, 5], [19, 6]];
const W = 340, H = 214; // ISO credit-card proportions (85.6 x 54 mm)

function rosette({ p, q, d, cx, cy, size, rot, dir = 1 }) {
  const R = 1, r = q / p, ext = R - r + d, k = size / ext;
  const steps = 200 * q + 24 * p;
  let s = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * q;
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
    const y = (R - r) * Math.sin(t) - dir * d * Math.sin(((R - r) / r) * t);
    const xr = x * Math.cos(rot) - y * Math.sin(rot), yr = x * Math.sin(rot) + y * Math.cos(rot);
    s += `${i ? 'L' : 'M'}${(cx + xr * k).toFixed(1)} ${(cy + yr * k).toFixed(1)}`;
  }
  return s;
}

// The account's colours: first draws of the address-seeded sequence, shared by the card and the avatar dot.
function colorsFrom(rnd) {
  const hue = Math.floor(rnd() * 360);
  const hue2 = (hue + (rnd() < 0.5 ? -1 : 1) * (16 + Math.floor(rnd() * 36)) + 360) % 360;
  // yellow/green/cyan hues read washed out with white text: render them deeper
  const deep = (h) => (h >= 35 && h <= 200 ? 29 : 39);
  return { hue, hue2, l1: deep(hue), l2: deep(hue2) - 12 };
}
const colorCache = new Map();
export function accountColors(address) {
  const k = String(address || '').toLowerCase();
  if (!colorCache.has(k)) colorCache.set(k, colorsFrom(seeded(k)));
  return colorCache.get(k);
}

const lookCache = new Map();
/** The card's look for an address (cached: avatars draw the same rosettes, often many on one screen). */
export function cardLook(address) {
  const k = String(address || '').toLowerCase();
  if (!lookCache.has(k)) lookCache.set(k, makeLook(k));
  return lookCache.get(k);
}
function makeLook(address) {
  const rnd = seeded(address);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const { hue, hue2, l1, l2 } = colorsFrom(rnd);
  const [cx, cy, size] = pick([[255, 107, 120], [292, 52, 150], [170, 107, 128], [70, 176, 150], [262, 172, 140], [300, 107, 170]]);
  const [p, q] = pick(RATIOS);
  const layers = 3 + Math.floor(rnd() * 3);
  const d0 = (q / p) * (0.45 + rnd() * 0.5), dStep = (q / p) * (0.1 + rnd() * 0.14);
  const rot = rnd() * Math.PI * 2;
  const paths = [];
  for (let i = 0; i < layers; i++) paths.push(rosette({ p, q, d: d0 + i * dStep, cx, cy, size: size * (1 - i * 0.04), rot }));
  // a second, wider and fainter band with another ratio, turning the other way
  const [p2, q2] = pick(RATIOS);
  const band = rosette({ p: p2, q: q2, d: (q2 / p2) * (0.6 + rnd() * 0.5), cx, cy, size: size * (1.35 + rnd() * 0.35), rot: -rot, dir: -1 });
  return { hue, hue2, l1, l2, paths, band, cx, cy, size };
}

export function Guilloche({ seed, draw }) {
  const look = useMemo(() => cardLook(seed || 'chakra'), [seed]);
  return (
    <svg class={`guilloche ${draw ? 'draw' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path class="band" d={look.band} pathLength="1" />
      {look.paths.map((d) => <path d={d} pathLength="1" />)}
    </svg>
  );
}

/** The account's colours as CSS custom properties (card surface and avatar dot use the same ones). */
/**
 * A seal instead of the card's guilloche band (Contracts tab): concentric rosettes with a scalloped rim, like the
 * stamp on a deed, on the right side of the card and partly off it. Ratios vary with the address, like the card.
 */
export function sealLook(seed) {
  const rnd = seeded(`${seed || 'chakra'}:seal`);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cx = 266, cy = 107, rot = rnd() * Math.PI * 2;
  const rims = [rosette({ p: 48, q: 1, d: 0.016, cx, cy, size: 122, rot }), rosette({ p: 48, q: 1, d: 0.016, cx, cy, size: 116, rot: rot + Math.PI / 48 })];
  const [p1, q1] = pick(RATIOS), [p2, q2] = pick(RATIOS);
  const bands = [
    rosette({ p: p1, q: q1, d: (q1 / p1) * 1.15, cx, cy, size: 100, rot }),
    rosette({ p: p1, q: q1, d: (q1 / p1) * 1.3, cx, cy, size: 94, rot: rot + 0.08 }),
    rosette({ p: p2, q: q2, d: (q2 / p2) * 0.9, cx, cy, size: 70, rot: -rot, dir: -1 }),
  ];
  const core = [rosette({ p: 36, q: 1, d: 0.02, cx, cy, size: 48, rot }), rosette({ p: 7, q: 2, d: (2 / 7) * 1.4, cx, cy, size: 38, rot: -rot })];
  return { rims, bands, core };
}
export function Seal({ seed, draw }) {
  const look = useMemo(() => sealLook(seed), [seed]);
  return (
    <svg class={`guilloche seal ${draw ? 'draw' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {look.rims.map((d) => <path class="rim" d={d} pathLength="1" />)}
      {look.bands.map((d) => <path d={d} pathLength="1" />)}
      {look.core.map((d) => <path class="core" d={d} pathLength="1" />)}
    </svg>
  );
}
export function cardStyle(address) {
  const { hue, hue2, l1, l2 } = accountColors(address);
  return { '--h1': hue, '--h2': hue2, '--l1': `${l1}%`, '--l2': `${l2}%` };
}

// Animated number for the balance: counts up from 0 the first time a value arrives, then follows changes.
export function useCountUp(target, ms = 900) {
  const [v, setV] = useState(target);
  const from = useRef(null);
  useEffect(() => {
    if (target == null) return;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const start = from.current ?? 0;
    from.current = target;
    if (reduce || start === target) { setV(target); return; }
    let raf; const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(start + (target - start) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return target == null ? null : v;
}

export function SuccessMark() {
  return <div class="done-mark"><Icon name="check" size={34} stroke={2.4} /></div>;
}

/** The account's dot: its card in miniature - same colours and the same guilloche rosette, centred in the circle. */
export function Avatar({ address, lg }) {
  const look = cardLook(address || 'chakra');
  const r = look.size * 0.92;
  return (
    <div class={`avatar ${lg ? 'lg' : ''}`} style={cardStyle(address)}>
      <svg viewBox={`${look.cx - r} ${look.cy - r} ${r * 2} ${r * 2}`} aria-hidden="true">
        <path class="band" d={look.band} />
        {look.paths.map((d) => <path d={d} />)}
      </svg>
    </div>
  );
}

const COLORS = ['#5b4cf0', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
export function TokenIcon({ symbol = '?', icon, color, sm }) {
  const [err, setErr] = useState(false);
  const logo = symbolLogoId(symbol);
  if ((!icon || err) && logo) return <div class={`token-icon ${sm ? 'sm' : ''}`}><ChainLogo id={logo} size={sm ? 24 : 36} /></div>;
  const bg = color || COLORS[(symbol.charCodeAt(0) + (symbol.charCodeAt(1) || 0)) % COLORS.length];
  return (
    <div class={`token-icon ${sm ? 'sm' : ''}`} style={{ background: bg }}>
      {icon && !err ? <img src={icon} onError={() => setErr(true)} alt="" /> : symbol.slice(0, sm ? 2 : 3).toUpperCase()}
    </div>
  );
}

/** Network logo (falls back to a coloured circle with the short name). */
export function ChainIcon({ chain, size = 36 }) {
  if (chain && hasChainLogo(chain.id)) return <ChainLogo id={chain.id} size={size} />;
  return (
    <div class="token-icon" style={{ background: chain?.color || '#64748B', width: rem(size), height: rem(size), fontSize: rem(Math.max(8, size / 3)) }}>
      {(chain?.short || '?').slice(0, 3)}
    </div>
  );
}

/** Android: while mounted, blocks screenshots/screen recording (FLAG_SECURE). No-op in the extension. */
export function SecureScreen() {
  useEffect(() => {
    globalThis.__CK_NATIVE__?.setSecure({ on: true }).catch(() => {});
    return () => { globalThis.__CK_NATIVE__?.setSecure({ on: false }).catch(() => {}); };
  }, []);
  return null;
}

/** Android: while mounted, the screen stays on (FLAG_KEEP_SCREEN_ON). No-op in the extension. */
export function KeepAwake() {
  useEffect(() => {
    globalThis.__CK_SYSUI__?.setKeepAwake({ on: true }).catch(() => {});
    return () => { globalThis.__CK_SYSUI__?.setKeepAwake({ on: false }).catch(() => {}); };
  }, []);
  return null;
}

export function ExpandBtn() {
  const { mode } = useApp();
  if (mode !== 'popup') return null;
  return (
    <button class="iconbtn" title={t('common.openInTab')}
      onClick={() => { ext.tabs.create({ url: ext.runtime.getURL('popup.html#full') }); window.close(); }}>
      <Icon name="expand" />
    </button>
  );
}

export function TopBar({ title, onBack, right }) {
  const { back } = useApp();
  return (
    <div class="topbar">
      {onBack !== false && <button class="iconbtn" onClick={onBack || back} title={t('common.back')}><Icon name="back" /></button>}
      <h1>{title}</h1>
      {right}
      <ExpandBtn />
    </div>
  );
}

export function Spinner({ lg }) { return <span class={`spinner ${lg ? 'lg' : ''}`} />; }

export function Btn({ kind = 'primary', loading, children, class: cls = '', ...rest }) {
  return (
    <button class={`btn ${kind} ${cls}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Spinner /> : children}
    </button>
  );
}

// Bottom sheet: slides up, closes with an exit animation, can be dragged down by its grabber/header.
export function Sheet({ title, onClose, children }) {
  const [closing, setClosing] = useState(false);
  const sheet = useRef(null);
  const drag = useRef(null);
  const close = () => { if (closing) return; setClosing(true); setTimeout(onClose, 190); };
  const onDown = (e) => { drag.current = { y: e.clientY, dy: 0 }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    if (!drag.current) return;
    const dy = Math.max(0, e.clientY - drag.current.y);
    drag.current.dy = dy;
    sheet.current.style.transition = 'none';
    sheet.current.style.transform = `translateY(${dy}px)`;
  };
  const onUp = () => {
    if (!drag.current) return;
    const { dy } = drag.current; drag.current = null;
    const el = sheet.current;
    el.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
    if (dy > Math.min(140, el.offsetHeight * 0.3)) { el.style.transform = 'translateY(100%)'; setTimeout(onClose, 200); } else el.style.transform = '';
  };
  const handle = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, style: { touchAction: 'none' } };
  return (
    <div class={`overlay ${closing ? 'closing' : ''}`} onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="sheet" ref={sheet} role="dialog" aria-label={title}>
        <div class="grabber" {...handle} />
        <div class="row between" {...handle}><h3>{title}</h3><button class="iconbtn" onClick={close} onPointerDown={(e) => e.stopPropagation()} title={t('common.close')}><Icon name="close" /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Switch({ on, onChange }) {
  return <button class={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

export function QR({ text, size = 200 }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: size * 3, errorCorrectionLevel: 'M' }).then(setUrl).catch(() => setUrl(''));
  }, [text]);
  return <div class="qr">{url ? <img src={url} style={{ width: rem(size), height: rem(size) }} alt="QR" /> : <div style={{ width: rem(size), height: rem(size) }} />}</div>;
}

export function CopyBtn({ text, label }) {
  const { toast } = useApp();
  return (
    <button class={label ? 'btn secondary sm' : 'iconbtn'} title={t('common.copy')} onClick={async () => { await navigator.clipboard.writeText(text); toast(t('common.copied')); }}>
      <Icon name="copy" size={16} />{label}
    </button>
  );
}

/** Copies a recovery phrase (after it has been revealed), with a reminder to paste it only somewhere safe. */
export function CopyPhrase({ phrase }) {
  const { toast } = useApp();
  return (
    <button class="btn secondary sm copy-phrase" onClick={async () => { await navigator.clipboard.writeText(phrase); toast(t('seed.copied')); }}>
      <Icon name="copy" size={16} /> {t('seed.copyWords')}
    </button>
  );
}

export function AddressLabel({ address }) {
  const { state } = useApp();
  const acc = state?.accounts?.find((a) => a.address.toLowerCase() === String(address).toLowerCase());
  return <span title={address}>{acc ? acc.name : shortAddr(address)}</span>;
}

// ------------------------------------------------------------ fee display
/**
 * prepared: result of prepareTx; speed/setSpeed; extra rows: [{k, v, sub}]
 * value: native wei being sent (to compute total)
 */
export function FeeBox({ chain, prepared, speed, setSpeed, nativePrice, valueWei = 0n, extraRows = [], valueUsd = null }) {
  if (!prepared) {
    return <div class="fee-box"><div class="fee-row"><span class="k">{t('fee.network')}</span><span class="v"><Spinner /></span></div></div>;
  }
  const sym = chain.native.symbol, dec = chain.native.decimals;
  const s = prepared.speeds[speed];
  const est = BigInt(s.estCost), max = BigInt(s.maxCost);
  const usd = (w) => (nativePrice != null ? fmtUsd(toFloat(w, dec) * nativePrice) : '');
  const totalWei = est + BigInt(valueWei);
  const totalUsd = nativePrice != null ? toFloat(totalWei, dec) * nativePrice + (valueUsd || 0) : null;
  return (
    <div class="fee-box">
      <div class="speeds">
        {Object.keys(SPEEDS).map((k) => (
          <button class={`speed ${speed === k ? 'active' : ''}`} onClick={() => setSpeed(k)} title={t(SPEEDS[k].hint)}>
            {t(SPEEDS[k].label)}
            <span class="usd">{usd(BigInt(prepared.speeds[k].estCost)) || fmtAmount(prepared.speeds[k].estCost, dec, 6)}</span>
          </button>
        ))}
      </div>
      {extraRows.map((r) => (
        <div class="fee-row"><span class="k">{r.k}</span><span class="v">{r.v}{r.sub && <span class="sub">{r.sub}</span>}</span></div>
      ))}
      <div class="fee-row">
        <span class="k">{t('fee.estimated')}</span>
        <span class="v">{usd(est) || `${fmtAmount(est, dec, 8)} ${sym}`}<span class="sub">{fmtAmount(est, dec, 8)} {sym} · max {fmtAmount(max, dec, 8)}</span></span>
      </div>
      {BigInt(prepared.l1Fee || 0) > 0n && (
        <div class="fee-row"><span class="k tiny">{t('fee.l1')}</span><span class="v tiny">{fmtAmount(prepared.l1Fee, dec, 8)} {sym}</span></div>
      )}
      <div class="fee-row total">
        <span class="k bold" style={{ color: 'var(--text)' }}>{t('fee.total')}</span>
        <span class="v">
          {totalUsd != null ? fmtUsd(totalUsd) : `${fmtAmount(totalWei, dec, 8)} ${sym}`}
          <span class="sub">{t('fee.totalSub', { amount: `${fmtAmount(totalWei, dec, 8)} ${sym}`, plusToken: valueUsd ? t('fee.plusToken') : '' })}</span>
        </span>
      </div>
      {prepared.estimateError && <div class="warn small"><b>{t('common.attention')}</b> {t('fee.mayFail')} {prepared.estimateError}</div>}
    </div>
  );
}

/**
 * The network fee of a review, in the shape its chain driver gives (src/ui/chains/driver.d.md):
 *   { kind: 'market', prepared, valueWei(speed), valueUsd, extraRows } - a fee market with Slow / Normal / Fast (EVM)
 *   { kind: 'fixed', amount (raw | null), decimals, symbol, label?, unknownText?, extraRows } - one estimate (TON)
 *   { View, … } - drawn by the family's own component (Bitcoin: speeds in sat/vB, a rate of one's own)
 * fee null: still being prepared.
 */
export function FeeView({ chain, fee, speed, setSpeed, nativePrice }) {
  if (!fee) return <div class="fee-box"><div class="fee-row"><span class="k">{t('fee.network')}</span><span class="v"><Spinner /></span></div></div>;
  if (fee.View) return <fee.View chain={chain} fee={fee} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} />; // a family's own (Bitcoin: sat/vB)
  if (fee.kind === 'market') {
    return <FeeBox chain={chain} prepared={fee.prepared} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice}
      valueWei={fee.valueWei ? fee.valueWei(speed) : 0n} valueUsd={fee.valueUsd ?? null} extraRows={fee.extraRows || []} />;
  }
  const f = fee.amount != null ? toFloat(fee.amount, fee.decimals) : null;
  return (
    <div class="fee-box">
      {(fee.extraRows || []).map((r) => <div class="fee-row"><span class="k">{r.k}</span><span class="v">{r.v}{r.sub && <span class="sub">{r.sub}</span>}</span></div>)}
      <div class="fee-row">
        <span class="k">{fee.label || t('fee.estimated')}</span>
        <span class="v">{f != null ? `≈ ${fmtAmount(fee.amount, fee.decimals, 6)} ${fee.symbol}${nativePrice != null ? ` · ${fmtUsd(f * nativePrice)}` : ''}` : fee.unknownText || '—'}</span>
      </div>
    </div>
  );
}

/**
 * Translated text with inline markup, so word order can differ between languages:
 * <b>bold</b>, <m>bold monospace</m>, and {name} placeholders that may hold JSX (e.g. a bold amount).
 *   richText(t('swap.approveInfo', { provider }), { token: <b>{sym}</b> })     rich('browser.clearInfo', { host })
 */
export function richText(str, vars = {}) {
  const fill = (s) => s.split(/(\{\w+\})/).map((p) => { const m = /^\{(\w+)\}$/.exec(p); return m && m[1] in vars ? vars[m[1]] : p; });
  return String(str).split(/(<([bm])>.*?<\/\2>)/).filter((p, i) => i % 3 !== 2).map((p) => {
    const m = /^<([bm])>(.*)<\/\1>$/.exec(p);
    if (!m) return fill(p);
    return m[1] === 'm' ? <b class="mono">{fill(m[2])}</b> : <b>{fill(m[2])}</b>;
  });
}
export const rich = (key, vars) => richText(t(key), vars);

export function Empty({ children }) { return <div class="empty">{children}</div>; }

// networks whose explorer differs: explorerAddress (the path of an address, e.g. Solscan's "account"), explorerTxPath
// (of a transaction, e.g. Tronscan's "transaction"), explorerQuery (e.g. "?cluster=devnet")
export function explorerTx(chain, hash) { return chain.explorer ? `${chain.explorer}/${chain.explorerTxPath || 'tx'}/${hash}${chain.explorerQuery || ''}` : null; }
export function explorerAddr(chain, a) { return chain.explorer ? `${chain.explorer}/${chain.explorerAddress || 'address'}/${a}${chain.explorerQuery || ''}` : null; }
