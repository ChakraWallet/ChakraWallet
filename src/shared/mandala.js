// Chakra's mark: an energy mandala on the security-ink blue - a bindu in a medallion, a solid inner lotus of 8 petals,
// a translucent outer lotus of 16, a halo of sparks. One geometry for every place the mark appears: the PNG icons
// (scripts/icon.mjs: Android launcher, splash, extension), the in-app SVG, the icon announced to sites, and the
// notification silhouette. Unit coordinates: centre (0.5, 0.5), sizes as fractions of the icon's side.

export const INK = { a: [36, 92, 238], b: [13, 40, 140], medal: [15, 46, 158], petal: [196, 214, 255] };

const UP = -Math.PI / 2;
export const MARK = {
  // 8-fold symmetry: the outer lotus has 16 petals, every other one behind an inner petal, the rest in the gaps
  outer: { n: 16, r0: 0.16, r1: 0.4, w: 0.052, rot: UP, alpha: 0.5 },
  inner: { n: 8, r0: 0.08, r1: 0.3, w: 0.07, rot: UP }, // one petal straight up
  core: 0.112, // medallion
  ring: 0.013, // white ring around it
  bindu: 0.046,
  sparks: { n: 32, r: 0.445, size: 0.0105 },
};

// Notification icon (a white silhouette tinted by Android): fewer, bolder shapes, all apart from each other.
export const NOTIF = { // within the 22dp live area of the 24dp icon
  bindu: 0.09,
  petals: { n: 8, r0: 0.175, r1: 0.37, w: 0.075, rot: UP },
  ring: [0.415, 0.455],
};

/** Half width of a petal at t in [0, 1] from base to tip: pointed at both ends, fullest a little past the middle. */
const halfWidth = (w, t) => (t <= 0 || t >= 1 ? 0 : w * Math.sin(Math.PI * t ** 0.85) ** 0.8);

/** Is (u, v) inside petal k of a ring? */
export function inPetal(spec, k, u, v) {
  const a = spec.rot + (k * 2 * Math.PI) / spec.n;
  const dx = u - 0.5, dy = v - 0.5;
  const along = dx * Math.cos(a) + dy * Math.sin(a), across = -dx * Math.sin(a) + dy * Math.cos(a);
  const t = (along - spec.r0) / (spec.r1 - spec.r0);
  return Math.abs(across) <= halfWidth(spec.w, t);
}
/** Is (u, v) inside any petal of a ring? Only the two petals nearest by angle can contain it. */
export function inRing(spec, u, v) {
  const step = (2 * Math.PI) / spec.n;
  const k = Math.floor((Math.atan2(v - 0.5, u - 0.5) - spec.rot) / step);
  return inPetal(spec, ((k % spec.n) + spec.n) % spec.n, u, v) || inPetal(spec, (((k + 1) % spec.n) + spec.n) % spec.n, u, v);
}

/** Outline of petal k as points [x, y] in a box of side `s` (for SVG / vector paths). */
export function petalPoints(spec, k, s = 100, steps = 18) {
  const a = spec.rot + (k * 2 * Math.PI) / spec.n;
  const ca = Math.cos(a), sa = Math.sin(a);
  const pt = (t, side) => {
    const along = spec.r0 + (spec.r1 - spec.r0) * t, across = side * halfWidth(spec.w, t);
    return [(0.5 + along * ca - across * sa) * s, (0.5 + along * sa + across * ca) * s];
  };
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(pt(i / steps, 1));
  for (let i = steps - 1; i > 0; i--) pts.push(pt(i / steps, -1));
  return pts;
}
const f = (n) => Number(n.toFixed(2));
export const petalPath = (spec, k, s = 100) => `M${petalPoints(spec, k, s).map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
export const ringPaths = (spec, s = 100) => Array.from({ length: spec.n }, (_, k) => petalPath(spec, k, s));
export const sparkPoints = (s = 100) => Array.from({ length: MARK.sparks.n }, (_, k) => {
  const a = UP + (k * 2 * Math.PI) / MARK.sparks.n;
  return [f((0.5 + MARK.sparks.r * Math.cos(a)) * s), f((0.5 + MARK.sparks.r * Math.sin(a)) * s)];
});

/** The whole mark as an SVG document (rounded square, 100 x 100) - e.g. the icon announced to sites. */
export function markSvg() {
  const c = (x) => `rgb(${x.join(',')})`;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c(INK.a)}"/><stop offset="1" stop-color="${c(INK.b)}"/></linearGradient></defs>`
    + '<rect width="100" height="100" rx="22.5" fill="url(#g)"/>'
    + sparkPoints().map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${MARK.sparks.size * 100}" fill="#fff" opacity=".85"/>`).join('')
    + ringPaths(MARK.outer).map((d) => `<path d="${d}" fill="${c(INK.petal)}" opacity="${MARK.outer.alpha}"/>`).join('')
    + ringPaths(MARK.inner).map((d) => `<path d="${d}" fill="#fff"/>`).join('')
    + `<circle cx="50" cy="50" r="${MARK.core * 100}" fill="${c(INK.medal)}" stroke="#fff" stroke-width="${MARK.ring * 100}"/>`
    + `<circle cx="50" cy="50" r="${MARK.bindu * 100}" fill="#fff"/>`
    + '</svg>';
}

/** Notification icon as an Android vector drawable (24dp, white; Android tints it). */
export function notificationVector() {
  const S = 24, c = 12;
  const circle = (r) => `M${f(c - r)},${c}a${f(r)},${f(r)} 0,1 1,${f(2 * r)},0a${f(r)},${f(r)} 0,1 1,${f(-2 * r)},0z`;
  const petals = Array.from({ length: NOTIF.petals.n }, (_, k) => `M${petalPoints(NOTIF.petals, k, S, 10).map(([x, y]) => `${f(x)},${f(y)}`).join('L')}Z`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Notification icon: Chakra's mandala as a white silhouette (Android tints it). Generated by build.mjs from
     src/shared/mandala.js - edit the geometry there, not here. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"
        android:pathData="${circle(NOTIF.ring[1] * S)}${circle(NOTIF.ring[0] * S)}" />
    <path android:fillColor="#FFFFFFFF" android:pathData="${petals}" />
    <path android:fillColor="#FFFFFFFF" android:pathData="${circle(NOTIF.bindu * S)}" />
</vector>
`;
}
