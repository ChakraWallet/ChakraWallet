// The QR scanner's field (scanner.jsx), inside the viewfinder: a grid of dots fixed to the frame, barely visible at
// rest; a beam sweeps down and lights the dots it crosses, which fade slowly, each in its own time; sparks leave the
// beam and some lit dots, drift up and fade. The beam: a line of light with a glow that breathes, and two sparkles
// at its ends.
// Cheap per frame: the resting grid is its own canvas, drawn once; everything that moves is copied from images made
// once (a glowing dot, the beam's strip) with only position, size and opacity changing - no colours built as text, no
// paths, no gradients per frame.

const PERIOD = 2200; // ms: sweep down (SWEEP), fade at the bottom, pause, again
const SWEEP = 1800;
const GAP = 9; // grid spacing, CSS px
const MAX_PARTICLES = 160;
const STRIP = 30; // the beam's strip: glow above the line, the line at the bottom (CSS px)
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2); // cubic in-out
const rand = (a, b) => a + Math.random() * (b - a);

function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }

/** A glowing dot (white core, blue halo), `px` device pixels wide. */
function dotSprite(px) {
  const c = canvasOf(px, px), x = c.getContext('2d'), m = px / 2;
  const g = x.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, 'rgba(240, 252, 255, 1)');
  g.addColorStop(0.28, 'rgba(185, 236, 255, .85)');
  g.addColorStop(0.6, 'rgba(120, 185, 255, .25)');
  g.addColorStop(1, 'rgba(110, 160, 255, 0)');
  x.fillStyle = g; x.fillRect(0, 0, px, px);
  return c;
}

/** The beam: a soft glow rising to a bright line at the bottom (width x STRIP CSS px, at `dpr`). */
function beamStrip(width, dpr) {
  const c = canvasOf(width * dpr, STRIP * dpr), x = c.getContext('2d');
  x.scale(dpr, dpr);
  const glow = x.createLinearGradient(0, 0, 0, STRIP);
  glow.addColorStop(0, 'rgba(110, 175, 255, 0)');
  glow.addColorStop(1, 'rgba(110, 175, 255, .24)');
  x.fillStyle = glow; x.fillRect(0, 0, width, STRIP);
  const across = (a) => {
    const g = x.createLinearGradient(0, 0, width, 0);
    g.addColorStop(0, 'rgba(110, 149, 255, 0)');
    g.addColorStop(0.12, `rgba(110, 149, 255, ${0.9 * a})`);
    g.addColorStop(0.5, `rgba(175, 240, 255, ${a})`);
    g.addColorStop(0.88, `rgba(110, 149, 255, ${0.9 * a})`);
    g.addColorStop(1, 'rgba(110, 149, 255, 0)');
    return g;
  };
  x.fillStyle = across(0.22); x.fillRect(width * 0.05, STRIP - 5, width * 0.9, 6); // soft band around the line
  x.fillStyle = across(1); x.fillRect(width * 0.04, STRIP - 3, width * 0.92, 2); // the line
  return c;
}

/**
 * Starts the field: `grid` gets the resting grid once, `canvas` the animation (both CSS width x height).
 * reduced: the grid only (prefers-reduced-motion). Returns { fadeOut() (the code was found: out in 0.3 s), stop() }.
 */
export function startScanField(canvas, grid, { width, height, reduced = false }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cols = Math.floor(width / GAP), rows = Math.floor(height / GAP);
  const ox = (width - (cols - 1) * GAP) / 2, oy = (height - (rows - 1) * GAP) / 2;

  // ---- the resting grid, drawn once on its own canvas
  grid.width = Math.round(width * dpr); grid.height = Math.round(height * dpr);
  const gx = grid.getContext('2d');
  gx.scale(dpr, dpr);
  gx.fillStyle = 'rgba(170, 228, 255, .11)';
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) gx.fillRect(ox + i * GAP - 0.7, oy + j * GAP - 0.7, 1.4, 1.4);
  if (reduced) return { fadeOut() {}, stop() {} };

  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const DOT = 10; // CSS px of the sprite at full size
  const dot = dotSprite(Math.ceil(DOT * dpr));
  const strip = beamStrip(width, dpr);

  const n = cols * rows;
  const light = new Float32Array(n); // 0..1
  const fade = new Float32Array(n); // per dot: how fast it goes out
  const particles = []; // { x, y, vx, vy, life, max, size }
  const spawn = (x, y, vy, life, size) => {
    if (particles.length < MAX_PARTICLES) particles.push({ x, y, vx: rand(-9, 9), vy, life, max: life, size });
  };
  let raf = 0, last = performance.now(), prevY = -1, cycle = -1, ending = 0;
  const t0 = last;

  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const out = ending ? Math.max(0, 1 - (now - ending) / 300) : 1; // the code was found: everything goes out
    if (ending && out === 0) { stop(); ctx.clearRect(0, 0, width, height); return; }

    // ---- the beam: where it is and how visible
    const t = now - t0, c = Math.floor(t / PERIOD), ph = t % PERIOD;
    if (c !== cycle) { cycle = c; prevY = -1; }
    const p = Math.min(1, ph / SWEEP);
    const y = ease(p) * height;
    const beam = ending || ph > SWEEP ? 0 : p < 0.1 ? p / 0.1 : p > 0.82 ? Math.max(0, (1 - p) / 0.18) : 1;

    // the dots the beam crossed since the last frame light up (not all of them, not all alike)
    if (beam > 0.05 && y > prevY) {
      const j0 = Math.max(0, Math.ceil((prevY - oy) / GAP)), j1 = Math.min(rows - 1, Math.floor((y - oy) / GAP));
      for (let j = j0; j <= j1; j++) {
        for (let i = 0; i < cols; i++) {
          if (Math.random() < 0.14) continue;
          const k = j * cols + i;
          light[k] = Math.max(light[k], rand(0.55, 1) * beam);
          fade[k] = rand(0.7, 1.5);
          if (Math.random() < 0.05) spawn(ox + i * GAP, oy + j * GAP, rand(-30, -8), rand(0.7, 1.5), rand(0.9, 1.6));
        }
      }
    }
    prevY = y;
    if (beam > 0.2) { // sparks off the line: about 35 a second at full beam
      const expected = 35 * dt * beam;
      const count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
      for (let s = 0; s < count; s++) spawn(rand(width * 0.08, width * 0.92), y, rand(-60, -15), rand(0.4, 0.9), rand(1, 2.2));
    }

    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    // ---- lit dots, going out
    for (let k = 0; k < n; k++) {
      let l = light[k];
      if (l <= 0.02) continue;
      l = Math.max(0, l - dt * fade[k] * (0.35 + l));
      light[k] = l;
      const s = DOT * (0.25 + 0.75 * l);
      ctx.globalAlpha = l * out;
      ctx.drawImage(dot, ox + (k % cols) * GAP - s / 2, oy + ((k / cols) | 0) * GAP - s / 2, s, s);
    }

    // ---- particles (removed by swapping with the last: no shifting)
    for (let q = particles.length - 1; q >= 0; q--) {
      const a = particles[q];
      a.life -= dt;
      if (a.life <= 0) { particles[q] = particles[particles.length - 1]; particles.pop(); continue; }
      a.x += a.vx * dt; a.y += a.vy * dt; a.vx *= 1 - 0.8 * dt;
      const f = a.life / a.max;
      const s = a.size * 2.4 * (0.35 + 0.65 * f);
      ctx.globalAlpha = f * 0.9 * out;
      ctx.drawImage(dot, a.x - s / 2, a.y - s / 2, s, s);
    }

    // ---- the beam: its strip (glow + line), breathing, and the sparkles at its ends
    if (beam > 0.01) {
      const pulse = 0.85 + 0.15 * Math.sin((t / 1000) * Math.PI * 2 * 1.6);
      ctx.globalAlpha = beam * pulse;
      ctx.drawImage(strip, 0, y - STRIP + 2, width, STRIP);
      for (const [ex, phase] of [[width * 0.09, 0], [width * 0.91, 1.7]]) {
        ctx.globalAlpha = (0.6 + 0.4 * Math.sin(t / 60 + phase)) * beam;
        ctx.drawImage(dot, ex - 7, y - 7, 14, 14);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };
  raf = requestAnimationFrame(frame);

  function stop() { cancelAnimationFrame(raf); raf = 0; }
  return {
    fadeOut() { if (!ending) ending = performance.now(); },
    stop,
  };
}
