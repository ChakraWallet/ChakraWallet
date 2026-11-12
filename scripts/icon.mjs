// App icon renderer (build time): Chakra's energy mandala on the security-ink blue, over a guilloche rosette in fine
// white lines. The mandala's geometry lives in src/shared/mandala.js (shared with the in-app SVG, the icon announced
// to sites and the notification icon). Returns straight (non-premultiplied) RGBA bytes.
//
// Layers can be rendered separately for Android adaptive icons:
//   'bg'      gradient surface            'rosette'  guilloche lines
//   'glyph'   the mandala
// The composition is designed in a unit box [0,1]²; `inset` shrinks that box inside the canvas (adaptive icons
// show only the central 72/108 of their 108dp canvas).
import { INK, MARK, inRing } from '../src/shared/mandala.js';

const INK_A = INK.a;   // top-left
const INK_B = INK.b;   // bottom-right

function rosettePoints(p, q, d, steps) {
  const R = 1, r = q / p, ext = R - r + d, pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * q;
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
    pts.push([x / ext, y / ext]); // normalised to radius 1
  }
  return pts;
}

function roundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// rounded square with continuous-ish corners, like launcher masks
const inMask = (mask, x, y) => (mask === 'circle' ? (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.25 : mask === 'rounded' ? roundRect(x, y, 0, 0, 1, 1, 0.225) : true);

const W = [255, 255, 255];
const SPARK_STEP = (2 * Math.PI) / MARK.sparks.n;
/**
 * Colour of the mandala at (u, v) in unit coordinates: [r, g, b, a] or null. lod 0 (tiny icons): bindu, medallion and
 * the inner lotus only; 1: + the outer lotus; 2: + the sparks.
 */
function markAt(u, v, lod) {
  const dx = u - 0.5, dy = v - 0.5, rr = dx * dx + dy * dy;
  if (rr <= MARK.bindu ** 2) return [...W, 1];
  if (rr <= (MARK.core - MARK.ring / 2) ** 2) return [...INK.medal, 1];
  if (rr <= (MARK.core + MARK.ring / 2) ** 2) return [...W, 1];
  if (inRing(MARK.inner, u, v)) return [...W, 1];
  if (lod > 0 && inRing(MARK.outer, u, v)) return [...INK.petal, MARK.outer.alpha];
  if (lod > 1) {
    const a = Math.atan2(dy, dx) + Math.PI / 2;
    const k = Math.round(a / SPARK_STEP);
    const sa = k * SPARK_STEP - Math.PI / 2;
    const sx = 0.5 + MARK.sparks.r * Math.cos(sa), sy = 0.5 + MARK.sparks.r * Math.sin(sa);
    if ((u - sx) ** 2 + (v - sy) ** 2 <= MARK.sparks.size ** 2) return [...W, 0.85];
  }
  return null;
}

export function renderIcon(width, height = width, { mask = 'rounded', layers = ['bg', 'rosette', 'glyph'], inset = 0, detail } = {}) {
  const size = Math.min(width, height);
  const box = size * (1 - 2 * inset);
  const ox = (width - box) / 2, oy = (height - box) / 2;
  const toU = (px) => (px - ox) / box, toV = (py) => (py - oy) / box;
  const lod = detail ?? (box >= 96 ? 2 : box >= 40 ? 1 : 0); // fewer rings when small
  const acc = new Float32Array(width * height * 4); // premultiplied
  const over = (i, r, g, b, a) => {
    const k = 1 - a;
    acc[i] = r / 255 * a + acc[i] * k; acc[i + 1] = g / 255 * a + acc[i + 1] * k;
    acc[i + 2] = b / 255 * a + acc[i + 2] * k; acc[i + 3] = a + acc[i + 3] * k;
  };
  const SS = 4;
  const maskCov = (px, py) => {
    if (mask === 'none') return 1;
    let c = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      if (inMask(mask, (px + (sx + 0.5) / SS) / width, (py + (sy + 0.5) / SS) / height)) c++;
    }
    return c / (SS * SS);
  };

  // ---- background gradient (with a soft light from the top-left)
  if (layers.includes('bg')) {
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      const cov = maskCov(px, py);
      if (!cov) continue;
      const x = px / width, y = py / height, t = Math.min(1, Math.max(0, (x + y) / 2));
      const glow = Math.max(0, 1 - Math.hypot(x - 0.25, y - 0.2) / 0.9) * 0.18;
      const c = INK_A.map((a, k) => a + (INK_B[k] - a) * t + 255 * glow * 0.35);
      over((py * width + px) * 4, Math.min(255, c[0]), Math.min(255, c[1]), Math.min(255, c[2]), cov);
    }
  }

  // ---- guilloche rosette: antialiased polylines, combined with max() per ring
  if (layers.includes('rosette') && lod > 0) {
    const rings = lod === 2
      ? [[13, 5, 0.62, 0.47, 0.36], [13, 5, 0.62, 0.55, 0.36], [13, 5, 0.62, 0.63, 0.36], [7, 2, 0.44, 0.7, 0.22]]
      : [[13, 5, 0.6, 0.55, 0.5], [7, 2, 0.44, 0.7, 0.3]];
    const hw = Math.max(0.55, box * 0.0032); // half line width (px)
    const cx = ox + box / 2, cy = oy + box / 2;
    const line = new Float32Array(width * height);
    for (const [p, q, rad, dk, alpha] of rings) {
      const pts = rosettePoints(p, q, (q / p) * dk * 1.6, 180 * q + 30 * p).map(([x, y]) => [cx + x * rad * box, cy + y * rad * box]);
      const ring = new Float32Array(width * height);
      for (let s = 1; s < pts.length; s++) {
        const [ax, ay] = pts[s - 1], [bx, by] = pts[s];
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - 1)), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + hw + 1));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by) - hw - 1)), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + hw + 1));
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const qx = x + 0.5 - ax, qy = y + 0.5 - ay;
          const t = Math.max(0, Math.min(1, (qx * vx + qy * vy) / l2));
          const d = Math.hypot(qx - t * vx, qy - t * vy);
          const c = Math.max(0, Math.min(1, hw + 0.5 - d));
          const i = y * width + x;
          if (c > ring[i]) ring[i] = c;
        }
      }
      for (let i = 0; i < ring.length; i++) if (ring[i]) line[i] = Math.min(1, line[i] + ring[i] * alpha);
    }
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      const i = py * width + px;
      if (!line[i]) continue;
      const cov = layers.includes('bg') ? maskCov(px, py) : 1;
      if (cov) over(i * 4, 255, 255, 255, line[i] * cov);
    }
  }

  // ---- the mandala (supersampled)
  if (layers.includes('glyph')) {
    const gx0 = Math.max(0, Math.floor(ox + box * 0.03)), gx1 = Math.min(width, Math.ceil(ox + box * 0.97));
    const gy0 = Math.max(0, Math.floor(oy + box * 0.03)), gy1 = Math.min(height, Math.ceil(oy + box * 0.97));
    for (let py = gy0; py < gy1; py++) for (let px = gx0; px < gx1; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = markAt(toU(px + (sx + 0.5) / SS), toV(py + (sy + 0.5) / SS), lod);
        if (!c) continue;
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
      }
      if (!a) continue;
      const n = SS * SS, cov = a / n;
      over((py * width + px) * 4, r / a, g / a, b / a, cov);
    }
  }

  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = acc[i * 4 + 3];
    if (!a) continue;
    out[i * 4] = Math.round(Math.min(1, acc[i * 4] / a) * 255);
    out[i * 4 + 1] = Math.round(Math.min(1, acc[i * 4 + 1] / a) * 255);
    out[i * 4 + 2] = Math.round(Math.min(1, acc[i * 4 + 2] / a) * 255);
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  return out;
}
