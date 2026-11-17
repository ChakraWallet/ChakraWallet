// The guilloche of the app (account cards, icon): a hypotrochoid rosette as an SVG path, in a 1000-unit box centred
// on 0. Shared by the landing page (App.jsx) and the TON Connect page (tonconnect.js).
export function rosette(p, q, d, steps = 900) {
  const r = q / p, ext = 1 - r + d;
  let s = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * q;
    const x = ((1 - r) * Math.cos(t) + d * Math.cos(((1 - r) / r) * t)) / ext;
    const y = ((1 - r) * Math.sin(t) - d * Math.sin(((1 - r) / r) * t)) / ext;
    s += `${i ? 'L' : 'M'}${(x * 500).toFixed(1)},${(y * 500).toFixed(1)}`;
  }
  return s;
}
